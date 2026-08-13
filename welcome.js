// 첫 설치 시 열리는 튜토리얼 + 초기 설정 마법사.
// 팝업과 같은 저장소 키(autoOpen, mattermost)를 쓰므로 여기서 설정한 값이
// 그대로 팝업에도 반영된다.
(() => {
  const SSAFY_HOME = "https://edu.ssafy.com/edu/main/index.do";

  const AUTO_OPEN_DEFAULTS = { enabled: true, minutesBefore: 5 };
  const MM_DEFAULTS = {
    enabled: false,
    channel: "",
    notifyCheckin: true,
    notifyCheckout: true,
    notifyMissing: true,
  };

  let autoOpen = { ...AUTO_OPEN_DEFAULTS };
  let mm = { ...MM_DEFAULTS };
  let step = 1;

  const $ = (id) => document.getElementById(id);

  // ── 단계 이동 ──────────────────────────────────────────────────────
  function show(n) {
    step = n;
    document.querySelectorAll("[data-panel]").forEach((p) => {
      p.hidden = Number(p.dataset.panel) !== n;
    });
    document.querySelectorAll("#steps li").forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle("active", s === n);
      li.classList.toggle("done", s < n);
    });
    if (n === 4) renderSummary();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── 저장 ───────────────────────────────────────────────────────────
  function save(patch) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(patch, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  function saveAutoOpen() {
    autoOpen.enabled = $("ao-enabled").checked;
    let n = parseInt($("ao-min").value, 10);
    if (isNaN(n)) n = 5;
    autoOpen.minutesBefore = Math.max(0, Math.min(120, n));
    $("ao-min").value = autoOpen.minutesBefore;
    $("ao-row").classList.toggle("off", !autoOpen.enabled);
    return save({ autoOpen });
  }

  // ── Mattermost ─────────────────────────────────────────────────────
  // 받을 곳은 반드시 "@아이디"(개인 메시지)여야 한다. 비워두면 웹훅 채널에
  // 있는 사람 전원에게 알림이 가버린다.
  function readTarget() {
    const el = $("mm-channel");
    const res = SsafyMattermost.normalizeTarget(el.value);
    el.value = res.value; // 실제로 저장될 형태를 보여준다
    return res;
  }

  function setStatus(text, kind) {
    const el = $("mm-status");
    el.className = "status" + (kind ? " " + kind : "");
    el.textContent = text;
  }

  // 웹훅 호스트 권한은 optional_host_permissions로 두고, 연동을 켜는 이 단계에서만
  // 요청한다. 설치할 때부터 달라고 하면 쓰지도 않을 사람에게 겁주는 안내가 뜬다.
  function ensureOriginPermission() {
    return new Promise((resolve) => {
      const pattern = SsafyMattermost.WEBHOOK_ORIGIN;
      chrome.permissions.contains({ origins: [pattern] }, (has) => {
        if (has) {
          resolve({ ok: true });
          return;
        }
        chrome.permissions.request({ origins: [pattern] }, (granted) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(granted ? { ok: true } : { ok: false, error: "권한을 허용해야 메시지를 보낼 수 있어요." });
        });
      });
    });
  }

  // 화면의 값을 저장하고, 권한까지 받아 실제로 보낼 수 있는 상태로 만든다.
  function applyMattermost() {
    const target = readTarget();
    const channel = target.value;

    if (!channel) {
      // 아무것도 안 적었으면 "나중에 할게요"와 같은 뜻으로 보고 넘어간다.
      // 이 단계는 선택이므로 빈 칸 때문에 설치를 막지는 않는다.
      mm = { ...mm, enabled: false, channel: "" };
      return save({ mattermost: mm }).then(() => ({ ok: true, skipped: true }));
    }

    // 적기는 했는데 아이디 형식이 아니면 이 단계에 머물러 고치게 한다.
    if (!target.ok) {
      mm = { ...mm, enabled: false, channel };
      return save({ mattermost: mm }).then(() => ({ ok: false, error: target.error }));
    }

    return ensureOriginPermission().then((perm) => {
      if (!perm.ok) {
        mm = { ...mm, enabled: false, channel };
        return save({ mattermost: mm }).then(() => ({ ok: false, error: perm.error }));
      }
      mm = { ...mm, enabled: true, channel };
      return save({ mattermost: mm }).then(() => ({ ok: true }));
    });
  }

  function testMattermost() {
    const btn = $("mm-test");
    // 받을 사람이 없으면 보낼 곳도 없다. 건너뛰기로 넘어가지 않도록 여기서 막는다.
    const target = readTarget();
    if (!target.ok) {
      setStatus(target.error, "err");
      return;
    }
    btn.disabled = true;
    setStatus("보내는 중...", "busy");

    applyMattermost().then((res) => {
      if (!res.ok) {
        btn.disabled = false;
        setStatus(res.error, "err");
        return;
      }
      chrome.runtime.sendMessage({ type: "mattermostTest" }, (r) => {
        btn.disabled = false;
        if (chrome.runtime.lastError || !r) {
          setStatus("전송 실패. 잠시 후 다시 시도해주세요.", "err");
          return;
        }
        if (!r.ok) {
          setStatus("전송 실패: " + (r.error || "알 수 없는 오류"), "err");
          return;
        }
        setStatus(`✅ 보냈어요! ${mm.channel} 개인 메시지를 확인해보세요.`, "ok");
      });
    });
  }

  // ── 완료 화면 요약 ─────────────────────────────────────────────────
  function renderSummary() {
    const rows = [];
    rows.push([
      "화면 강조",
      "<span class='on'>켜짐</span> — SSAFY 페이지에서 자동 동작",
    ]);
    rows.push(["크롬 알림", "<span class='on'>켜짐</span> — 08:50 · 17:50"]);
    rows.push([
      "홈 자동 열기",
      autoOpen.enabled
        ? `<span class='on'>켜짐</span> — ${autoOpen.minutesBefore}분 전`
        : "<span class='off'>꺼짐</span>",
    ]);

    let mmText = "<span class='off'>연동 안 함</span>";
    if (mm.enabled) {
      mmText = `<span class='on'>켜짐</span> — ${escapeHtml(mm.channel)} 개인 메시지`;
    } else if (mm.channel) {
      // 아이디는 적었는데 못 켠 경우 (권한 미허용, 형식 오류)
      mmText = "<span class='off'>안 켜짐</span> — 팝업에서 다시 시도할 수 있어요";
    }
    rows.push(["Mattermost", mmText]);

    $("summary").innerHTML = rows
      .map(([k, v]) => `<div class="row"><b>${k}</b><span>${v}</span></div>`)
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── 초기화 ─────────────────────────────────────────────────────────
  function bind() {
    document.querySelectorAll("[data-go]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const to = Number(btn.dataset.go);
        // 2단계를 떠날 때는 입력한 값을 반영하고 넘어간다.
        if (step === 2) saveAutoOpen();
        show(to);
      });
    });

    $("ao-enabled").addEventListener("change", saveAutoOpen);
    $("ao-min").addEventListener("change", saveAutoOpen);

    $("mm-test").addEventListener("click", testMattermost);
    $("mm-next").addEventListener("click", () => {
      applyMattermost().then((res) => {
        if (!res.ok) {
          setStatus(res.error, "err");
          return; // 권한을 못 받았으면 이 단계에 머물러 다시 시도하게 한다
        }
        show(4);
      });
    });

    $("finish").addEventListener("click", () => {
      chrome.tabs.create({ url: SSAFY_HOME });
    });
  }

  function init() {
    bind();
    try {
      chrome.storage.local.get(["autoOpen", "mattermost"], (data) => {
        autoOpen = { ...AUTO_OPEN_DEFAULTS, ...(data && data.autoOpen) };
        mm = { ...MM_DEFAULTS, ...(data && data.mattermost) };
        $("ao-enabled").checked = autoOpen.enabled;
        $("ao-min").value = autoOpen.minutesBefore;
        $("ao-row").classList.toggle("off", !autoOpen.enabled);
        $("mm-channel").value = mm.channel;
        show(1);
      });
    } catch (e) {
      show(1);
    }
  }

  init();
})();
