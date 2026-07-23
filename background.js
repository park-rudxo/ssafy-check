// SSAFY 출석 체크 알리미 - 백그라운드 서비스 워커
// 평일 08:50(입실 리마인더), 18:00(퇴실 리마인더)에 크롬 알림을 보낸다.

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
}

chrome.runtime.onInstalled.addListener(scheduleAll);
chrome.runtime.onStartup.addListener(scheduleAll);

chrome.alarms.onAlarm.addListener((alarm) => {
  const reminder = REMINDERS.find((r) => r.name === alarm.name);
  if (!reminder) return;

  // 주말에는 알림을 보내지 않는다.
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

// 알림 클릭 시 SSAFY 출석 페이지 열기
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.tabs.create({ url: "https://edu.ssafy.com/edu/main/index.do" });
  chrome.notifications.clear(notificationId);
});
