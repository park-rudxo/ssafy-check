// SSAFY 출석 체크 알리미 - 백그라운드 서비스 워커
//  1) 평일 08:50(입실), 18:00(퇴실) 리마인더 알림
//  2) GitHub의 최신 Release를 주기적으로 확인해, 설치된 버전보다 높으면
//     "새 버전 나왔어요" 업데이트 알림을 띄운다. (배포는 GitHub Release 발행으로 제어)

const REPO = "park-rudxo/ssafy-check";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const UPDATE_ALARM = "ssafy-update-check";
const UPDATE_NOTI_ID = "ssafy-update";

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

function scheduleAll() {
  for (const r of REMINDERS) {
    chrome.alarms.create(r.name, {
      when: nextOccurrence(r.hour, r.minute),
      periodInMinutes: 24 * 60,
    });
  }
  // 6시간마다 업데이트 확인
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleAll();
  checkForUpdate(false);
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAll();
  checkForUpdate(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) {
    checkForUpdate(false);
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

// 알림 클릭 처리: 업데이트 알림이면 릴리스 페이지, 그 외엔 출석 페이지
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId === UPDATE_NOTI_ID) {
    const { latestReleaseUrl } = await chrome.storage.local.get("latestReleaseUrl");
    chrome.tabs.create({ url: latestReleaseUrl || RELEASES_PAGE });
  } else {
    chrome.tabs.create({ url: "https://edu.ssafy.com/edu/main/index.do" });
  }
  chrome.notifications.clear(notificationId);
});

// ── 업데이트 확인 ────────────────────────────────────────────────────
function parseVersion(v) {
  return String(v || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
}

// a가 b보다 높은 버전이면 true
function isNewer(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// manual=true 이면 (동일 버전 알림 여부와 무관하게) 결과를 반환한다.
async function checkForUpdate(manual) {
  const current = chrome.runtime.getManifest().version;
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return { ok: false, current, error: `GitHub 응답 오류 (${res.status})` };

    const data = await res.json();
    const latest = String(data.tag_name || "").replace(/^v/i, "");
    const url = data.html_url || RELEASES_PAGE;
    const hasUpdate = !!latest && isNewer(latest, current);

    if (hasUpdate) {
      await chrome.storage.local.set({ latestReleaseUrl: url });
      const { lastNotifiedVersion } = await chrome.storage.local.get("lastNotifiedVersion");
      // 자동 확인 시에는 같은 버전을 중복 알림하지 않는다.
      if (manual || lastNotifiedVersion !== latest) {
        chrome.notifications.create(UPDATE_NOTI_ID, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "SSAFY 출석 알리미 새 버전!",
          message: `v${latest}이(가) 나왔어요. 클릭해서 업데이트하세요. (현재 v${current})`,
          priority: 2,
          requireInteraction: true,
        });
        await chrome.storage.local.set({ lastNotifiedVersion: latest });
      }
    }

    return { ok: true, current, latest: latest || current, url, hasUpdate };
  } catch (e) {
    return { ok: false, current, error: String(e && e.message ? e.message : e) };
  }
}

// 팝업의 "업데이트 확인" 버튼 요청 처리
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "checkUpdate") {
    checkForUpdate(true).then(sendResponse);
    return true; // 비동기 응답
  }
});
