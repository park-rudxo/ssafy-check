// SSAFY 출석 체크 알리미 - 콘텐츠 스크립트
// 규칙:
//  - 입실: 평일 09:00 이전에 반드시 입실 체크 (08:59까지)
//  - 퇴실: 반드시 18:00 이후에 퇴실 버튼 클릭 (그 전에 누르면 조퇴 처리 위험)

(() => {
  "use strict";

  const CHECK_IN_DEADLINE_MIN = 9 * 60; // 09:00
  const CHECK_OUT_START_MIN = 18 * 60; // 18:00
  const BANNER_ID = "ssafy-alert-banner";

  // ── 개발자 모드 설정 ─────────────────────────────────────────────────
  // popup에서 chrome.storage.local에 저장한 값을 읽어, 시간/입실상태/요일을
  // 오버라이드해서 실제 시간과 무관하게 강조 효과를 미리 볼 수 있게 한다.
  //   enabled      : 개발자 모드 on/off
  //   time         : 가상 현재 시각(분, 0~1439) / null이면 실제 시각 사용
  //   checkedIn    : "auto" | "true"(입실완료) | "false"(입실전)
  //   forceWeekday : 주말에도 평일처럼 동작시키기
  const DEV_DEFAULTS = { enabled: false, time: null, checkedIn: "auto", forceWeekday: false };
  let dev = { ...DEV_DEFAULTS };

  function loadDevSettings(cb) {
    try {
      chrome.storage.local.get("ssafyDev", (data) => {
        dev = { ...DEV_DEFAULTS, ...(data && data.ssafyDev) };
        if (cb) cb();
      });
    } catch (e) {
      if (cb) cb();
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.ssafyDev) {
        dev = { ...DEV_DEFAULTS, ...changes.ssafyDev.newValue };
        update();
      }
    });
  } catch (e) {
    /* storage API 사용 불가 시 실제 시간 기준으로만 동작 */
  }

  function nowMinutes() {
    if (dev.enabled && dev.time != null) return dev.time;
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function isWeekday() {
    if (dev.enabled && dev.forceWeekday) return true;
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

  // 텍스트 노드에서 시작해, 지정한 크기 범위를 넘어서기 직전의 적당한
  // 컨테이너(박스)를 찾아 올라간다. 박스가 엉뚱하게 커지지 않게 한다.
  function climbToBox(start, minW, minH, maxW, maxH) {
    let el = start;
    let best = start;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement;
      const r = el.getBoundingClientRect();
      if (r.width > maxW || r.height > maxH) break;
      if (r.width >= minW && r.height >= minH) best = el;
    }
    return best;
  }

  // 입실 칸: 입실 전이면 "입실하기", 입실 후면 "정상 출석"이 표시되는
  // 왼쪽 셀. 퇴실 칸과 같은 크기의 버튼 셀 하나에만 박스가 맞도록 한다.
  function findCheckInButton() {
    const el = findClickableByText(/입실\s*(하기|체크)?/) || findClickableByText(/정상\s*출석/);
    if (!el) return null;
    // 이미 클릭 가능한 셀이면 그대로, 아니면 셀 크기까지 올라가서 감싼다.
    if (el.matches && el.matches('button, a, [role="button"], [onclick]')) return el;
    return climbToBox(el, 50, 50, 240, 240);
  }

  function findCheckOutButton() {
    return findClickableByText(/퇴실\s*하기/);
  }

  // 출석 위젯(노란 박스) - 입실/퇴실 셀을 모두 못 찾을 때의 대체 강조 대상.
  function findAttendanceWidget() {
    const label = findClickableByText(/출석체크/);
    if (!label) return null;
    return climbToBox(label, 180, 90, 560, 460);
  }

  function isCheckedIn() {
    if (dev.enabled && dev.checkedIn === "true") return true;
    if (dev.enabled && dev.checkedIn === "false") return false;
    // 오늘 입실 클릭 기록이 있거나, "정상 출석" 문구/퇴실 버튼이 보이면 입실 완료
    return hasCheckinToday() || pageHasText(/정상\s*출석/) || !!findCheckOutButton();
  }

  // ── 오버레이 박스 ────────────────────────────────────────────────────
  // 버튼 요소에 outline만 주면 부모의 overflow에 잘리거나 안 보일 수 있어,
  // 버튼의 화면 위치에 맞춰 position:fixed 로 별도의 네모 박스를 겹쳐 그린다.
  const boxes = new Map(); // id -> { el, lbl, target }

  function ensureBox(id, target, tone, label) {
    if (!target) {
      removeBox(id);
      return;
    }
    let entry = boxes.get(id);
    if (!entry) {
      const el = document.createElement("div");
      el.className = "ssafy-alert-box";
      const lbl = document.createElement("div");
      lbl.className = "ssafy-alert-box-label";
      el.appendChild(lbl);
      document.documentElement.appendChild(el);
      entry = { el, lbl, target };
      boxes.set(id, entry);
    }
    entry.target = target;
    entry.el.dataset.tone = tone; // "danger" | "warn"
    entry.lbl.textContent = label || "";
    entry.lbl.style.display = label ? "block" : "none";
    positionBox(entry);
  }

  function removeBox(id) {
    const entry = boxes.get(id);
    if (entry) {
      entry.el.remove();
      boxes.delete(id);
    }
  }

  function positionBox(entry) {
    const t = entry.target;
    if (!t || !document.contains(t)) {
      entry.el.style.display = "none";
      return;
    }
    const r = t.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      entry.el.style.display = "none";
      return;
    }
    const pad = 6;
    entry.el.style.display = "block";
    entry.el.style.top = r.top - pad + "px";
    entry.el.style.left = r.left - pad + "px";
    entry.el.style.width = r.width + pad * 2 + "px";
    entry.el.style.height = r.height + pad * 2 + "px";
    // 화면 맨 위에 붙어 있으면 라벨을 박스 아래쪽에 표시
    entry.lbl.dataset.pos = r.top < 34 ? "below" : "above";
  }

  function positionAll() {
    boxes.forEach(positionBox);
  }

  window.addEventListener("scroll", positionAll, true);
  window.addEventListener("resize", positionAll);
  setInterval(positionAll, 300);

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

  // ── 입실 / 퇴실 클릭 기록 ─────────────────────────────────────────────
  //  - 입실: 한 번 누르면(=오늘 입실 완료) 09:00 이전이어도 더 이상 강조하지 않는다.
  //  - 퇴실: 미리 눌러도 되지만, 18:00 이후에 누른 기록이 있어야 정상 퇴실로
  //    인정된다. 18:00 이후 클릭이 생길 때까지 계속 강조한다.
  const CHECKIN_KEY = "ssafy-alert-last-checkin";
  const CHECKOUT_KEY = "ssafy-alert-last-checkout";

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function recordClick(key) {
    try {
      localStorage.setItem(key, JSON.stringify({ date: todayStr(), minutes: nowMinutes() }));
    } catch (e) {
      /* localStorage 사용 불가 시 무시 */
    }
  }

  function readRecord(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return rec.date === todayStr() ? rec : null;
    } catch (e) {
      return null;
    }
  }

  // 오늘 입실 버튼을 누른 기록이 있으면 입실 완료로 본다.
  function hasCheckinToday() {
    return !!readRecord(CHECKIN_KEY);
  }

  // 오늘 18:00 이후에 퇴실을 누른 기록이 있으면 정상 퇴실로 본다.
  function hasValidCheckoutToday() {
    const rec = readRecord(CHECKOUT_KEY);
    return !!rec && rec.minutes >= CHECK_OUT_START_MIN;
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

  function clickedInside(el, target) {
    return el && target instanceof Element && (el === target || el.contains(target));
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!(e.target instanceof Element)) return;

      // 퇴실 버튼 클릭
      const checkOutBtn = findCheckOutButton();
      if (clickedInside(checkOutBtn, e.target)) {
        recordClick(CHECKOUT_KEY);
        if (nowMinutes() < CHECK_OUT_START_MIN) {
          // 미리 누르는 것은 막지 않되, 18시 이후에 다시 눌러야 함을 안내
          showToast("ℹ️ 지금 퇴실을 눌러도 괜찮지만, 18:00 이후에 한 번 더 눌러야 정상 퇴실로 인정됩니다!");
        }
        update();
        return;
      }

      // 입실 버튼 클릭 (입실 완료로 기록 → 이후 입실 강조 중단)
      const checkInBtn = findCheckInButton();
      if (clickedInside(checkInBtn, e.target)) {
        recordClick(CHECKIN_KEY);
        update();
      }
    },
    true
  );

  // ── 메인 상태 갱신 루프 ─────────────────────────────────────────────
  // 입실/퇴실 버튼 위에 항상 네모 박스를 겹쳐 그린다.
  //  - 입실 박스: 아직 입실 전이면 빨간색으로 표시 (09:00 이전엔 남은 시간 표시)
  //  - 퇴실 박스: 입실 완료 후 표시. 18:00 전엔 주황색("18시 이후에"),
  //              18:00 이후엔 빨간색("지금 퇴실")
  function update() {
    if (!isWeekday()) {
      removeBox("checkin");
      removeBox("checkout");
      hideBanner();
      return;
    }

    const now = nowMinutes();
    const checkedIn = isCheckedIn();

    // ── 입실 박스 ──
    if (!checkedIn) {
      const target = findCheckInButton() || findAttendanceWidget();
      if (now < CHECK_IN_DEADLINE_MIN) {
        const left = minutesLeftText(CHECK_IN_DEADLINE_MIN);
        ensureBox("checkin", target, "danger", `🚨 입실 체크! 09:00 마감 (${left})`);
        showBanner(`🚨 입실 체크를 하세요! 09:00 마감 (${left})`, "danger");
      } else {
        ensureBox("checkin", target, "danger", "⚠️ 입실 체크 안 됨! 지금 체크");
        showBanner("⚠️ 입실 체크가 안 되어 있습니다! 지금 바로 체크하세요.", "danger");
      }
      removeBox("checkout");
      return;
    }

    // ── 퇴실 박스 (입실 완료 상태) ──
    removeBox("checkin");
    const checkOutTarget = findCheckOutButton() || findAttendanceWidget();

    if (now >= CHECK_OUT_START_MIN) {
      // 18:00 이후: 아직 유효한 퇴실 기록이 없으면 빨간 박스로 강조
      if (!dev.enabled && hasValidCheckoutToday()) {
        removeBox("checkout");
        hideBanner();
        return;
      }
      ensureBox("checkout", checkOutTarget, "danger", "🚨 지금 퇴실하세요! (18시 이후)");
      showBanner("🚨 18시가 지났습니다! 지금 퇴실 버튼을 누르세요. (18시 이전 기록만으로는 조퇴 처리될 수 있어요)", "danger");
    } else {
      // 18:00 이전: 주황색 안내 박스 (미리 눌러도 되지만 18시 이후 재클릭 필요)
      const left = minutesLeftText(CHECK_OUT_START_MIN);
      ensureBox("checkout", checkOutTarget, "warn", `⏳ 퇴실은 18:00 이후에 (${left})`);
      hideBanner();
    }
  }

  // 주기 실행 + DOM 변경 감지
  loadDevSettings(update);
  setInterval(update, 15 * 1000);

  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(update, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
