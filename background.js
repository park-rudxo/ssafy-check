// SSAFY 출석 체크 알리미 - 백그라운드 서비스 워커
// 사용자에게 실제로 알림이 가는 경우는 딱 3가지뿐이다.
//  1) 평일 08:50 - 입실 10분 전 리마인더
//  2) 평일 17:50 - 퇴실 10분 전 리마인더
//  3) 새 GitHub Release가 발행됐을 때 - 그 릴리즈 노트를 그대로 알림으로 전달
//     (버전 숫자 비교가 아니라 "새 Release가 올라왔는지"로 판단)
// 릴리즈 확인 자체는 평일 08:45~18:00 사이 15분 간격으로 조용히 수행하고,
// 새 릴리즈가 있을 때만(3번) 알림을 띄운다.

// 배포 대상(unpacked / webstore)을 읽는다. 읽지 못하면 기존 동작인 unpacked로
// 둔다 - 업데이트 확인이 도는 쪽이라, 잘못돼도 기능이 사라지지는 않는다.
try {
  importScripts("build-target.js");
} catch (e) {
  self.BUILD_TARGET = "unpacked";
}
const IS_WEBSTORE = self.BUILD_TARGET === "webstore";

// 진단 로그. 없어도 기능은 다 돌아가야 하므로 조용한 no-op 으로 물러난다.
try {
  importScripts("debug.js");
} catch (e) {
  self.SsafyDebug = { log() {}, read: () => Promise.resolve([]), clear: () => Promise.resolve() };
}

// 공휴일 판정은 content.js/popup.js와 같은 규칙을 써야 하므로 공용 모듈을 불러온다.
// 파일이 없으면 importScripts가 서비스워커를 통째로 죽이므로, 그 경우엔
// 예전 동작(주말만 제외)으로 물러나 알림 기능 자체는 살려 둔다.
try {
  importScripts("holidays.js");
} catch (e) {
  self.SsafyHolidays = {
    dayInfo(d) {
      const day = (typeof d === "string" ? new Date(d) : d).getDay();
      return day === 0 || day === 6 ? { off: true, reason: "weekend", label: "주말" } : { off: false, reason: null, label: null };
    },
  };
}

// 고정 웹훅 주소와 받을 곳(@아이디) 검증. 팝업·설치 화면과 같은 규칙을 써야 한다.
// 이 파일이 없으면 검증을 못 하는데, 그렇다고 검증 없이 보내면 채널 전체에
// 알림이 갈 수 있으므로 "전부 거절"로 물러난다. (홀리데이와 달리 안전한
// 기본값이 '보내지 않기'인 쪽이다)
try {
  importScripts("mattermost.js");
} catch (e) {
  self.SsafyMattermost = {
    normalizeTarget() {
      return { ok: false, value: "", error: "받을 곳을 확인할 수 없어 전송을 멈췄어요." };
    },
    isValidTarget() {
      return false;
    },
    pickWebhookUrl() {
      return "";
    },
  };
}

const REPO = "park-rudxo/ssafy-check";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
// /releases/latest 는 항상 최신 릴리스 페이지로 넘어간다. 버전이 올라가도
// 링크를 고칠 필요가 없어서, 알림 클릭과 팝업 링크 모두 이걸 쓴다.
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
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
  // 웹스토어 빌드는 크롬이 알아서 갱신하므로 이 확인 자체가 필요 없다.
  // (그래서 manifest 에서 api.github.com 호스트 권한도 함께 빠진다)
  if (!IS_WEBSTORE) {
    chrome.alarms.create(UPDATE_ALARM, { when: nextIntervalBoundary(15), periodInMinutes: 15 });
  }
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
  if (area !== "local") return;
  if (changes.autoOpen) scheduleAutoOpen();
  if (changes.mattermost && !(changes.eduAccount && changes.eduAccount.newValue && changes.eduAccount.newValue.name)) {
    openAttendanceAfterConnect(changes.mattermost);
  }
});

// ── 연결이 끝나면 출석 화면을 연다 ────────────────────────────────────
// 주인을 "먼저 edu 를 연 사람"이 아니라 연결한 계정으로 잡으려면, 연결한
// 사람이 아직 그 자리에 있을 때 edu 를 한 번 열어둬야 한다. 지금 키보드 앞에
// 있는 사람이 주인이 맞다.
//
// 이 일을 팝업에서 하면 안 된다. 팝업은 포커스를 잃는 순간 닫히고, 닫히면
// 그 뒤의 코드가 통째로 사라진다. 실제로 팝업에서 열게 했더니 탭도 안 열리고
// 결과 문구도 안 보이는 일이 있었다. 여기서 확실한 사실은 하나다 - 연결이
// 됐다면 설정은 저장됐다. 그 저장을 보고 서비스 워커가 여는 편이 팝업이
// 언제 닫히든 영향을 받지 않는다.
//
// 뒤에서 연다. 앞으로 띄우면 설정을 마치던 사람을 끌어내는데, content.js 는
// 배경 탭에서도 똑같이 돌아 주인을 잡는다.
function openAttendanceAfterConnect(change) {
  const before = change.oldValue;
  const after = change.newValue;
  // 최초 연결 또는 연결 계정이 바뀌었을 때 연다. 알림 종류를 켜고
  // 끄는 것도 같은 키를 건드리므로, 그때마다 탭이 열리면 안 된다.
  if (!SsafyMattermost.isConfigured(after)) return;
  if (SsafyMattermost.isConfigured(before) && before.channel === after.channel) return;

  SsafyDebug.log("계정", "연결이 끝나 출석 화면을 연다 (주인 확정용)");
  try {
    chrome.tabs.create({ url: SSAFY_HOME, active: false });
  } catch (e) {
    /* 탭을 못 열어도 연결 자체는 끝났다. 주인은 다음에 edu 를 열 때 잡힌다. */
  }
}

// ── Mattermost 연동 ───────────────────────────────────────────────────
// 크롬 알림은 자리를 비우거나 크롬을 닫으면 못 보지만, Mattermost로 보내면
// 폰 앱으로 푸시가 오기 때문에 "18시 넘었는데 퇴실 안 함"을 놓치기 어렵다.
// 사용자 계정으로 발급한 Incoming Webhook(토큰/봇 계정 불필요)에 JSON을
// POST 하는 방식만 쓴다. 웹훅이 없으면 아무것도 보내지 않는다.
const MM_DEFAULTS = {
  enabled: false,
  channel: "", // 반드시 "@아이디" (개인 메시지). 비면 아예 보내지 않는다.
  // 확장이 사용자 계정으로 발급한 웹훅. 이게 없으면 아무것도 보내지 않는다.
  // 글쓴이가 본인이라, 남의 계정으로 알림이 새어 나갈 구조 자체가 없다.
  webhookUrl: "",
  notifyCheckin: true,
  notifyCheckout: true,
  notifyMissing: true,
  // 연결한 Mattermost 계정의 한글 이름 후보. 이 브라우저의 주인을 "먼저 연
  // 사람"이 아니라 이 이름으로 확정하는 데 쓴다. (mattermost.js 참고)
  ownerNames: [],
};

// 메시지 카드에 붙일 라벨. 웹훅은 만든 사람(=본인) 계정으로 글을 쓰기 때문에
// 게시글 헤더에는 자기 이름이 뜨는데, 무슨 메시지인지는 "출석 알리미" 쪽이
// 알아보기 쉽다.
//
// payload에 username/icon_emoji를 실어 글쓴이 자체를 바꾸는 방법을
// 먼저 시도했지만, SSAFY 서버에서 실제로 테스트해 확인한 결과 게시글
// 헤더는 그대로였다 (EnablePostUsernameOverride가 꺼져 있는 서버 설정
// 때문 - 확장에서 바꿀 수 없다). 그래서 게시글 작성자를 바꾸는 대신,
// 메시지 본문 안에 "출석 알리미" 라벨이 붙은 첨부(attachment) 카드를
// 넣는다. 이 방식은 서버 설정과 무관하게 항상 적용된다.
// (게시글 헤더의 계정 이름 표시 자체는 그대로 남는다 - 카드 안쪽 라벨만 바뀐다)
const MM_BOT_NAME = "출석 알리미";

// 미체크 경고를 보낼 시각들. 한 번 보내고 끝내면 놓치기 쉬워서, 아직
// 체크되지 않은 동안 점점 촘촘하게 여러 번 보낸다.
const MM_WARN_CHECKIN_MINS = [8 * 60 + 50, 8 * 60 + 55, 8 * 60 + 58];
const MM_WARN_CHECKOUT_MINS = [18 * 60, 18 * 60 + 5, 18 * 60 + 15, 18 * 60 + 30];
const MM_WARN_PREFIX = "ssafy-mm-warn-";

// 알람은 예정 시각을 놓쳤다고 사라지지 않는다. PC가 절전이었거나 크롬이 꺼져
// 있었으면, 다시 깨어나는 순간 밀린 알람이 한꺼번에 울린다. 그때 예정 시각만
// 믿고 보내면 09:30에 "09:00까지 2분/5분/10분 남았습니다"가 한꺼번에(게다가
// 순서도 뒤죽박죽으로) 날아온다 - 이미 입실을 마친 뒤라도, 브라우저가 방금
// 켜져 아직 출석 위젯을 못 읽었으면 "안 눌렀다"로 보이기 때문이다.
// 그래서 보내기 직전에 지금 시각을 다시 보고, 예정보다 이만큼 넘게 늦은
// 알람은 버린다. 놓친 경고를 뒤늦게 보내봐야 알려주는 게 없다.
const MM_WARN_LATE_TOLERANCE_MIN = 2;

function minutesOfDay(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

// 지금 보내도 되는 알람인가. 예정 시각 언저리(1분 이르거나 몇 분 늦거나)일
// 때만 참이다. 날이 바뀌어 울린 알람은 차이가 크게 음수가 되어 걸러진다.
function isWarnOnTime(scheduledMin, nowMin) {
  const late = nowMin - scheduledMin;
  return late >= -1 && late <= MM_WARN_LATE_TOLERANCE_MIN;
}

async function getMattermost() {
  const { mattermost } = await chrome.storage.local.get("mattermost");
  return { ...MM_DEFAULTS, ...(mattermost || {}) };
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── 쉬는 날 판정 ──────────────────────────────────────────────────────
// 주말 + 공휴일 + 사용자가 등록한 개인 휴무일(연차·공가 등)을 모두 쉬는 날로 본다.
// 알림·자동 열기는 전부 이 함수 하나를 통과한다.
const DAYOFF_DEFAULT = { offDays: [], workDays: [] };

async function getDayOffSettings() {
  const { dayOff } = await chrome.storage.local.get("dayOff");
  return { ...DAYOFF_DEFAULT, ...(dayOff || {}) };
}

async function isDayOff(d = new Date()) {
  return SsafyHolidays.dayInfo(d, await getDayOffSettings()).off;
}

function hhmm(totalMin) {
  return `${String(Math.floor(totalMin / 60)).padStart(2, "0")}:${String(totalMin % 60).padStart(2, "0")}`;
}

// Incoming Webhook으로 메시지 1건 전송.
//
// 예전에는 네트워크 오류를 감안해 1회 재시도했는데, Incoming Webhook은
// 같은 요청을 두 번 보내도 중복으로 걸러주지 않는다. 첫 요청이 서버까지는
// 도착해 메시지가 실제로 올라갔는데 확장 쪽이 응답을 못 받아 실패로
// 착각하면, 재시도가 그대로 두 번째 메시지가 되어 "2번씩 온다"는 결과로
// 이어진다. 그래서 딱 1번만 시도한다. 미체크 경고는 체크할 때까지 몇 분
// 간격으로 계속 다시 보내므로, 이번 시도가 실패해도 자연히 다음 번에
// 만회된다.
async function postToMattermost(text, cfg) {
  const s = cfg || (await getMattermost());

  // 받는 사람은 반드시 "@아이디"여야 한다. 비어 있으면 Webhook의 기본 채널로
  // 가버려서 그 방 사람들 전원에게 알림이 울리므로, 여기서 막는다.
  // 비워두면 웹훅을 걸어둔 채널로 가버린다. (설정 화면에서도 막지만, 예전
  // 버전에서 비워둔 채 저장된 설정이 남아 있을 수 있어 전송 직전에 다시 본다)
  // DM은 Mattermost 기본 설정에서 폰 푸시가 오기 때문에 알림용으로도 가장
  // 확실하다.
  const target = SsafyMattermost.normalizeTarget(s.channel);
  if (!target.ok) {
    SsafyDebug.log("mm", "받을 곳이 올바르지 않아 보내지 않음", { channel: s.channel, error: target.error });
    return { ok: false, error: target.error };
  }

  // 내용은 최상위 text가 아니라 attachments 안에 넣는다. 첨부 카드 안의
  // author_name은 서버의 게시자 덮어쓰기 설정과 무관하게 항상 표시된다.
  // fallback은 카드를 못 그리는 클라이언트(옛 버전 등)를 위한 대체 텍스트다.
  const payload = {
    channel: target.value,
    attachments: [
      {
        author_name: MM_BOT_NAME,
        text,
        fallback: text,
      },
    ],
  };

  // 내 웹훅이 없으면 보낼 곳이 없다. 예전에는 여기서 공용 웹훅으로 물러났는데,
  // 그러면 자동 설정이 안 된 사람의 알림이 공용 웹훅 주인에게 몰린다.
  const url = SsafyMattermost.pickWebhookUrl(s);
  if (!url) {
    SsafyDebug.log("mm", "내 웹훅이 없어 보내지 않음");
    return { ok: false, error: "아직 설정이 끝나지 않았어요. 확장 아이콘을 눌러 설정을 마쳐주세요." };
  }
  SsafyDebug.log("mm", "전송 시도", { to: target.value, text: text.slice(0, 60) });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      SsafyDebug.log("mm", "전송 성공", { to: target.value });
      return { ok: true };
    }
    // 본문에 실패 이유가 들어 있다(없는 아이디, 권한 없음, 요청 과다 등).
    // 이걸 버리면 사용자에게는 "안 왔다"만 남아 원인을 좁힐 수 없다.
    const body = await res.text().catch(() => "");
    SsafyDebug.log("mm", "전송 실패", { status: res.status, body: body.slice(0, 300) });
    return { ok: false, error: `Mattermost 응답 오류 (${res.status}) ${body.slice(0, 200)}` };
  } catch (e) {
    // host_permissions가 없으면 여기서 CORS 오류로 떨어진다.
    const msg = String(e && e.message ? e.message : e);
    SsafyDebug.log("mm", "전송 예외", { error: msg });
    return { ok: false, error: msg };
  }
}

// ── 오늘의 출석 상태 (content.js가 알려준 클릭 기록) ────────────────────
// content.js는 페이지의 localStorage에 기록하는데 서비스 워커는 그걸 읽을 수
// 없어서, 같은 내용을 chrome.storage.local에도 저장해 백그라운드가 "아직 안
// 눌렀는지"를 판단할 수 있게 한다.
const ATTENDANCE_DEFAULT = {
  date: "",
  checkinMin: null, // 이 브라우저에서 버튼을 누른 기록
  checkoutMin: null,
  pageCheckinMin: null, // 출석 위젯에 찍힌 시각 (서버 기준, 더 신뢰도 높음)
  pageCheckoutMin: null,
  // 위젯에 시각이 안 찍혀도 "정상 출석" 문구가 보이면 입실한 것이다.
  // 시각만 믿으면 문구만 있는 화면에서 "입실 안 함"으로 오판한다.
  pageCheckedIn: false,
};

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── 이 브라우저의 주인 (에듀싸피 계정) ────────────────────────────────
// 실제로 일어난 사고: 시험날 자리를 옮겨 앉으면서, A의 PC(크롬은 A로 로그인된
// 채)에 B가 앉아 자기 아이디로 edu.ssafy.com 에 로그인해 입실을 눌렀다.
// 확장의 Mattermost 설정은 크롬 프로필에 붙어 있어서, B의 입실이 A에게
// "✅ 입실 체크 완료"로 전달됐다. A는 아직 오지도 않았는데 자기가 체크된 줄
// 알게 되고, 게다가 그 기록이 A의 오늘치 출석 상태로 저장되는 바람에
// "아직 입실 안 했어요" 경고까지 멎는다 - 정확히 이 확장이 막으려던 상황을
// 이 확장이 만든 셈이다.
//
// 그래서 content.js 가 화면에서 읽은 이름을 함께 보내고, 그 이름이 이
// 브라우저의 주인과 다르면 그 보고를 통째로 무시한다.
//
// 주인은 "처음 본 이름"으로 정한다. 설정 화면에서는 edu.ssafy.com 페이지를
// 읽을 수 없어 물어볼 방법이 없고, 확장을 깐 사람이 자기 크롬에서 처음
// 출석을 여는 것이 정상 경로다. 잘못 잡혔을 때를 위해 팝업에 다시 지정하는
// 버튼을 두고, Mattermost를 다시 연결하면 자동으로 풀린다.
// lastSeenAt: 이 PC에서 연결된 사용자를 마지막으로 확인한 날.
// 계정 전환 시에는 표시 이름과 인증된 Mattermost 정보를 함께 확인한다.
const EDU_ACCOUNT_DEFAULT = { name: "", boundAt: "", lastSeenAt: "" };

async function getEduAccount() {
  const { eduAccount } = await chrome.storage.local.get("eduAccount");
  return { ...EDU_ACCOUNT_DEFAULT, ...(eduAccount || {}) };
}

function accountName(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 20) : "";
}

// 연결한 Mattermost 계정의 이름 칸. 반 정보가 붙어 오기도 한다
// ("박경태[서울_3반]"). 비어 있으면(영문 아이디뿐이거나 아직 연결 전) 이름으로
// 주인을 가릴 근거가 없다는 뜻이다. 맞추는 규칙은 mattermost.js 에 있다.
async function expectedOwnerNames() {
  const s = await getMattermost();
  return Array.isArray(s.ownerNames) ? s.ownerNames.filter(Boolean) : [];
}

// 보고에 실린 계정이 이 브라우저 주인의 것인지 본다.
//   { ok: true }                     - 주인이거나, 판단할 근거가 없음
//   { ok: false, mine, theirs }      - 다른 사람의 출석이다
//
// 이름을 못 읽었으면(빈 값) 무조건 통과시킨다. 사이트 구조가 바뀌어 이름을
// 못 읽게 되는 순간 모두의 알림이 통째로 멎는 쪽이, 어쩌다 한 번 남의 알림이
// 가는 것보다 훨씬 나쁘기 때문이다. 확신이 설 때만 막는다.
// 웹훅은 활성 계정 하나만 보관한다. 계정별 기록에는 토큰 없이 설정과 출석만 남긴다.
async function applyAccountConnection(connection, name = "") {
  const data = await chrome.storage.local.get(["mattermost", "accountPreferences", "dayOff", "attendance", "mmSent"]);
  const previous = data.mattermost;
  const profiles = { ...(data.accountPreferences || {}) };
  const keyOf = cfg => cfg && (cfg.userId || cfg.channel);
  const previousKey = keyOf(previous);
  const nextKey = keyOf(connection);
  if (!nextKey || !SsafyMattermost.isConfigured({ ...connection, enabled: true })) throw new Error("연결 정보를 확인하지 못했어요.");
  if (previousKey) profiles[previousKey] = {
    notifyCheckin: previous.notifyCheckin !== false,
    notifyCheckout: previous.notifyCheckout !== false,
    notifyMissing: previous.notifyMissing !== false,
    dayOff: data.dayOff || DAYOFF_DEFAULT,
    attendance: data.attendance || null,
    mmSent: data.mmSent || null,
  };
  // 기존 버전에 userId가 없었던 경우 같은 채널의 설정을 이어받는다.
  const prefs = profiles[nextKey] || profiles[connection.channel] || {};
  const { dayOff, attendance, mmSent, ...notificationPrefs } = prefs;
  const mattermost = { ...MM_DEFAULTS, ...notificationPrefs, ...connection, enabled: true };
  await chrome.storage.local.set({
    mattermost,
    eduAccount: name ? { name, boundAt: todayStr(), lastSeenAt: todayStr() } : null,
    dayOff: dayOff || DAYOFF_DEFAULT, attendance: attendance || null, mmSent: mmSent || null,
    accountPreferences: profiles, accountPaused: null, eduHandover: null, eduReconnectPrompt: null,
  });
  return { ok: true, mattermost, dayOff: dayOff || DAYOFF_DEFAULT };
}

const recoveryAttempts = new Map();

async function recoverAccount(name) {
  if (!name || !chrome.permissions || !chrome.permissions.contains) return;
  const { mattermost, eduAccount } = await chrome.storage.local.get(["mattermost", "eduAccount"]);
  const hints = mattermost && mattermost.ownerNames || [];
  const matches = (!eduAccount || !eduAccount.name || eduAccount.name === name) &&
    (!hints.length || SsafyMattermost.matchesOwnerName(hints, name));
  if (SsafyMattermost.isConfigured(mattermost) && matches) return;
  if (mattermost && mattermost.webhookUrl && mattermost.enabled === false) return;
  const last = recoveryAttempts.get(name) || 0;
  if (Date.now() - last < 30000) return;
  recoveryAttempts.set(name, Date.now());
  if (recoveryAttempts.size > 20) recoveryAttempts.delete(recoveryAttempts.keys().next().value);
  try {
    if (!await chrome.permissions.contains({ origins: [SsafyMattermost.WEBHOOK_ORIGIN] })) return;
    const restored = await SsafyMattermost.restorePersonalWebhook(name);
    if (!restored) return;
    // 복구 중 사용자가 저장한 설정은 덮어쓰지 않는다.
    const current = await chrome.storage.local.get("mattermost");
    if (JSON.stringify(current.mattermost) !== JSON.stringify(mattermost)) return;
    await applyAccountConnection(restored, name);
    SsafyDebug.log("계정", "로그인 세션으로 기존 연결 자동 복구", { name, channel: restored.channel });
  } catch (error) {
    SsafyDebug.log("계정", "자동 복구 대기", { error: String(error.message || error) });
  }
}

async function checkEduOwner(reported, allowRecovery = true) {
  const name = accountName(reported);
  if (!name) return { ok: !(await chrome.storage.local.get("accountPaused")).accountPaused };

  if (allowRecovery) await recoverAccount(name);
  const today = todayStr();
  const acct = await getEduAccount();
  if (!SsafyMattermost.isConfigured(await getMattermost())) {
    return { ok: false, mine: "", theirs: name, notOwner: true };
  }
  const expected = await expectedOwnerNames();
  if (expected.length && !SsafyMattermost.matchesOwnerName(expected, name)) {
    SsafyDebug.log("계정", "연결된 계정이 아니라 주인으로 잡지 않음", { expected, name });
    // 문구에는 반 정보를 뺀 이름만 쓴다. "박경태[서울_3반]님" 은 읽기 나쁘다.
    return { ok: false, mine: SsafyMattermost.displayOwnerName(expected[0]) || expected[0], theirs: name, notOwner: true };
  }
  if (!acct.name) {
    // 주인이 아직 없다. 연결한 Mattermost 계정의 이름을 알면 그것이 주인이다 -
    // 웹훅은 본인이 로그인해서 만든 것이기 때문이다. 지금 화면의 사람이 그
    // 이름이 아니면, 연결만 해두고 아직 edu 를 열지 않은 사이에 다른 사람이
    // 앉은 것이다. 여기서 주인으로 기억해버리면 정작 본인의 출석이 그 뒤로
    // 계속 "남의 출석"으로 무시된다.
    await chrome.storage.local.set({ eduAccount: { name, boundAt: today, lastSeenAt: today }, accountPaused: null });
    SsafyDebug.log("계정", "이 브라우저의 주인으로 기억함", { name });
    return { ok: true };
  }
  if (acct.name === name) {
    const { accountPaused } = await chrome.storage.local.get("accountPaused");
    if (accountPaused) await chrome.storage.local.set({ accountPaused: null });
    // 주인을 본 날을 남긴다. 화면을 볼 때마다 보고가 오므로 날짜가 바뀔
    // 때만 쓴다.
    if (acct.lastSeenAt !== today) await chrome.storage.local.set({ eduAccount: { ...acct, lastSeenAt: today } });
    return { ok: true };
  }

  return { ok: false, mine: acct.name, theirs: name };
}

// 계정 불일치는 페이지의 작은 안내로 표시하고 원래 사용자의 설정을 보존한다.
async function refuseOtherAccount(owner) {
  // 계정이 달라도 설정을 삭제하지 않고 이 PC의 발송만 일시 중지한다.
  await chrome.storage.local.set({ accountPaused: { mine: owner.mine, theirs: owner.theirs } });
  return { ok: false, ignored: "account-mismatch" };
}

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

async function recordAttendanceForAccount(msg) {
  const kind = msg.kind === "checkin" ? "checkin" : "checkout";
  const minutes = Number(msg.minutes);
  if (!Number.isFinite(minutes)) return { ok: false };

  SsafyDebug.log("보고", "버튼 클릭 도착", { kind, minutes: hhmm(minutes), account: msg.account || "(모름)" });

  // 이 브라우저 주인의 출석이 아니면 기록도 알림도 하지 않는다. 기록까지
  // 막아야 하는 이유: 남의 입실을 오늘치로 저장해두면 "아직 입실 안 했어요"
  // 경고가 멎어서, 주인은 완료 알림도 못 받고 경고도 못 받는다.
  const owner = await checkEduOwner(msg.account, msg.visible !== false);
  if (!owner.ok) return msg.visible === false ? { ok: false, ignored: "background-account" } : refuseOtherAccount(owner);

  const a = await getAttendance();
  a.date = todayStr();
  if (kind === "checkin") {
    if (a.checkinMin == null) a.checkinMin = minutes;
  } else {
    // 퇴실은 18시 이후 기록이 있어야 인정되므로 가장 늦은 클릭을 남긴다.
    if (a.checkoutMin == null || minutes > a.checkoutMin) a.checkoutMin = minutes;
  }
  await chrome.storage.local.set({ attendance: a });

  await notifyAttendanceDone(kind, minutes);
  return { ok: true };
}

// "입실/퇴실 체크 완료" 메시지 1건. 부르는 곳이 둘(버튼 클릭 감지 / 출석
// 위젯에서 읽어낸 시각)이지만 같은 열쇠로 중복을 막기 때문에, 두 경로가
// 모두 발동해도 하루에 한 번만 간다.
async function notifyAttendanceDone(kind, minutes) {
  if ((await chrome.storage.local.get("accountPaused")).accountPaused) return;
  // 여기서 걸러진 이유가 곧 "왜 메시지가 안 왔는지"의 답이라, 걸러질 때마다
  // 그 이유를 남긴다. 조건 하나하나가 조용한 실패의 후보다.
  const skip = (why) => SsafyDebug.log("done", `${kind} 알림 건너뜀`, { why, minutes });

  // 쉬는 날에는 아무것도 내보내지 않는다. 출석 상태 보고는 화면 표시 조건과
  // 무관하게 항상 올라오므로(content.js 의 reportObserved), 이 검사가 없으면
  // 주말에 SSAFY 페이지를 잠깐 열어본 것만으로 알림이 나간다.
  if (await isDayOff()) return skip("쉬는 날");

  const s = await getMattermost();
  if (!s.enabled) return skip("Mattermost 연동이 꺼져 있음");
  // 받는 사람이 없으면 보내지 않는다. markSentOnce보다 먼저 확인해서,
  // 설정을 고친 뒤 그날 안에 다시 보낼 수 있게 한다.
  if (!SsafyMattermost.isValidTarget(s.channel)) return skip(`받을 곳이 올바르지 않음 (${s.channel})`);
  if (kind === "checkin" && !s.notifyCheckin) return skip("입실 알림이 꺼져 있음");
  if (kind === "checkout" && !s.notifyCheckout) return skip("퇴실 알림이 꺼져 있음");
  // 18시 이전 퇴실 기록은 아직 정상 퇴실이 아니라 "완료"로 알리지 않는다.
  if (kind === "checkout" && minutes < CHECK_OUT_MIN) return skip("18시 이전 퇴실이라 완료로 보지 않음");
  // 열쇠의 "click-"은 클릭 감지만 이 알림을 보내던 시절의 흔적이다. 이름을
  // 바꾸면 이미 저장된 오늘치 기록과 어긋나 그날 알림이 한 번 더 가므로 둔다.
  if (!(await markSentOnce(`click-${kind}`))) return skip("오늘 이미 보냄");

  const text =
    kind === "checkin"
      ? `✅ **입실 체크 완료** (${hhmm(minutes)})`
      : `✅ **퇴실 체크 완료** (${hhmm(minutes)})`;
  await postToMattermost(text, s);
}

// content.js가 출석 위젯에서 읽어낸 서버 기준 시각을 반영한다.
async function observeAttendanceForAccount(msg) {
  const ci = numOrNull(msg.checkinMin);
  const co = numOrNull(msg.checkoutMin);

  // 위젯에 찍힌 시각도 결국 "지금 로그인한 사람"의 것이다. 주인이 아니면
  // 그 사람의 출석 상태를 주인의 오늘치로 덮어쓰면 안 된다. 아래에서 무엇을
  // 기록하든 그 전에 걸러야 한다.
  const owner = await checkEduOwner(msg.account, msg.visible !== false);
  if (!owner.ok) return msg.visible === false ? { ok: false, ignored: "background-account" } : refuseOtherAccount(owner);

  // 시각이 있으면 당연히 입실한 것이고, 시각이 없어도 페이지가 입실했다고
  // 하면(= "정상 출석" 문구) 그대로 믿는다.
  const inDone = ci != null || msg.checkedIn === true;
  const a = await getAttendance();
  const same = a.pageCheckinMin === ci && a.pageCheckoutMin === co && a.pageCheckedIn === inDone;
  SsafyDebug.log("보고", "위젯 관찰 도착", {
    입실: ci == null ? (inDone ? "시각 없이 정상 출석" : "없음") : hhmm(ci),
    퇴실: co == null ? "없음" : hhmm(co),
    바뀜: !same,
  });
  if (same) return { ok: true };
  a.date = todayStr();
  a.pageCheckinMin = ci;
  a.pageCheckoutMin = co;
  a.pageCheckedIn = inDone;
  await chrome.storage.local.set({ attendance: a });

  // 위젯에 시각이 찍혔다는 건 서버가 출석을 받았다는 뜻이라, 클릭 감지보다
  // 확실한 근거다. 클릭 감지에만 기대면 폰으로 눌렀거나, 다른 PC에서 눌렀거나,
  // 버튼 클릭 직후 페이지가 넘어가 보고가 유실된 경우에 "완료" 알림이 아예
  // 오지 않는다. 아침 입실이 딱 그런 경우다 - 출근길에 폰으로 누르고 나면
  // 이 브라우저에는 클릭 기록이 없어 입실 메시지만 조용히 빠졌다.
  if (ci != null) await notifyAttendanceDone("checkin", ci);
  if (co != null) await notifyAttendanceDone("checkout", co);
  return { ok: true };
}

// 미체크 경고는 아직 안 눌렀으면 예정된 시각마다 다시 보낸다(점점 촘촘해지는
// 리마인더라 중복이 아니다). 대신 "같은 시각의 경고"는 하루에 한 번뿐이고,
// 예정 시각을 한참 넘겨 울린 알람은 아예 보내지 않는다.
async function handleMattermostWarning(totalMin) {
  if ((await chrome.storage.local.get("accountPaused")).accountPaused) return;
  const skip = (why) => SsafyDebug.log("경고", `${hhmm(totalMin)} 경고 건너뜀`, { why });

  // 밀렸다가 뒤늦게 울린 알람은 여기서 끊는다. 이 검사가 없으면 절전에서
  // 깨어난 직후 지나간 경고들이 한꺼번에 쏟아진다.
  const nowMin = minutesOfDay();
  if (!isWarnOnTime(totalMin, nowMin)) return skip(`예정보다 늦게 울림 (지금 ${hhmm(nowMin)})`);

  if (await isDayOff()) return skip("쉬는 날"); // 주말·공휴일·개인 휴무일에는 경고하지 않는다

  const s = await getMattermost();
  if (!s.enabled) return skip("Mattermost 연동이 꺼져 있음");
  if (!s.notifyMissing) return skip("미체크 경고가 꺼져 있음");
  if (!SsafyMattermost.isValidTarget(s.channel)) return skip(`받을 곳이 올바르지 않음 (${s.channel})`);

  const a = await getAttendance();
  SsafyDebug.log("경고", `${hhmm(totalMin)} 판단 시작`, {
    클릭입실: a.checkinMin == null ? "없음" : hhmm(a.checkinMin),
    클릭퇴실: a.checkoutMin == null ? "없음" : hhmm(a.checkoutMin),
    위젯입실: a.pageCheckinMin == null ? (a.pageCheckedIn ? "시각 없이 정상 출석" : "없음") : hhmm(a.pageCheckinMin),
    위젯퇴실: a.pageCheckoutMin == null ? "없음" : hhmm(a.pageCheckoutMin),
  });
  // 경고는 일부러 여러 번 보내지만, "같은 시각의 경고"가 두 번 갈 이유는
  // 없다. 알람이 어쩌다 두 번 울려도 여기서 한 번으로 눌러준다.
  if (!(await markSentOnce(`warn-${totalMin}`))) return skip("이 시각 경고는 오늘 이미 보냄");

  if (MM_WARN_CHECKIN_MINS.includes(totalMin)) {
    // 위젯이 입실했다고 하면 폰으로 눌렀더라도 입실한 것이다. 시각이 안
    // 찍히고 "정상 출석" 문구만 있는 경우까지 포함한다.
    if (a.pageCheckedIn || a.pageCheckinMin != null || a.checkinMin != null) return;
    // 남은 시간은 예정 시각이 아니라 지금 시각에서 센다. 알람이 1~2분 늦게
    // 울렸을 때 문구가 실제와 어긋나지 않도록.
    const left = CHECK_IN_MIN - nowMin;
    if (left <= 0) return skip("이미 09:00이 지남");
    await postToMattermost(`🚨 **아직 입실 체크를 안 했어요!** 09:00까지 ${left}분 남았습니다.\n${SSAFY_HOME}`, s);
    return;
  }

  // 위젯에서 읽은 시각이 있으면 그게 서버 기준 진실이라 클릭 기록보다 우선한다.
  if (a.pageCheckoutMin != null) {
    if (a.pageCheckoutMin >= CHECK_OUT_MIN) return; // 정상 퇴실 확인됨
    // 18시 이전 기록만 있는 상태. "안 눌렀다"가 아니라 "일찍 눌렀다"이므로
    // 무엇이 문제인지 정확히 알려준다.
    await postToMattermost(
      `🚨 **퇴실 기록이 ${hhmm(a.pageCheckoutMin)}(18시 이전)뿐이에요!** 지금 다시 누르지 않으면 조퇴 처리됩니다.\n${SSAFY_HOME}`,
      s
    );
    return;
  }

  if (a.checkoutMin != null && a.checkoutMin >= CHECK_OUT_MIN) return; // 클릭 기록으로 확인
  // 알람이 18:00보다 몇 초 일찍 울려 -1분이 나오는 일이 없도록 바닥을 둔다.
  const late = Math.max(0, nowMin - CHECK_OUT_MIN);
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

chrome.runtime.onInstalled.addListener(async (details) => {
  scheduleAll();
  // 설치/업데이트 직후에는 "현재 최신 Release"를 이미 본 것으로 기준을 잡아
  // 방금 설치한 사용자에게 곧바로 알림이 뜨지 않도록 한다.
  await setBaselineIfNeeded();
  // 처음 설치했을 때만 랜딩 + 초기 설정 화면을 연다.
  // (업데이트 때마다 열면 성가시므로 install에서만)
  if (details && details.reason === "install") openWelcome();
});

function openWelcome(reconnect = false) {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL(reconnect ? "welcome.html?reason=account-mismatch" : "welcome.html") });
  } catch (e) {
    /* 탭을 열 수 없는 상황이면 무시 (팝업에서 다시 열 수 있다) */
  }
}
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

  // 입실/퇴실 N분 전 → SSAFY 홈 자동 열기 (쉬는 날 제외)
  if (alarm.name === OPEN_CHECKIN_ALARM || alarm.name === OPEN_CHECKOUT_ALARM) {
    isDayOff().then((off) => {
      if (!off) chrome.tabs.create({ url: SSAFY_HOME });
    });
    return;
  }

  const reminder = REMINDERS.find((r) => r.name === alarm.name);
  if (!reminder) return;

  // 주말·공휴일·개인 휴무일에는 리마인더 알림을 보내지 않는다.
  isDayOff().then((off) => {
    if (off) return;
    chrome.notifications.create(reminder.name + "-" + Date.now(), {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: reminder.title,
      message: reminder.message,
      priority: 2,
      requireInteraction: true,
    });
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
// api.github.com 을 호출하는 곳은 여기 하나뿐이다. 웹스토어 빌드는 여기서
// 바로 돌아서므로 호출이 아예 일어나지 않고, 그래서 manifest 에서 해당
// 호스트 권한을 빼도 안전하다.
async function fetchLatestRelease() {
  if (IS_WEBSTORE) return { none: true };
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
  if (msg && msg.type === "activateAccount") {
    if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "확장 설정 화면에서 연결해주세요." });
      return false;
    }
    enqueueAttendance(() => applyAccountConnection(msg.connection)).then(sendResponse,
      error => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
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
  // 팝업/튜토리얼의 "테스트 메시지 보내기" 버튼
  if (msg && msg.type === "mattermostTest") {
    postToMattermost("✅ SSAFY 출석 체크 알리미 — 이 메시지가 보이면 설정 완료입니다.").then(sendResponse);
    return true;
  }
  // 팝업의 "사용법 다시 보기"
  if (msg && msg.type === "openWelcome") {
    openWelcome(msg.reconnect === true);
    sendResponse({ ok: true });
    return false;
  }
});

// 여러 탭의 계정 확인·출석 기록·전송을 순서대로 처리한다.
let attendanceQueue = Promise.resolve();
function enqueueAttendance(work) {
  const result = attendanceQueue.then(work);
  attendanceQueue = result.catch(() => {});
  return result;
}
function handleAttendanceRecorded(msg) { return enqueueAttendance(() => recordAttendanceForAccount(msg)); }
function handleAttendanceObserved(msg) { return enqueueAttendance(() => observeAttendanceForAccount(msg)); }
