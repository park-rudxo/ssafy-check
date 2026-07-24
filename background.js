// SSAFY 출석 체크 알리미 - 백그라운드 서비스 워커
//  1) 평일 08:50(입실), 18:00(퇴실) 리마인더 알림
//  2) GitHub Release '공지' 전달: 관리자가 Release를 발행(=배포)하면서 쓴
//     릴리즈 노트가, 사용자에게 크롬 알림으로 그대로 전달된다.
//     (버전 숫자 비교가 아니라, "새 Release가 올라왔는지"로 판단)

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
  { name: "ssafy-checkout", hour: 18, minute: 0, title: "SSAFY 퇴실 체크!", message: "18시가 지났습니다. 퇴실 버튼을 누르세요." },
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

function scheduleAll() {
  for (const r of REMINDERS) {
    chrome.alarms.create(r.name, {
      when: nextOccurrence(r.hour, r.minute),
      periodInMinutes: 24 * 60,
    });
  }
  // 6시간마다 새 공지(Release) 확인
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
  scheduleAutoOpen();
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

chrome.runtime.onInstalled.addListener(async () => {
  scheduleAll();
  // 설치/업데이트 직후에는 "현재 최신 Release"를 이미 본 것으로 기준을 잡아
  // 방금 설치한 사용자에게 곧바로 알림이 뜨지 않도록 한다.
  await setBaselineIfNeeded();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAll();
  checkAnnouncement(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) {
    checkAnnouncement(false);
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

// manual=false(자동): 새 공지면 크롬 알림을 띄우고 '본 것'으로 기록.
// manual=true(팝업 버튼): 알림 없이 최신 공지 내용을 반환하고 '본 것'으로 기록.
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
  }

  // 자동이든 수동이든, 확인했으면 최신을 본 것으로 기록한다.
  await chrome.storage.local.set({ lastSeenReleaseId: rel.id });

  return { ok: true, none: false, isNew, name: rel.name, tag: rel.tag, body: rel.body, url: rel.url };
}

// 팝업의 "업데이트 확인" 버튼 요청 처리
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "checkUpdate") {
    checkAnnouncement(true).then(sendResponse);
    return true; // 비동기 응답
  }
});
