// SSAFY 출석 체크 알리미 - 백그라운드 서비스 워커
// 사용자에게 실제로 알림이 가는 경우는 딱 3가지뿐이다.
//  1) 평일 08:50 - 입실 10분 전 리마인더
//  2) 평일 17:50 - 퇴실 10분 전 리마인더
//  3) 새 GitHub Release가 발행됐을 때 - 그 릴리즈 노트를 그대로 알림으로 전달
//     (버전 숫자 비교가 아니라 "새 Release가 올라왔는지"로 판단)
// 릴리즈 확인 자체는 평일 08:45~18:00 사이 15분 간격으로 조용히 수행하고,
// 새 릴리즈가 있을 때만(3번) 알림을 띄운다.

const REPO = "park-rudxo/ssafy-check";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const SSAFY_HOME = "https://edu.ssafy.com/edu/main/index.do";
const UPDATE_ALARM = "ssafy-update-check";
const UPDATE_NOTI_ID = "ssafy-update";

// 입실/퇴실 N분 전에 SSAFY 홈을 자동으로 여는 알람
const OPEN_CHECKIN_ALARM = "ssafy-open-checkin";
const OPEN_CHECKOUT_ALARM = "ssafy-open-checkout";
const CHECK_IN_MIN = 9 * 60; // 09:00
const CHECK_OUT_MIN = 18 * 60; // 18:00
const DEFAULT_AUTO_OPEN = { enabled: true, minutesBefore: 5 };

const REMINDERS = [
  { name: "ssafy-checkin", hour: 8, minute: 50, title: "SSAFY 입실 체크!", message: "09:00 전에 입실 체크하세요. (10분 남음)" },
  { name: "ssafy-checkout", hour: 17, minute: 50, title: "SSAFY 퇴실 체크!", message: "18:00 10분 전이에요! 정리하고 퇴실 준비하세요." },
];

function nextOccurrence(hour, minute) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function nextOccurrenceFromMinutes(totalMin) {
  return nextOccurrence(Math.floor(totalMin / 60), totalMin % 60);
}

// 지금부터 intervalMinutes 단위의 다음 경계 시각(예: 15분이면 매시 00/15/30/45분)을 반환한다.
// nextOccurrence(8,45)처럼 특정 시각에 고정 앵커를 두면, 그 시각이 이미 지난 뒤에
// (예: 오전 8:45 이후 확장을 새로고침) 알람이 "내일" 그 시각까지 통째로 밀려버리는
// 문제가 있었다. 이 방식은 언제 예약하든 항상 몇 분 안에 첫 알람이 온다.
function nextIntervalBoundary(intervalMinutes) {
  const ms = intervalMinutes * 60 * 1000;
  return Math.ceil((Date.now() + 1000) / ms) * ms;
}

// 릴리즈 확인을 실제로 수행할 시간대: 평일 08:45~18:00
const UPDATE_CHECK_START_MIN = 8 * 60 + 45;
const UPDATE_CHECK_END_MIN = 18 * 60;

function isWithinCheckWindow() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const totalMin = now.getHours() * 60 + now.getMinutes();
  return totalMin >= UPDATE_CHECK_START_MIN && totalMin <= UPDATE_CHECK_END_MIN;
}

function scheduleAll() {
  for (const r of REMINDERS) {
    chrome.alarms.create(r.name, {
      when: nextOccurrence(r.hour, r.minute),
      periodInMinutes: 24 * 60,
    });
  }
  // 15분마다 알람이 울린다(예약 시점과 무관하게 몇 분 안에 첫 알람이 옴).
  // 실제 확인은 isWithinCheckWindow()로 평일 08:45~18:00 사이에만 조용히
  // 수행하고, 그 밖의 시간엔 알람만 울리고 건너뛴다.
  chrome.alarms.create(UPDATE_ALARM, { when: nextIntervalBoundary(15), periodInMinutes: 15 });
  scheduleAutoOpen();
  scheduleMattermostWarnings();
}

// ── 입실/퇴실 N분 전 자동 열기 ────────────────────────────────────────
async function getAutoOpen() {
  const { autoOpen } = await chrome.storage.local.get("autoOpen");
  const s = { ...DEFAULT_AUTO_OPEN, ...(autoOpen || {}) };
  // 0~120분 범위로 보정
  s.minutesBefore = Math.max(0, Math.min(120, parseInt(s.minutesBefore, 10) || 0));
  return s;
}

async function scheduleAutoOpen() {
  await chrome.alarms.clear(OPEN_CHECKIN_ALARM);
  await chrome.alarms.clear(OPEN_CHECKOUT_ALARM);
  const s = await getAutoOpen();
  if (!s.enabled) return;
  const n = s.minutesBefore;
  chrome.alarms.create(OPEN_CHECKIN_ALARM, {
    when: nextOccurrenceFromMinutes(CHECK_IN_MIN - n),
    periodInMinutes: 24 * 60,
  });
  chrome.alarms.create(OPEN_CHECKOUT_ALARM, {
    when: nextOccurrenceFromMinutes(CHECK_OUT_MIN - n),
    periodInMinutes: 24 * 60,
  });
}

// 설정(autoOpen)이 바뀌면 자동 열기 알람을 다시 예약한다.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.autoOpen) scheduleAutoOpen();
});

// ── Mattermost 연동 ───────────────────────────────────────────────────
// 크롬 알림은 자리를 비우거나 크롬을 닫으면 못 보지만, Mattermost로 보내면
// 폰 앱으로 푸시가 오기 때문에 "18시 넘었는데 퇴실 안 함"을 놓치기 어렵다.
// Incoming Webhook(토큰/봇 계정 불필요)에 JSON을 POST하는 방식만 쓴다.
const MM_DEFAULTS = {
  enabled: false,
  webhookUrl: "",
  channel: "", // 비우면 Webhook에 설정된 채널. "@아이디"면 개인 메시지(DM)
  notifyCheckin: true,
  notifyCheckout: true,
  notifyMissing: true,
};

// 미체크 경고를 보낼 시각들. 한 번 보내고 끝내면 놓치기 쉬워서, 아직
// 체크되지 않은 동안 점점 촘촘하게 여러 번 보낸다.
const MM_WARN_CHECKIN_MINS = [8 * 60 + 50, 8 * 60 + 55, 8 * 60 + 58];
const MM_WARN_CHECKOUT_MINS = [18 * 60, 18 * 60 + 5, 18 * 60 + 15, 18 * 60 + 30];
const MM_WARN_PREFIX = "ssafy-mm-warn-";

async function getMattermost() {
  const { mattermost } = await chrome.storage.local.get("mattermost");
  return { ...MM_DEFAULTS, ...(mattermost || {}) };
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hhmm(totalMin) {
  return `${String(Math.floor(totalMin / 60)).padStart(2, "0")}:${String(totalMin % 60).padStart(2, "0")}`;
}

// Incoming Webhook으로 메시지 1건 전송. 일시적인 네트워크 오류를 감안해 1회 재시도.
async function postToMattermost(text, cfg) {
  const s = cfg || (await getMattermost());
  if (!s.webhookUrl) return { ok: false, error: "Webhook URL이 설정되지 않았어요." };

  // channel을 넣으면 Webhook의 기본 채널 대신 이쪽으로 간다.
  // "@아이디"는 개인 메시지(DM)가 되고, DM은 Mattermost 기본 설정에서
  // 폰 푸시가 오기 때문에 혼자 쓰는 알림용으로는 이게 가장 확실하다.
  // 단, Webhook을 만들 때 "이 채널로 잠금"을 켜두면 서버가 이 값을 무시한다.
  const payload = { text };
  if (s.channel) payload.channel = s.channel;

  let lastErr = "알 수 없는 오류";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(s.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return { ok: true };
      // 4xx는 재시도해도 같은 결과라 바로 포기한다 (URL 오타 등).
      lastErr = `Mattermost 응답 오류 (${res.status})`;
      if (res.status >= 400 && res.status < 500) break;
    } catch (e) {
      // host_permissions가 없으면 여기서 CORS 오류로 떨어진다.
      lastErr = String(e && e.message ? e.message : e);
    }
  }
  return { ok: false, error: lastErr };
}

// ── 오늘의 출석 상태 (content.js가 알려준 클릭 기록) ────────────────────
// content.js는 페이지의 localStorage에 기록하는데 서비스 워커는 그걸 읽을 수
// 없어서, 같은 내용을 chrome.storage.local에도 저장해 백그라운드가 "아직 안
// 눌렀는지"를 판단할 수 있게 한다.
const ATTENDANCE_DEFAULT = { date: "", checkinMin: null, checkoutMin: null, observedCheckedIn: false };

async function getAttendance() {
  const { attendance } = await chrome.storage.local.get("attendance");
  const a = { ...ATTENDANCE_DEFAULT, ...(attendance || {}) };
  // 날짜가 바뀌었으면 어제 기록은 무시한다.
  if (a.date !== todayStr()) return { ...ATTENDANCE_DEFAULT, date: todayStr() };
  return a;
}

// 같은 날 같은 알림을 중복 전송하지 않도록 기록한다.
// (SSAFY 탭을 여러 개 열어두면 클릭 보고가 여러 번 올 수 있다)
async function markSentOnce(key) {
  const today = todayStr();
  const { mmSent } = await chrome.storage.local.get("mmSent");
  const s = mmSent && mmSent.date === today ? mmSent : { date: today, keys: [] };
  if (s.keys.includes(key)) return false; // 이미 보냄
  s.keys.push(key);
  await chrome.storage.local.set({ mmSent: s });
  return true;
}

async function handleAttendanceRecorded(msg) {
  const kind = msg.kind === "checkin" ? "checkin" : "checkout";
  const minutes = Number(msg.minutes);
  if (!Number.isFinite(minutes)) return { ok: false };

  const a = await getAttendance();
  a.date = todayStr();
  if (kind === "checkin") {
    if (a.checkinMin == null) a.checkinMin = minutes;
  } else {
    // 퇴실은 18시 이후 기록이 있어야 인정되므로 가장 늦은 클릭을 남긴다.
    if (a.checkoutMin == null || minutes > a.checkoutMin) a.checkoutMin = minutes;
  }
  await chrome.storage.local.set({ attendance: a });

  const s = await getMattermost();
  if (!s.enabled || !s.webhookUrl) return { ok: true };
  if (kind === "checkin" && !s.notifyCheckin) return { ok: true };
  if (kind === "checkout" && !s.notifyCheckout) return { ok: true };
  // 18시 이전 퇴실 클릭은 아직 정상 퇴실이 아니라 "완료"로 알리지 않는다.
  if (kind === "checkout" && minutes < CHECK_OUT_MIN) return { ok: true };
  if (!(await markSentOnce(`click-${kind}`))) return { ok: true };

  const text =
    kind === "checkin"
      ? `✅ **입실 체크 완료** (${hhmm(minutes)})`
      : `✅ **퇴실 체크 완료** (${hhmm(minutes)})`;
  await postToMattermost(text, s);
  return { ok: true };
}

// content.js가 페이지에서 읽어낸 입실 완료 상태를 반영한다.
async function handleAttendanceObserved(msg) {
  if (msg.checkedIn !== true) return { ok: true };
  const a = await getAttendance();
  if (a.observedCheckedIn) return { ok: true };
  a.date = todayStr();
  a.observedCheckedIn = true;
  await chrome.storage.local.set({ attendance: a });
  return { ok: true };
}

// 미체크 경고는 일부러 매번 보낸다(점점 촘촘해지는 리마인더라 중복이 아님).
async function handleMattermostWarning(totalMin) {
  const day = new Date().getDay();
  if (day === 0 || day === 6) return;

  const s = await getMattermost();
  if (!s.enabled || !s.webhookUrl || !s.notifyMissing) return;

  const a = await getAttendance();
  if (MM_WARN_CHECKIN_MINS.includes(totalMin)) {
    // 클릭 기록이 없어도 페이지에서 "정상 출석"이 확인됐으면 입실한 것이다.
    if (a.checkinMin != null || a.observedCheckedIn) return;
    const left = CHECK_IN_MIN - totalMin;
    await postToMattermost(`🚨 **아직 입실 체크를 안 했어요!** 09:00까지 ${left}분 남았습니다.\n${SSAFY_HOME}`, s);
    return;
  }

  if (a.checkoutMin != null && a.checkoutMin >= CHECK_OUT_MIN) return; // 이미 정상 퇴실
  const late = totalMin - CHECK_OUT_MIN;
  const when = late === 0 ? "방금 18:00이 됐어요." : `18:00에서 ${late}분 지났어요.`;
  await postToMattermost(
    `🚨 **아직 퇴실 체크를 안 했어요!** ${when} 지금 누르지 않으면 조퇴 처리될 수 있어요.\n${SSAFY_HOME}`,
    s
  );
}

function scheduleMattermostWarnings() {
  // 설정이 꺼져 있어도 알람 자체는 예약해두고, 발송 시점에 설정을 확인한다.
  // (설정을 켜자마자 재예약할 필요가 없어 단순하다)
  for (const min of [...MM_WARN_CHECKIN_MINS, ...MM_WARN_CHECKOUT_MINS]) {
    chrome.alarms.create(MM_WARN_PREFIX + min, {
      when: nextOccurrenceFromMinutes(min),
      periodInMinutes: 24 * 60,
    });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  scheduleAll();
  // 설치/업데이트 직후에는 "현재 최신 Release"를 이미 본 것으로 기준을 잡아
  // 방금 설치한 사용자에게 곧바로 알림이 뜨지 않도록 한다.
  await setBaselineIfNeeded();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAll();
  if (isWithinCheckWindow()) checkAnnouncement(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) {
    if (isWithinCheckWindow()) checkAnnouncement(false);
    return;
  }

  // 입실/퇴실 미체크 경고를 Mattermost로 전송
  if (alarm.name.startsWith(MM_WARN_PREFIX)) {
    handleMattermostWarning(parseInt(alarm.name.slice(MM_WARN_PREFIX.length), 10));
    return;
  }

  // 입실/퇴실 N분 전 → SSAFY 홈 자동 열기 (평일만)
  if (alarm.name === OPEN_CHECKIN_ALARM || alarm.name === OPEN_CHECKOUT_ALARM) {
    const day = new Date().getDay();
    if (day === 0 || day === 6) return;
    chrome.tabs.create({ url: SSAFY_HOME });
    return;
  }

  const reminder = REMINDERS.find((r) => r.name === alarm.name);
  if (!reminder) return;

  // 주말에는 리마인더 알림을 보내지 않는다.
  const day = new Date().getDay();
  if (day === 0 || day === 6) return;

  chrome.notifications.create(reminder.name + "-" + Date.now(), {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: reminder.title,
    message: reminder.message,
    priority: 2,
    requireInteraction: true,
  });
});

// 알림 클릭 처리: 공지 알림이면 릴리스 페이지, 그 외엔 출석 페이지
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId === UPDATE_NOTI_ID) {
    const { latestReleaseUrl } = await chrome.storage.local.get("latestReleaseUrl");
    chrome.tabs.create({ url: latestReleaseUrl || RELEASES_PAGE });
  } else {
    chrome.tabs.create({ url: "https://edu.ssafy.com/edu/main/index.do" });
  }
  chrome.notifications.clear(notificationId);
});

// ── GitHub Release 공지 확인 ──────────────────────────────────────────
function truncate(str, n) {
  const s = String(str || "").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// 최신 Release 정보를 가져온다. 발행된 Release가 없으면 { none: true }.
async function fetchLatestRelease() {
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (res.status === 404) return { none: true }; // 아직 발행된 Release 없음
    if (!res.ok) return { error: `GitHub 응답 오류 (${res.status})` };
    const d = await res.json();
    return {
      id: d.id,
      tag: d.tag_name || "",
      name: d.name || d.tag_name || "새 업데이트",
      body: d.body || "",
      url: d.html_url || RELEASES_PAGE,
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

// 설치 직후 기준선 설정: 아직 본 Release 기록이 없으면 현재 최신을 본 것으로 저장
// (단, 발행된 Release가 아예 없으면 기록하지 않아, 첫 Release 때 알림이 가게 한다.)
async function setBaselineIfNeeded() {
  const { lastSeenReleaseId } = await chrome.storage.local.get("lastSeenReleaseId");
  if (lastSeenReleaseId !== undefined) return;
  const rel = await fetchLatestRelease();
  if (rel && rel.id) {
    await chrome.storage.local.set({ lastSeenReleaseId: rel.id, latestReleaseUrl: rel.url });
  }
}

// manual=false(자동, 알람에 의한 확인): 새 공지면 크롬 알림을 띄우고 '알림을
//   보낸 것'으로 기록한다. 이 기록만이 실제 알림 발송 여부를 결정한다.
// manual=true(팝업의 '업데이트 확인' 버튼): 알림 없이 최신 공지 내용을 화면에
//   보여주기만 하고, '본 것'으로 기록하지 않는다. (기록해버리면 이후 자동
//   확인이 "이미 알림 보냈다"고 착각해 정작 크롬 알림이 영영 안 뜨는
//   버그가 있었음 - 수동으로 미리보기만 한 사용자도 나중에 알림을 받아야 함)
async function checkAnnouncement(manual) {
  const rel = await fetchLatestRelease();
  if (rel.none) return { ok: true, none: true };
  if (rel.error) return { ok: false, error: rel.error };

  await chrome.storage.local.set({ latestReleaseUrl: rel.url });
  const { lastSeenReleaseId } = await chrome.storage.local.get("lastSeenReleaseId");
  const isNew = lastSeenReleaseId !== rel.id;

  if (isNew && !manual) {
    const pullHint = "▶ git pull 후 확장 새로고침(🔄) 하세요";
    const notes = truncate(rel.body, 160);
    chrome.notifications.create(UPDATE_NOTI_ID, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `📢 ${rel.name}`,
      message: notes ? `${notes}\n\n${pullHint}` : `새 버전이 배포됐어요!\n${pullHint}`,
      priority: 2,
      requireInteraction: true,
    });
    // 실제로 알림을 보낸 경우에만 '본 것'으로 기록한다.
    await chrome.storage.local.set({ lastSeenReleaseId: rel.id });
  }

  return { ok: true, none: false, isNew, name: rel.name, tag: rel.tag, body: rel.body, url: rel.url };
}

// 팝업/콘텐츠 스크립트 요청 처리
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "checkUpdate") {
    checkAnnouncement(true).then(sendResponse);
    return true; // 비동기 응답
  }
  // content.js가 입실/퇴실 버튼 클릭을 알려온 경우
  if (msg && msg.type === "attendanceRecorded") {
    handleAttendanceRecorded(msg).then(sendResponse);
    return true;
  }
  // content.js가 페이지에서 입실 완료를 확인한 경우
  if (msg && msg.type === "attendanceObserved") {
    handleAttendanceObserved(msg).then(sendResponse);
    return true;
  }
  // 팝업의 "테스트 메시지 보내기" 버튼
  if (msg && msg.type === "mattermostTest") {
    postToMattermost("✅ SSAFY 출석 체크 알리미 연결 테스트입니다.").then(sendResponse);
    return true;
  }
});
