// popup: 현재 상태 안내 + 개발자 모드(시간/입실상태 오버라이드, 효과 미리보기)
(() => {
  const DEV_DEFAULTS = { enabled: false, time: null, checkedIn: "auto", forceWeekday: false };
  let dev = { ...DEV_DEFAULTS };

  const AUTO_OPEN_DEFAULTS = { enabled: true, minutesBefore: 5 };
  let autoOpen = { ...AUTO_OPEN_DEFAULTS };

  // ── 시간 변환 유틸 ─────────────────────────────────────────────────
  function hhmmToMinutes(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(str || "");
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  function minutesToHhmm(min) {
    if (min == null) return "08:30";
    const h = String(Math.floor(min / 60)).padStart(2, "0");
    const m = String(min % 60).padStart(2, "0");
    return `${h}:${m}`;
  }

  // ── 상태 박스 갱신 ─────────────────────────────────────────────────
  function renderStatus() {
    const statusEl = document.getElementById("status");
    const now = new Date();
    const realWeekend = now.getDay() === 0 || now.getDay() === 6;

    const usingDevTime = dev.enabled && dev.time != null;
    const minutes = usingDevTime ? dev.time : now.getHours() * 60 + now.getMinutes();
    const weekend = dev.enabled && dev.forceWeekday ? false : realWeekend;
    const tag = dev.enabled ? " (미리보기)" : "";

    if (weekend) {
      statusEl.className = "status idle";
      statusEl.textContent = "😴 오늘은 주말입니다." + tag;
    } else if (minutes < 9 * 60) {
      const left = 9 * 60 - minutes;
      statusEl.className = "status danger";
      statusEl.textContent = `🚨 입실 체크 시간! 09:00까지 ${left}분 남음` + tag;
    } else if (minutes < 18 * 60) {
      const left = 18 * 60 - minutes;
      const h = Math.floor(left / 60);
      const m = left % 60;
      statusEl.className = "status ok";
      statusEl.textContent = `✅ 교육 시간 중 · 퇴실까지 ${h}시간 ${m}분` + tag;
    } else {
      statusEl.className = "status danger";
      statusEl.textContent = "🚨 18시 이후! 퇴실 버튼을 누르세요." + tag;
    }
  }

  // ── 개발자 모드 UI 동기화 ──────────────────────────────────────────
  function renderDevControls() {
    document.getElementById("dev-enabled").checked = dev.enabled;
    document.getElementById("dev-time").value = minutesToHhmm(dev.time);
    document.getElementById("dev-weekday").checked = dev.forceWeekday;
    document.querySelectorAll('input[name="checkedIn"]').forEach((r) => {
      r.checked = r.value === (dev.checkedIn || "auto");
    });

    // 개발자 모드 꺼져 있으면 세부 컨트롤 비활성화 표시
    ["field-time", "field-checkin", "field-weekday"].forEach((id) => {
      document.getElementById(id).classList.toggle("disabled", !dev.enabled);
    });
  }

  function save(cb) {
    try {
      chrome.storage.local.set({ ssafyDev: dev }, () => {
        renderStatus();
        renderDevControls();
        if (cb) cb();
      });
    } catch (e) {
      renderStatus();
      renderDevControls();
    }
  }

  // ── 자동 열기 ──────────────────────────────────────────────────────
  function renderAutoOpen() {
    document.getElementById("auto-open-enabled").checked = autoOpen.enabled;
    document.getElementById("auto-open-minutes").value = autoOpen.minutesBefore;
    document.getElementById("minutes-row").classList.toggle("disabled", !autoOpen.enabled);
  }

  function saveAutoOpen() {
    try {
      chrome.storage.local.set({ autoOpen: autoOpen }, renderAutoOpen);
    } catch (e) {
      renderAutoOpen();
    }
  }

  // ── 이벤트 바인딩 ──────────────────────────────────────────────────
  function bind() {
    // 섹션 펼치기/접기
    const header = document.getElementById("dev-header");
    const bodyEl = document.getElementById("dev-body");
    header.addEventListener("click", () => {
      const open = bodyEl.classList.toggle("open");
      header.classList.toggle("open", open);
    });

    document.getElementById("open-ssafy").addEventListener("click", () => {
      chrome.tabs.create({ url: "https://edu.ssafy.com/edu/main/index.do" });
    });

    document.getElementById("check-update").addEventListener("click", checkUpdate);

    // 자동 열기 설정
    document.getElementById("auto-open-enabled").addEventListener("change", (e) => {
      autoOpen.enabled = e.target.checked;
      saveAutoOpen();
    });
    document.getElementById("auto-open-minutes").addEventListener("change", (e) => {
      let n = parseInt(e.target.value, 10);
      if (isNaN(n)) n = 5;
      n = Math.max(0, Math.min(120, n));
      e.target.value = n;
      autoOpen.minutesBefore = n;
      saveAutoOpen();
    });

    document.getElementById("dev-enabled").addEventListener("change", (e) => {
      dev.enabled = e.target.checked;
      // 개발자 모드를 켤 때 입력창의 가상 시각을 실제 적용 값으로 반영한다.
      // (그렇지 않으면 time이 null로 남아 실제 시각으로 동작하는 버그가 있었음)
      if (dev.enabled && dev.time == null) {
        dev.time = hhmmToMinutes(document.getElementById("dev-time").value);
      }
      save();
    });

    document.getElementById("dev-time").addEventListener("input", (e) => {
      const min = hhmmToMinutes(e.target.value);
      if (min != null) {
        dev.time = min;
        save();
      }
    });

    document.getElementById("dev-weekday").addEventListener("change", (e) => {
      dev.forceWeekday = e.target.checked;
      save();
    });

    document.querySelectorAll('input[name="checkedIn"]').forEach((r) => {
      r.addEventListener("change", (e) => {
        if (e.target.checked) {
          dev.checkedIn = e.target.value;
          save();
        }
      });
    });

    // 원클릭 미리보기: 시나리오 전체를 한 번에 설정
    document.getElementById("preview-checkin").addEventListener("click", () => {
      dev = { enabled: true, time: 8 * 60 + 30, checkedIn: "false", forceWeekday: true };
      openDevSection();
      save();
    });
    document.getElementById("preview-checkout").addEventListener("click", () => {
      dev = { enabled: true, time: 18 * 60 + 30, checkedIn: "true", forceWeekday: true };
      openDevSection();
      save();
    });
    document.getElementById("preview-off").addEventListener("click", () => {
      dev = { ...DEV_DEFAULTS };
      save();
    });
  }

  function openDevSection() {
    document.getElementById("dev-body").classList.add("open");
    document.getElementById("dev-header").classList.add("open");
  }

  // ── 업데이트 확인 ──────────────────────────────────────────────────
  function checkUpdate() {
    const statusEl = document.getElementById("update-status");
    const btn = document.getElementById("check-update");
    statusEl.className = "update-status";
    statusEl.textContent = "확인 중...";
    btn.disabled = true;

    chrome.runtime.sendMessage({ type: "checkUpdate" }, (res) => {
      btn.disabled = false;
      if (chrome.runtime.lastError || !res) {
        statusEl.className = "update-status err";
        statusEl.textContent = "확인 실패. 잠시 후 다시 시도해주세요.";
        return;
      }
      if (!res.ok) {
        statusEl.className = "update-status err";
        statusEl.textContent = "확인 실패: " + (res.error || "알 수 없는 오류");
        return;
      }
      if (res.none) {
        statusEl.className = "update-status ok";
        statusEl.textContent = "아직 배포된 공지가 없어요.";
        return;
      }
      // 최신 Release(공지) 표시
      const title = res.name || res.tag || "새 업데이트";
      const notes = (res.body || "").trim();
      const notesHtml = notes ? `<div class="notes">${escapeHtml(notes)}</div>` : "";
      statusEl.className = "update-status " + (res.isNew ? "has-update" : "ok");
      const head = res.isNew ? `🆕 새 공지: ${escapeHtml(title)}` : `📢 최신 공지: ${escapeHtml(title)}`;
      statusEl.innerHTML =
        `${head}${notesHtml}` +
        `<div class="pull-hint">업데이트: <code>git pull</code> 후 확장 새로고침(🔄)</div>` +
        `<div><a href="${res.url}" target="_blank">릴리스 노트 자세히 보기</a></div>`;
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }

  // ── 초기화 ─────────────────────────────────────────────────────────
  function init() {
    bind();
    // 현재 버전 표시
    try {
      const v = chrome.runtime.getManifest().version;
      document.getElementById("version-label").textContent = "현재 버전 v" + v;
    } catch (e) {
      document.getElementById("version-label").textContent = "";
    }
    try {
      chrome.storage.local.get(["ssafyDev", "autoOpen"], (data) => {
        dev = { ...DEV_DEFAULTS, ...(data && data.ssafyDev) };
        // 켜진 상태인데 time이 비어 있으면 기본 가상 시각으로 채운다.
        if (dev.enabled && dev.time == null) dev.time = hhmmToMinutes("08:30");
        if (dev.enabled) openDevSection();
        autoOpen = { ...AUTO_OPEN_DEFAULTS, ...(data && data.autoOpen) };
        renderStatus();
        renderDevControls();
        renderAutoOpen();
      });
    } catch (e) {
      renderStatus();
      renderDevControls();
      renderAutoOpen();
    }
  }

  init();
})();
