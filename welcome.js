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
    // 1단계(Mattermost 연결)를 마치기 전에는 다음으로 갈 수 없다. 이 판정을
    // 여기 한 곳에 두면 어느 경로로 오든 같은 규칙이 적용된다.
    if (n !== 1 && !SsafyMattermost.isConfigured(mm)) n = 1;
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
  // 연결이 끝났으면 누구로 붙었는지 보여준다. 아이디를 손으로 넣을 수 없으니
  // 이게 "내 계정에 제대로 붙었는지" 확인하는 유일한 창이다.
  function renderMattermost() {
    const done = SsafyMattermost.isConfigured(mm);
    $("mm-provision").textContent = done ? "✅ 다시 연결하기" : "🔗 내 계정 연결하기";
    $("mm-who").textContent = done ? `연결됨: ${mm.channel} — 내 전용 통로로 나에게만 갑니다.` : "";
    // 연결 전에는 보낼 곳이 없다. 눌러도 실패만 하는 버튼을 열어두면
    // 순서가 있다는 것 자체가 안 보인다.
    $("mm-test").disabled = !done;
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

  // 내 계정으로 웹훅을 만들고 아이디까지 서버에서 읽어온다. 여기까지 성공하면
  // 보낼 곳도 보낼 대상도 확정이므로 연동을 함께 켠다 - 따로 켜게 두면
  // 연결만 해놓고 안 켠 채로 아무것도 못 받는 사람이 생긴다.
  function provisionMattermost() {
    const btn = $("mm-provision");
    btn.disabled = true;
    setStatus("Mattermost에 연결하는 중...", "busy");

    return ensureOriginPermission()
      .then((perm) => {
        if (!perm.ok) throw new Error(perm.error);
        return SsafyMattermost.provisionPersonalWebhook();
      })
      .then((res) => {
        mm = { ...mm, webhookUrl: res.webhookUrl, channel: res.channel, enabled: true };
        return save({ mattermost: mm }).then(() => {
          btn.disabled = false;
          renderMattermost();
          setStatus(`✅ ${res.channel} 로 연결했어요. 이제 테스트 메시지를 보내보세요.`, "ok");
        });
      })
      .catch((e) => {
        btn.disabled = false;
        setStatus(e && e.message ? e.message : "연결에 실패했어요.", "err");
      });
  }

  // 실제로 한 통 보내본다. 연결이 됐다는 것과 메시지가 도착한다는 것은 다른
  // 얘기라(폰 알림 설정 등), 도착 여부는 사람이 눈으로 확인해야 한다.
  // 성공하면 true 로 resolve 한다 (다음 단계로 넘어가도 되는지 판단용).
  function testMattermost() {
    const btn = $("mm-test");
    if (!SsafyMattermost.isConfigured(mm)) {
      setStatus("먼저 [내 계정 연결하기]를 눌러주세요.", "err");
      return Promise.resolve(false);
    }
    btn.disabled = true;
    setStatus("보내는 중...", "busy");

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

    const mmText = SsafyMattermost.isConfigured(mm)
      ? `<span class='on'>연결됨</span> — ${escapeHtml(mm.channel)} 개인 메시지 (내 전용 통로)`
      : "<span class='off'>연결 안 됨</span> — 팝업에서 다시 시도할 수 있어요";
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
        // 알림 단계(3)를 떠날 때는 입력한 값을 반영하고 넘어간다.
        if (step === 3) saveAutoOpen();
        show(to);
      });
    });

    $("ao-enabled").addEventListener("change", saveAutoOpen);
    $("ao-min").addEventListener("change", saveAutoOpen);

    $("mm-provision").addEventListener("click", provisionMattermost);
    $("mm-test").addEventListener("click", testMattermost);
    $("mm-next").addEventListener("click", () => {
      // 이 단계는 건너뛸 수 없다. 여기를 마치지 않으면 화면 강조까지 꺼진
      // 채로 설치가 끝나서, 사용자는 "설치했는데 아무 일도 안 일어난다"만
      // 겪게 된다.
      if (!SsafyMattermost.isConfigured(mm)) {
        setStatus("이 단계는 건너뛸 수 없어요. [내 계정 연결하기]를 눌러주세요.", "err");
        return;
      }
      // 실제로 보내진 뒤에만 넘어간다. 확인을 미루면 정작 필요한 날
      // 아무것도 안 오는 걸로 알게 된다.
      testMattermost().then((sent) => {
        if (sent) show(2);
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
        renderMattermost();
        show(1);
      });
    } catch (e) {
      show(1);
    }
  }

  init();
})();
