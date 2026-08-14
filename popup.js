// popup: 현재 상태 안내 + 개발자 모드(시간/입실상태 오버라이드, 효과 미리보기)
(() => {
  // 웹스토어 빌드인지 여부. build-target.js 가 없더라도(로드 실패 등) 기존
  // 동작인 unpacked 로 떨어지게 두어, 업데이트 UI 가 사라지는 쪽으로 실수하지 않는다.
  const IS_WEBSTORE = self.BUILD_TARGET === "webstore";

  const DEV_DEFAULTS = { enabled: false, time: null, checkedIn: "auto", forceWeekday: false };
  let dev = { ...DEV_DEFAULTS };

  const AUTO_OPEN_DEFAULTS = { enabled: true, minutesBefore: 5 };
  let autoOpen = { ...AUTO_OPEN_DEFAULTS };

  const MM_DEFAULTS = {
    enabled: false,
    channel: "",
    webhookUrl: "",
    notifyCheckin: true,
    notifyCheckout: true,
    notifyMissing: true,
  };
  let mm = { ...MM_DEFAULTS };

  // offDays  : 사용자가 등록한 개인 휴무일(연차·공가 등)
  // workDays : 공휴일이지만 평일로 취급할 날 (공휴일 표가 틀렸을 때의 탈출구)
  const DAYOFF_DEFAULTS = { offDays: [], workDays: [] };
  let dayOff = { ...DAYOFF_DEFAULTS };

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
    const info = SsafyHolidays.dayInfo(now, dayOff);

    const usingDevTime = dev.enabled && dev.time != null;
    const minutes = usingDevTime ? dev.time : now.getHours() * 60 + now.getMinutes();
    const off = dev.enabled && dev.forceWeekday ? false : info.off;
    const tag = dev.enabled ? " (미리보기)" : "";

    if (off) {
      statusEl.className = "status idle";
      const what = info.reason === "personal" ? "등록해둔 휴무일" : info.label;
      statusEl.textContent = `😴 오늘은 ${what}입니다.` + tag;
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

  // ── 쉬는 날 ────────────────────────────────────────────────────────
  function saveDayOff() {
    try {
      chrome.storage.local.set({ dayOff: dayOff }, () => {
        renderDayOff();
        renderStatus();
      });
    } catch (e) {
      renderDayOff();
      renderStatus();
    }
  }

  function renderDayOff() {
    const todayKey = SsafyHolidays.toKey(new Date());
    const info = SsafyHolidays.dayInfo(new Date(), dayOff);
    const box = document.getElementById("dayoff-today");

    box.classList.toggle("off", info.off);
    box.textContent = "";

    if (info.reason === "holiday") {
      box.append(`오늘은 ${info.label}입니다. 강조와 알림이 꺼져 있어요. `);
      // 표가 틀렸거나 공휴일에도 출석해야 하는 경우를 위한 탈출구.
      const btn = document.createElement("button");
      btn.className = "btn-small";
      btn.textContent = "그래도 오늘 출석함";
      btn.addEventListener("click", () => {
        dayOff.workDays = [...new Set([...dayOff.workDays, todayKey])];
        saveDayOff();
      });
      box.append(btn);
    } else if (info.reason === "personal") {
      box.append("오늘은 등록해둔 휴무일이라 강조와 알림이 꺼져 있어요.");
    } else if (info.reason === "weekend") {
      box.append(`오늘은 ${info.label}이라 강조와 알림이 꺼져 있어요.`);
    } else if (dayOff.workDays.includes(todayKey)) {
      box.append("오늘은 공휴일이지만 평일로 취급하고 있어요. ");
      const btn = document.createElement("button");
      btn.className = "btn-small";
      btn.textContent = "되돌리기";
      btn.addEventListener("click", () => {
        dayOff.workDays = dayOff.workDays.filter((d) => d !== todayKey);
        saveDayOff();
      });
      box.append(btn);
    } else if (!SsafyHolidays.isCovered(todayKey)) {
      // 공휴일 표에 없는 연도. 조용히 넘어가면 공휴일에 헛알림이 가므로 알려준다.
      box.append(
        `${SsafyHolidays.coveredYears.max}년까지의 공휴일만 알고 있어요. ` +
          "확장을 업데이트하거나, 쉬는 날을 아래에 직접 등록해 주세요."
      );
    } else {
      box.append("오늘은 출석 체크가 필요한 날입니다.");
    }

    // 지난 날짜는 의미가 없으므로 정리하면서 그린다.
    const upcoming = dayOff.offDays.filter((d) => d >= todayKey).sort();
    const list = document.getElementById("dayoff-list");
    list.textContent = "";
    for (const d of upcoming) {
      const chip = document.createElement("span");
      chip.className = "dayoff-chip";
      chip.append(d === todayKey ? `${d} (오늘)` : d);
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "삭제";
      del.addEventListener("click", () => {
        dayOff.offDays = dayOff.offDays.filter((x) => x !== d);
        saveDayOff();
      });
      chip.append(del);
      list.append(chip);
    }
  }

  // ── Mattermost ─────────────────────────────────────────────────────
  function renderMattermost() {
    document.getElementById("mm-enabled").checked = mm.enabled;
    document.getElementById("mm-checkin").checked = mm.notifyCheckin;
    document.getElementById("mm-checkout").checked = mm.notifyCheckout;
    document.getElementById("mm-missing").checked = mm.notifyMissing;
    document.getElementById("mm-controls").classList.toggle("disabled", !mm.enabled);

    // 연결이 끝났으면 누구로 연결됐는지 보여준다. 아이디를 손으로 넣을 수
    // 없으므로, 이게 "제대로 내 계정에 붙었는지" 확인하는 유일한 창이다.
    const done = SsafyMattermost.isConfigured(mm);
    document.getElementById("mm-provision").textContent = done
      ? "✅ 다시 연결하기"
      : "🔗 Mattermost 로그인하여 시작하기";
    document.getElementById("mm-who").textContent = done
      ? `연결됨: ${mm.channel} — 내 전용 통로로 나에게만 갑니다.`
      : "";

    // 예전 버전에서 설정이 덜 된 채로 켜둔 값이 남아 있을 수 있다. 조용히
    // 안 오는 것보다 이유를 알려주는 편이 낫다.
    if (mm.enabled && !done) {
      setMmStatus("연결이 끝나지 않았어요. 위 버튼을 눌러주세요.", "err");
    }

    renderSetupGate();
  }

  function saveMattermost() {
    try {
      chrome.storage.local.set({ mattermost: mm }, renderMattermost);
    } catch (e) {
      renderMattermost();
    }
  }

  function setMmStatus(text, kind) {
    const el = document.getElementById("mm-status");
    el.className = "update-status" + (kind ? " " + kind : "");
    el.textContent = text;
  }

  // 웹훅 호스트 권한은 optional_host_permissions로 두고, 사용자가 연동을 켤 때
  // 그 순간에만 요청한다. 설치할 때부터 권한을 달라고 하면 쓰지도 않을 사람에게
  // 겁주는 안내가 뜬다. (권한이 없으면 서비스 워커의 fetch가 CORS로 막힌다)
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

  // 내 계정으로 웹훅을 만들고 아이디까지 채워 넣는다. 실패하면 오류만 알리고
  // 기존 설정은 건드리지 않는다 - 이미 연결돼 있던 사람이 재시도했다가
  // 오히려 연결을 잃으면 안 된다.
  function provisionMattermost() {
    const btn = document.getElementById("mm-provision");
    btn.disabled = true;
    setMmStatus("Mattermost에서 설정을 만드는 중...");

    ensureOriginPermission().then((perm) => {
      if (!perm.ok) {
        btn.disabled = false;
        setMmStatus(perm.error, "err");
        return;
      }
      SsafyMattermost.provisionPersonalWebhook()
        .then((res) => {
          mm.webhookUrl = res.webhookUrl;
          mm.channel = res.channel;
          // 여기까지 왔으면 보낼 곳도 보낼 대상도 확정이다. 따로 켜게 두면
          // 연결만 해놓고 안 켠 상태로 남아 아무것도 안 오는 사람이 생긴다.
          mm.enabled = true;
          saveMattermost();
          btn.disabled = false;
          setMmStatus(`✅ ${res.channel} 로 연결했어요. 테스트 메시지를 보내 확인해보세요.`, "ok");
        })
        .catch((e) => {
          btn.disabled = false;
          setMmStatus(e && e.message ? e.message : "자동 설정에 실패했어요.", e && e.blocked ? "" : "err");
        });
    });
  }

  function testMattermost() {
    const btn = document.getElementById("mm-test");
    if (!SsafyMattermost.isConfigured(mm)) {
      setMmStatus("먼저 [Mattermost 로그인하여 시작하기]를 눌러 연결해주세요.", "err");
      return;
    }
    btn.disabled = true;
    setMmStatus("보내는 중...");

    ensureOriginPermission().then((perm) => {
      if (!perm.ok) {
        btn.disabled = false;
        setMmStatus(perm.error, "err");
        return;
      }
      chrome.runtime.sendMessage({ type: "mattermostTest" }, (res) => {
        btn.disabled = false;
        if (chrome.runtime.lastError || !res) {
          setMmStatus("전송 실패. 잠시 후 다시 시도해주세요.", "err");
          return;
        }
        if (!res.ok) {
          setMmStatus("전송 실패: " + (res.error || "알 수 없는 오류"), "err");
          return;
        }
        setMmStatus(`✅ ${mm.channel} 로 테스트를 보냈어요. Mattermost에 도착했는지 확인하세요.`, "ok");
      });
    });
  }

  // ── 설정 필수 게이트 ───────────────────────────────────────────────
  // 설정을 마치기 전에는 화면 강조도 켜지지 않으므로(content.js), 팝업에서도
  // 그 사실을 분명히 알리고 곧장 설정으로 데려간다.
  function renderSetupGate() {
    const done = SsafyMattermost.isConfigured(mm);
    document.getElementById("setup-gate").hidden = done;
    // 설정이 안 됐으면 Mattermost 섹션을 펼쳐둔다. 접혀 있으면 "설정하라"는
    // 말만 보이고 설정할 곳은 안 보인다.
    if (!done) openMattermostSection();
  }

  function openMattermostSection() {
    document.getElementById("mm-body").classList.add("open");
    document.getElementById("mm-header").classList.add("open");
  }

  function openMattermostHome() {
    try {
      chrome.tabs.create({ url: SsafyMattermost.HOME_URL });
    } catch (e) {
      /* 탭을 열 수 없는 상황이면 무시 */
    }
  }

  // ── 진단 로그 ──────────────────────────────────────────────────────
  // 이 확장의 실패는 거의 다 "아무 일도 안 일어남"으로 보인다. 어디서 멈췄는지
  // 사용자가 통째로 복사해 보낼 수 있어야 원인을 좁힐 수 있다.
  function renderDebugLog() {
    SsafyDebug.read().then((lines) => {
      const el = document.getElementById("dbg-text");
      el.value = lines.length ? lines.join("\n") : "아직 기록이 없습니다.";
      // 최근 것이 아래에 쌓이므로 열자마자 끝을 보여준다.
      el.scrollTop = el.scrollHeight;
    });
  }

  function setDebugStatus(text) {
    document.getElementById("dbg-status").textContent = text;
  }

  function copyDebugLog() {
    const el = document.getElementById("dbg-text");
    navigator.clipboard.writeText(el.value).then(
      () => setDebugStatus("복사했어요. 그대로 붙여넣어 보내주세요."),
      () => {
        // 클립보드 권한이 막힌 환경에서는 직접 고르게 해준다.
        el.removeAttribute("readonly");
        el.select();
        el.setAttribute("readonly", "");
        setDebugStatus("복사가 막혀 있어요. Ctrl+C 를 눌러주세요.");
      }
    );
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

    document.getElementById("reload-now").addEventListener("click", () => {
      chrome.runtime.reload(); // 디스크의 최신 파일로 확장을 다시 읽어들인다
    });

    document.getElementById("open-welcome").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "openWelcome" }, () => window.close());
    });

    // 웹스토어 빌드에는 업데이트.bat 이 없고 갱신도 크롬이 알아서 하므로
    // 업데이트 확인 버튼 자체를 두지 않는다. (build-target.js 참고)
    if (IS_WEBSTORE) {
      document.getElementById("check-update").hidden = true;
      // "다운로드 페이지"는 zip 을 받아 설치하는 사람에게만 해당한다.
      document.getElementById("release-link").textContent = "📢 릴리스 노트 보기";
    } else {
      document.getElementById("check-update").addEventListener("click", checkUpdate);
    }

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

    // 쉬는 날 등록
    const dayoffDate = document.getElementById("dayoff-date");
    dayoffDate.value = SsafyHolidays.toKey(new Date());
    document.getElementById("dayoff-add").addEventListener("click", () => {
      const v = dayoffDate.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      dayOff.offDays = [...new Set([...dayOff.offDays, v])];
      // 평일 취급 예외와 동시에 등록되면 헷갈리므로 정리한다.
      dayOff.workDays = dayOff.workDays.filter((d) => d !== v);
      saveDayOff();
    });

    // Mattermost 설정
    const mmHeader = document.getElementById("mm-header");
    const mmBody = document.getElementById("mm-body");
    mmHeader.addEventListener("click", () => {
      const open = mmBody.classList.toggle("open");
      mmHeader.classList.toggle("open", open);
    });

    document.getElementById("mm-enabled").addEventListener("change", (e) => {
      const on = e.target.checked;
      if (!on) {
        mm.enabled = false;
        saveMattermost();
        setMmStatus("");
        return;
      }
      // 켤 때 Webhook 호스트 권한을 함께 요청한다 (체크박스 클릭이 사용자 제스처).
      // 스위치 자체는 일단 켜준다. 여기서 도로 꺼버리면 설정 칸이 다시
      // 잠겨(.mm-controls.disabled) 연결 버튼을 누를 방법이 없어진다.
      ensureOriginPermission().then((perm) => {
        if (!perm.ok) {
          mm.enabled = false;
          e.target.checked = false;
          saveMattermost();
          setMmStatus(perm.error, "err");
          return;
        }
        mm.enabled = true;
        saveMattermost();
        // 아직 연결 전이면 연결부터 시킨다. 이미 연결돼 있으면 바로 테스트해서
        // 실제로 도착하는지 확인하게 한다 - 확인을 미루면 정작 필요한 날
        // 아무것도 안 오는 걸로 알게 된다.
        if (SsafyMattermost.isConfigured(mm)) testMattermost();
        else provisionMattermost();
      });
    });

    [
      ["mm-checkin", "notifyCheckin"],
      ["mm-checkout", "notifyCheckout"],
      ["mm-missing", "notifyMissing"],
    ].forEach(([id, key]) => {
      document.getElementById(id).addEventListener("change", (e) => {
        mm[key] = e.target.checked;
        saveMattermost();
      });
    });

    document.getElementById("setup-gate-go").addEventListener("click", openMattermostSection);
    document.getElementById("mm-open").addEventListener("click", openMattermostHome);

    // 진단 로그
    const dbgHeader = document.getElementById("dbg-header");
    const dbgBody = document.getElementById("dbg-body");
    dbgHeader.addEventListener("click", () => {
      const open = dbgBody.classList.toggle("open");
      dbgHeader.classList.toggle("open", open);
      if (open) renderDebugLog();
    });
    document.getElementById("dbg-copy").addEventListener("click", copyDebugLog);
    document.getElementById("dbg-clear").addEventListener("click", () => {
      SsafyDebug.clear().then(() => {
        renderDebugLog();
        setDebugStatus("지웠어요. 이제 다시 재현해보세요.");
      });
    });

    document.getElementById("mm-provision").addEventListener("click", provisionMattermost);
    document.getElementById("mm-test").addEventListener("click", testMattermost);

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

  // ── 받아둔 업데이트 적용 ───────────────────────────────────────────
  // 업데이트.bat(git pull)으로 디스크의 파일은 바뀌었지만 확장은 아직 예전
  // 버전으로 돌고 있는 상태를 감지한다. 메모리에 로드된 manifest 버전과
  // 디스크에서 새로 읽은 manifest 버전을 비교하면 알 수 있다.
  // chrome.runtime.reload()가 디스크에서 다시 읽어들이므로, 사용자가
  // chrome://extensions 까지 갈 필요가 없어진다.
  function checkPendingReload() {
    // 웹스토어 설치본은 크롬이 확장을 통째로 교체하고 다시 시작하므로
    // 메모리와 디스크의 버전이 갈릴 일이 없다. 확인할 이유가 없다.
    if (IS_WEBSTORE) return;

    let loaded;
    try {
      loaded = chrome.runtime.getManifest().version;
    } catch (e) {
      return;
    }
    fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })
      .then((res) => res.json())
      .then((onDisk) => {
        if (!onDisk || !onDisk.version || onDisk.version === loaded) return;
        document.getElementById("reload-ver").textContent = "v" + onDisk.version;
        document.getElementById("reload-notice").hidden = false;
      })
      .catch(() => {
        /* 읽지 못하면 그냥 안내를 띄우지 않는다 */
      });
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
      // 갱신 방법 안내는 zip 으로 설치한 사람에게만 해당한다. 웹스토어에서는
      // 업데이트.bat 이 없으므로 안내하면 없는 파일을 가리키게 된다.
      // (웹스토어 빌드는 버튼 자체가 없어 여기까지 오지 않지만, 나중에 버튼을
      //  되살리더라도 잘못된 안내가 새어나가지 않도록 여기서도 막아둔다)
      const hintHtml = IS_WEBSTORE
        ? ""
        : `<div class="pull-hint">업데이트: <code>업데이트.bat</code> 실행 후 위에 뜨는 <b>[지금 적용하기]</b></div>`;
      statusEl.innerHTML =
        `${head}${notesHtml}` +
        hintHtml +
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
    checkPendingReload();
    // 현재 버전 표시
    try {
      const v = chrome.runtime.getManifest().version;
      document.getElementById("version-label").textContent = "현재 버전 v" + v;
    } catch (e) {
      document.getElementById("version-label").textContent = "";
    }
    try {
      chrome.storage.local.get(["ssafyDev", "autoOpen", "mattermost", "dayOff"], (data) => {
        dev = { ...DEV_DEFAULTS, ...(data && data.ssafyDev) };
        // 켜진 상태인데 time이 비어 있으면 기본 가상 시각으로 채운다.
        if (dev.enabled && dev.time == null) dev.time = hhmmToMinutes("08:30");
        if (dev.enabled) openDevSection();
        autoOpen = { ...AUTO_OPEN_DEFAULTS, ...(data && data.autoOpen) };
        mm = { ...MM_DEFAULTS, ...(data && data.mattermost) };
        dayOff = { ...DAYOFF_DEFAULTS, ...(data && data.dayOff) };
        if (mm.enabled) {
          document.getElementById("mm-body").classList.add("open");
          document.getElementById("mm-header").classList.add("open");
        }
        renderStatus();
        renderDevControls();
        renderAutoOpen();
        renderMattermost();
        renderDayOff();
      });
    } catch (e) {
      renderStatus();
      renderDevControls();
      renderAutoOpen();
      renderMattermost();
      renderDayOff();
    }
  }

  init();
})();
