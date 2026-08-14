// 첫 설치 시 열리는 튜토리얼 + 초기 설정 마법사.
// 팝업과 같은 저장소 키(autoOpen, mattermost)를 쓰므로 여기서 설정한 값이
// 그대로 팝업에도 반영된다.
(() => {
  const SSAFY_HOME = "https://edu.ssafy.com/edu/main/index.do";

  const AUTO_OPEN_DEFAULTS = { enabled: true, minutesBefore: 5 };
  const MM_DEFAULTS = {
    enabled: false,
    channel: "",
    webhookUrl: "",
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

  // 내 계정으로 개인 웹훅을 만들고 아이디 칸까지 채운다.
  // 실패해도 이 단계가 막히면 안 되므로, 아이디를 직접 넣는 길은 그대로 둔다.
  function provisionMattermost() {
    const btn = $("mm-provision");
    btn.disabled = true;
    setStatus("Mattermost에서 설정을 만드는 중...");

    return ensureOriginPermission()
      .then((perm) => {
        if (!perm.ok) throw new Error(perm.error);
        return SsafyMattermost.provisionPersonalWebhook();
      })
      .then((res) => {
        mm = { ...mm, webhookUrl: res.webhookUrl, channel: res.channel };
        $("mm-channel").value = res.channel;
        return save({ mattermost: mm }).then(() => {
          btn.disabled = false;
          btn.textContent = "✅ 내 계정으로 설정됨";
          setStatus(`✅ ${res.channel} 로 설정했어요. 이제 테스트 메시지를 보내보세요.`, "ok");
        });
      })
      .catch((e) => {
        btn.disabled = false;
        setStatus(
          (e && e.message ? e.message : "자동 설정에 실패했어요.") + " 아이디를 직접 넣어도 됩니다.",
          e && e.blocked ? "" : "err"
        );
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

  // 저장 → 권한 → 테스트 전송까지 한 번에. 아이디가 맞는지는 "도착했는지
  // 보는 것" 말고 확인할 방법이 없어서, 설정하자마자 바로 보내본다.
  // 성공하면 true 로 resolve 한다 (다음 단계로 넘어가도 되는지 판단용).
  function testMattermost() {
    const btn = $("mm-test");
    const target = readTarget();
    if (!target.ok) {
      setStatus(target.error, "err");
      return Promise.resolve(false);
    }
    btn.disabled = true;
    setStatus("보내는 중...", "busy");

    return applyMattermost().then((res) => {
      if (!res.ok) {
        btn.disabled = false;
        setStatus(res.error, "err");
        return false;
      }
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "mattermostTest" }, (r) => {
          btn.disabled = false;
          if (chrome.runtime.lastError || !r) {
            setStatus("전송 실패. 잠시 후 다시 시도해주세요.", "err");
            resolve(false);
            return;
          }
          if (!r.ok) {
            setStatus("전송 실패: " + (r.error || "알 수 없는 오류"), "err");
            resolve(false);
            return;
          }
          setStatus(`✅ ${mm.channel} 로 보냈어요. Mattermost에 도착했는지 확인하세요.`, "ok");
          resolve(true);
        });
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

    $("mm-provision").addEventListener("click", provisionMattermost);
    $("mm-test").addEventListener("click", testMattermost);
    $("mm-next").addEventListener("click", () => {
      // 아무것도 안 적었으면 연동 없이 넘어간다 (이 단계는 선택).
      if (!$("mm-channel").value.trim()) {
        applyMattermost().then(() => show(4));
        return;
      }
      // 아이디를 적었으면 저장·권한·테스트 전송까지 하고, 실제로 보내진
      // 뒤에만 넘어간다. 아이디가 틀렸는지 확인할 방법은 도착 여부뿐이라
      // 확인을 미루면 정작 필요한 날 아무것도 안 오는 걸로 알게 된다.
      testMattermost().then((sent) => {
        if (sent) show(4);
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
        if (mm.webhookUrl) $("mm-provision").textContent = "✅ 내 계정으로 설정됨";
        show(1);
      });
    } catch (e) {
      show(1);
    }
  }

  init();
})();
