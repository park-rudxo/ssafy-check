// 첫 설치 시 열리는 튜토리얼 + 초기 설정 마법사.
// 팝업과 같은 저장소 키(autoOpen, mattermost)를 쓰므로 여기서 설정한 값이
// 그대로 팝업에도 반영된다.
(() => {
  const SSAFY_HOME = "https://edu.ssafy.com/edu/main/index.do";

  const AUTO_OPEN_DEFAULTS = { enabled: true, minutesBefore: 5 };
  const MM_DEFAULTS = {
    enabled: false,
    webhookUrl: "",
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

  // Webhook 호스트는 사람마다 달라 manifest에 미리 넣을 수 없다.
  // optional_host_permissions로 두고, 입력한 그 호스트만 런타임에 요청한다.
  function ensureOriginPermission(url) {
    return new Promise((resolve) => {
      let pattern = null;
      try {
        const u = new URL(url);
        if (u.protocol === "https:") pattern = u.origin + "/*";
      } catch (e) {
        /* 잘못된 URL */
      }
      if (!pattern) {
        resolve({ ok: false, error: "https:// 로 시작하는 올바른 Webhook URL을 입력해주세요." });
        return;
      }
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
    const url = $("mm-url").value.trim();
    const target = readTarget();
    const channel = target.value;

    if (!url) {
      // 입력이 없으면 연동을 끈 상태로 저장한다 (건너뛰기와 같은 결과).
      mm = { ...mm, enabled: false, webhookUrl: "", channel };
      return save({ mattermost: mm }).then(() => ({ ok: true, skipped: true }));
    }

    // URL만 넣고 받을 곳을 비우면 웹훅 채널 전체에 알림이 가므로, 연동을 켜지
    // 않고 이 단계에 머물게 한다.
    if (!target.ok) {
      mm = { ...mm, enabled: false, webhookUrl: url, channel };
      return save({ mattermost: mm }).then(() => ({ ok: false, error: target.error }));
    }

    return ensureOriginPermission(url).then((perm) => {
      if (!perm.ok) {
        mm = { ...mm, enabled: false, webhookUrl: url, channel };
        return save({ mattermost: mm }).then(() => ({ ok: false, error: perm.error }));
      }
      mm = { ...mm, enabled: true, webhookUrl: url, channel };
      return save({ mattermost: mm }).then(() => ({ ok: true }));
    });
  }

  function testMattermost() {
    const btn = $("mm-test");
    if (!$("mm-url").value.trim()) {
      setStatus("Webhook URL을 먼저 입력해주세요.", "err");
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
    if (mm.enabled && mm.webhookUrl) {
      mmText = `<span class='on'>켜짐</span> — ${escapeHtml(mm.channel)} 개인 메시지`;
    } else if (mm.webhookUrl && !SsafyMattermost.isValidTarget(mm.channel)) {
      mmText = "<span class='off'>받을 곳 미입력</span> — 팝업에서 @내아이디를 넣으면 켜집니다";
    } else if (mm.webhookUrl) {
      mmText = "<span class='off'>권한 미허용</span> — 팝업에서 다시 시도할 수 있어요";
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
        $("mm-url").value = mm.webhookUrl;
        $("mm-channel").value = mm.channel;
        show(1);
      });
    } catch (e) {
      show(1);
    }
  }

  init();
})();
