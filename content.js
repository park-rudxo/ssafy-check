// SSAFY 출석 체크 알리미 - 콘텐츠 스크립트
// 규칙:
//  - 입실: 평일 09:00 이전에 반드시 입실 체크 (08:59까지)
//  - 퇴실: 반드시 18:00 이후에 퇴실 버튼 클릭 (그 전에 누르면 조퇴 처리 위험)

(() => {
  "use strict";

  const CHECK_IN_DEADLINE_MIN = 9 * 60; // 09:00
  const CHECK_OUT_START_MIN = 18 * 60; // 18:00
  const HIGHLIGHT_CLASS = "ssafy-alert-highlight";
  const BANNER_ID = "ssafy-alert-banner";

  function nowMinutes() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function isWeekday() {
    const day = new Date().getDay();
    return day >= 1 && day <= 5;
  }

  // 화면 전체에서 정규식과 일치하는 텍스트를 가진 클릭 가능한 요소를 찾는다.
  // SSAFY 페이지 구조가 바뀌어도 동작하도록 텍스트 기반으로 탐색한다.
  function findClickableByText(regex) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue && node.nodeValue.trim();
        if (!text || !regex.test(text)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el) continue;
      // 우리가 만든 배너 안의 텍스트는 제외
      if (el.closest("#" + BANNER_ID)) continue;
      const clickable = el.closest('button, a, input[type="button"], input[type="submit"], [role="button"], [onclick]');
      if (clickable && isVisible(clickable)) return clickable;
      if (isVisible(el)) return el;
    }
    return null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 텍스트 존재 여부만 확인 (상태 판별용)
  function pageHasText(regex) {
    const banner = document.getElementById(BANNER_ID);
    const bodyText = document.body.innerText || "";
    const bannerText = banner ? banner.innerText : "";
    // 배너 문구 때문에 오탐이 나지 않도록 배너 텍스트는 제거
    const text = bannerText ? bodyText.replace(bannerText, "") : bodyText;
    return regex.test(text);
  }

  function findCheckInButton() {
    return findClickableByText(/입실\s*(하기|체크)?$/);
  }

  function findCheckOutButton() {
    return findClickableByText(/퇴실\s*하기/);
  }

  // 출석 위젯(노란 박스) - 버튼을 못 찾을 때의 대체 강조 대상
  function findAttendanceWidget() {
    const label = findClickableByText(/출석체크/);
    if (!label) return null;
    let el = label;
    for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
    return el;
  }

  function isCheckedIn() {
    // "정상 출석" 문구가 보이거나 퇴실 버튼이 있으면 입실한 상태
    return pageHasText(/정상\s*출석/) || !!findCheckOutButton();
  }

  function clearHighlights() {
    document.querySelectorAll("." + HIGHLIGHT_CLASS).forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
  }

  function highlight(el) {
    if (el && !el.classList.contains(HIGHLIGHT_CLASS)) {
      el.classList.add(HIGHLIGHT_CLASS);
    }
  }

  function showBanner(message, tone) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = BANNER_ID;
      document.body.appendChild(banner);
    }
    banner.textContent = message;
    banner.dataset.tone = tone; // "danger" | "warn"
    banner.style.display = "block";
  }

  function hideBanner() {
    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.style.display = "none";
  }

  function minutesLeftText(targetMin) {
    const left = targetMin - nowMinutes();
    if (left <= 0) return "";
    const h = Math.floor(left / 60);
    const m = left % 60;
    return h > 0 ? `${h}시간 ${m}분 남음` : `${m}분 남음`;
  }

  // ── 퇴실 클릭 기록 ───────────────────────────────────────────────────
  // 퇴실은 미리 눌러도 되지만, 18:00 이후에 누른 기록이 있어야 정상 퇴실로
  // 인정된다. 클릭 시각을 기록해 두고, 18:00 이후 클릭이 생길 때까지
  // 퇴실 버튼을 계속 강조한다.
  const CHECKOUT_KEY = "ssafy-alert-last-checkout";

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function recordCheckoutClick() {
    try {
      localStorage.setItem(CHECKOUT_KEY, JSON.stringify({ date: todayStr(), minutes: nowMinutes() }));
    } catch (e) {
      /* localStorage 사용 불가 시 무시 */
    }
  }

  function hasValidCheckoutToday() {
    try {
      const raw = localStorage.getItem(CHECKOUT_KEY);
      if (!raw) return false;
      const rec = JSON.parse(raw);
      return rec.date === todayStr() && rec.minutes >= CHECK_OUT_START_MIN;
    } catch (e) {
      return false;
    }
  }

  function showToast(message) {
    const old = document.getElementById("ssafy-alert-toast");
    if (old) old.remove();
    const toast = document.createElement("div");
    toast.id = "ssafy-alert-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
  }

  document.addEventListener(
    "click",
    (e) => {
      const checkOutBtn = findCheckOutButton();
      if (!checkOutBtn) return;
      if (!(e.target instanceof Element)) return;
      if (!checkOutBtn.contains(e.target) && e.target !== checkOutBtn) return;

      recordCheckoutClick();

      if (nowMinutes() < CHECK_OUT_START_MIN) {
        // 미리 누르는 것은 막지 않되, 18시 이후에 다시 눌러야 함을 안내
        showToast("ℹ️ 지금 퇴실을 눌러도 괜찮지만, 18:00 이후에 한 번 더 눌러야 정상 퇴실로 인정됩니다!");
      }
    },
    true
  );

  // ── 메인 상태 갱신 루프 ─────────────────────────────────────────────
  function update() {
    clearHighlights();

    if (!isWeekday()) {
      hideBanner();
      return;
    }

    const now = nowMinutes();
    const checkedIn = isCheckedIn();

    // 1) 입실 전 + 09:00 이전 → 입실 버튼 강조
    if (!checkedIn && now < CHECK_IN_DEADLINE_MIN) {
      const target = findCheckInButton() || findAttendanceWidget();
      highlight(target);
      const left = minutesLeftText(CHECK_IN_DEADLINE_MIN);
      showBanner(`🚨 입실 체크를 하세요! 09:00 마감 (${left})`, "danger");
      return;
    }

    // 2) 입실 전 + 09:00 이후 → 지각 상태, 그래도 강조
    if (!checkedIn && now >= CHECK_IN_DEADLINE_MIN) {
      const target = findCheckInButton() || findAttendanceWidget();
      if (target) {
        highlight(target);
        showBanner("⚠️ 입실 체크가 안 되어 있습니다! 지금 바로 체크하세요.", "danger");
      } else {
        hideBanner();
      }
      return;
    }

    // 3) 입실 완료 + 18:00 이후 → 오늘 18시 이후 퇴실 클릭 기록이 생길 때까지 강조
    //    (18시 전에 미리 눌러둔 기록만 있으면 조퇴 처리될 수 있으므로 계속 알림)
    if (checkedIn && now >= CHECK_OUT_START_MIN) {
      if (hasValidCheckoutToday()) {
        hideBanner();
        return;
      }
      const checkOutBtn = findCheckOutButton();
      if (checkOutBtn) {
        highlight(checkOutBtn);
        showBanner("🚨 18시가 지났습니다! 지금 퇴실 버튼을 누르세요. (18시 이전 기록만으로는 조퇴 처리될 수 있어요)", "danger");
      } else {
        // 퇴실 버튼이 화면에 없으면 상태를 판단할 수 없으므로 배너만 숨김
        hideBanner();
      }
      return;
    }

    // 4) 입실 완료 + 18:00 이전 → 조용히 대기 (퇴실 클릭 시 안내 토스트만 동작)
    hideBanner();
  }

  // 주기 실행 + DOM 변경 감지
  update();
  setInterval(update, 15 * 1000);

  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(update, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
