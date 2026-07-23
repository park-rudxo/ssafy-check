// 현재 시간 기준으로 지금 해야 할 행동을 안내한다.
(() => {
  const statusEl = document.getElementById("status");
  const now = new Date();
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();

  if (day === 0 || day === 6) {
    statusEl.className = "status idle";
    statusEl.textContent = "😴 오늘은 주말입니다.";
  } else if (minutes < 9 * 60) {
    const left = 9 * 60 - minutes;
    statusEl.className = "status danger";
    statusEl.textContent = `🚨 입실 체크 시간! 09:00까지 ${left}분 남음`;
  } else if (minutes < 18 * 60) {
    const left = 18 * 60 - minutes;
    const h = Math.floor(left / 60);
    const m = left % 60;
    statusEl.className = "status ok";
    statusEl.textContent = `✅ 교육 시간 중 · 퇴실까지 ${h}시간 ${m}분`;
  } else {
    statusEl.className = "status danger";
    statusEl.textContent = "🚨 18시 이후! 퇴실 버튼을 누르세요.";
  }

  document.getElementById("open-ssafy").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://edu.ssafy.com/edu/main/index.do" });
  });
})();
