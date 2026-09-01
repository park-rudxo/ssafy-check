// SSAFY 출석 체크 알리미 - 콘텐츠 스크립트
// 규칙:
//  - 입실: 평일 08:00부터 열리며, 09:00 이전에 반드시 입실 체크 (08:59까지)
//  - 퇴실: 반드시 18:00 이후에 퇴실 버튼 클릭 (그 전에 누르면 조퇴 처리 위험)
//  - 18:30 부터는 강조를 전부 끈다 (아래 ALERT_END_MIN)

(() => {
  "use strict";

  const CHECK_IN_START_MIN = 8 * 60; // 08:00 - 실제 SSAFY 입실 체크는 이 시각부터 열린다.
  const CHECK_IN_DEADLINE_MIN = 9 * 60; // 09:00
  const CHECK_OUT_START_MIN = 18 * 60; // 18:00
  // 18:30 - 하루 일과가 끝나는 시각. 이 시각부터는 강조를 전부 끈다.
  // 이때를 넘기면 입실이든 퇴실이든 지금 눌러서 되돌릴 수 있는 게 없어서,
  // 남는 것은 저녁에 개인 용무로 edu.ssafy.com 에 들어온 화면을 붉게 덮는
  // 헛경고뿐이다.
  const ALERT_END_MIN = 18 * 60 + 30;
  const BANNER_ID = "ssafy-alert-banner";
  const BOX_CLASS = "ssafy-alert-box";
  // 우리가 페이지에 그려 넣은 것들. 페이지 텍스트를 훑을 때 반드시 제외해야 한다.
  const OURS_SELECTOR = "#" + BANNER_ID + ", ." + BOX_CLASS;

  // ── 개발자 모드 설정 ─────────────────────────────────────────────────
  // popup에서 chrome.storage.local에 저장한 값을 읽어, 시간/입실상태/요일을
  // 오버라이드해서 실제 시간과 무관하게 강조 효과를 미리 볼 수 있게 한다.
  //   enabled      : 개발자 모드 on/off
  //   time         : 가상 현재 시각(분, 0~1439) / null이면 실제 시각 사용
  //   checkedIn    : "auto" | "true"(입실완료) | "false"(입실전)
  //   forceWeekday : 주말·공휴일에도 평일처럼 동작시키기
  const DEV_DEFAULTS = { enabled: false, time: null, checkedIn: "auto", forceWeekday: false };
  let dev = { ...DEV_DEFAULTS };

  // 쉬는 날 설정: 사용자가 팝업에서 등록한 개인 휴무일(연차·공가)과,
  // 공휴일 판정을 무시하고 평일로 취급할 날짜.
  const DAYOFF_DEFAULTS = { offDays: [], workDays: [] };
  let dayOff = { ...DAYOFF_DEFAULTS };

  // Mattermost 연동 설정. 이 확장은 설정을 마치기 전까지 아무것도 강조하지
  // 않으므로(아래 update 참고), 페이지에서도 이 값을 알아야 한다.
  let mm = null;

  // 이 브라우저에 연결된 주인(=처음 이 확장으로 출석을 본 에듀싸피 계정).
  // 백그라운드가 정해서 저장하고, 여기서는 읽기만 한다. (아래 pageAccount 참고)
  let eduAccount = null;

  function loadDevSettings(cb) {
    try {
      chrome.storage.local.get(["ssafyDev", "dayOff", "mattermost", "eduAccount"], (data) => {
        dev = { ...DEV_DEFAULTS, ...(data && data.ssafyDev) };
        dayOff = { ...DAYOFF_DEFAULTS, ...(data && data.dayOff) };
        mm = (data && data.mattermost) || null;
        eduAccount = (data && data.eduAccount) || null;
        if (cb) cb();
      });
    } catch (e) {
      if (cb) cb();
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!changes.ssafyDev && !changes.dayOff && !changes.mattermost && !changes.eduAccount) return;
      if (changes.ssafyDev) dev = { ...DEV_DEFAULTS, ...changes.ssafyDev.newValue };
      if (changes.dayOff) dayOff = { ...DAYOFF_DEFAULTS, ...changes.dayOff.newValue };
      if (changes.mattermost) mm = changes.mattermost.newValue || null;
      if (changes.eduAccount) eduAccount = changes.eduAccount.newValue || null;
      update();
    });
  } catch (e) {
    /* storage API 사용 불가 시 실제 시간 기준으로만 동작 */
  }

  // ── 사이트(서버) 시각 보정 ───────────────────────────────────────────
  // PC 로컬 시계가 실제 SSAFY 서버 시각보다 빠르면, 화면 카운트다운이 0초가
  // 되어 "지금 퇴실하세요"로 바뀐 시점에 눌러도 서버 로그에는 아직 17시대로
  // 찍혀 조퇴 처리될 수 있다. 같은 origin(edu.ssafy.com)으로 가벼운 요청을
  // 보내 응답의 Date 헤더로 서버 시각을 추정하고, 그 오차만큼 로컬 시각을
  // 보정해서 모든 판단(카운트다운, 입실/퇴실 마감, 클릭 기록)에 사용한다.
  let serverOffsetMs = 0;

  function serverNow() {
    return new Date(Date.now() + serverOffsetMs);
  }

  function syncServerTime() {
    const reqStart = Date.now();
    fetch(location.href, { method: "HEAD", cache: "no-store", credentials: "same-origin" })
      .then((res) => {
        const dateHeader = res.headers.get("date");
        if (!dateHeader) return;
        const serverMs = new Date(dateHeader).getTime();
        if (Number.isNaN(serverMs)) return;
        const reqEnd = Date.now();
        // 왕복 시간의 절반만큼 보정해 좀 더 정확한 서버 시각을 추정한다.
        const estimatedServerNow = serverMs + (reqEnd - reqStart) / 2;
        serverOffsetMs = estimatedServerNow - reqEnd;
      })
      .catch(() => {
        /* 실패하면 기존 오프셋(초기값 0=로컬 시각)을 그대로 유지한다. */
      });
  }

  // 계속 5분마다 보낼 필요는 없고, 실제로 오차가 문제가 되는 순간(입실/퇴실
  // 마감 직전)에만 다시 맞추면 충분하다. 마감 5분 전(08:55, 17:55)에 딱 한
  // 번씩만 재동기화한다. 판단 기준은 로컬 시계로 충분하다(트리거 시점만
  // 대략 맞으면 되고, 어차피 이 함수 자체가 그 오차를 보정하는 함수라 아직
  // 보정되지 않은 로컬 시각으로 트리거해도 문제없다).
  const SYNC_BEFORE_MIN = 5;
  let lastAutoSyncKey = null;

  function maybeSyncServerTime() {
    const d = new Date();
    const totalMin = d.getHours() * 60 + d.getMinutes();
    if (totalMin !== CHECK_IN_DEADLINE_MIN - SYNC_BEFORE_MIN && totalMin !== CHECK_OUT_START_MIN - SYNC_BEFORE_MIN) {
      return;
    }
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${totalMin}`;
    if (key === lastAutoSyncKey) return; // 같은 분 안에 중복 호출 방지
    lastAutoSyncKey = key;
    syncServerTime();
  }

  function nowMinutes() {
    if (dev.enabled && dev.time != null) return dev.time;
    const d = serverNow();
    return d.getHours() * 60 + d.getMinutes();
  }

  // 출석 체크가 필요한 날인지. 주말·공휴일·개인 휴무일이면 false.
  // 개발자 모드의 "주말·공휴일에도 평일처럼 동작"은 이 판정을 통째로 무시한다.
  //
  // holidays.js 가 없는 상태(압축을 덜 푼 폴더 등)에서도 확장이 통째로 죽지
  // 않도록 예전 동작(주말만 제외)으로 물러난다. 조용히 아무것도 안 하는 것보다
  // 헛알림이 낫다는 원칙에 따라, 판정이 불가능하면 "동작하는 쪽"을 고른다.
  function isWorkday() {
    if (dev.enabled && dev.forceWeekday) return true;
    const now = serverNow();
    if (typeof SsafyHolidays === "undefined") {
      const day = now.getDay();
      return day >= 1 && day <= 5;
    }
    return !SsafyHolidays.dayInfo(now, dayOff).off;
  }

  // 설정이 끝났는지. 예전에는 같은 규칙을 여기에 최소한으로 옮겨 적었는데,
  // mattermost.js 쪽이 "숫자로 시작하는 아이디도 허용"으로 완화됐을 때 이쪽만
  // 옛 규칙(첫 글자는 영문)으로 남았다. 그 결과 자동 연동까지 정상으로 끝낸
  // 사람(예: @1008mjw)이 출석 페이지에서만 "설정을 마쳐야 동작합니다" 안내를
  // 계속 보게 됐다 - 팝업은 설정됨, 페이지는 설정 안 됨으로 갈라진 것이다.
  // 그래서 규칙을 옮겨 적는 대신 mattermost.js 를 컨텐트 스크립트로 함께 주입해
  // 같은 함수 하나로 판단한다. 컨텐트 스크립트는 페이지와 분리된 세계에서
  // 돌기 때문에 이렇게 해도 페이지 쪽 스크립트가 웹훅 주소를 읽을 수는 없다.
  function isMattermostConfigured() {
    if (!mm) return false;
    if (typeof SsafyMattermost !== "undefined") return SsafyMattermost.isConfigured(mm);

    // mattermost.js 를 못 읽은 경우(압축을 덜 푼 폴더 등)의 최소 판정.
    // 여기서 사용자명 모양까지 다시 따지면 규칙이 또 갈라지므로, 보낼 주소와
    // 보낼 곳이 둘 다 있는지만 본다.
    const hook = typeof mm.webhookUrl === "string" ? mm.webhookUrl.trim() : "";
    const id = String(mm.channel == null ? "" : mm.channel).trim().replace(/^@+/, "");
    return !!(mm.enabled && hook.startsWith("https://meeting.ssafy.com/hooks/") && id);
  }

  // 우리가 그려 넣은 요소(배너·강조 박스·라벨)인지 확인한다.
  // 이걸 빼먹으면, 우리 라벨에 적힌 "입실 체크!" 같은 문구를 페이지의 문구로
  // 착각해 박스가 자기 라벨을 강조 대상으로 잡는다. 그러면 박스 크기가 라벨에
  // 맞춰지고 라벨은 다시 박스 위쪽에 붙으면서, 매 갱신마다 박스가 조금씩
  // 커지며 위로 기어올라간다.
  function isOurs(el) {
    return !!(el && el.closest && el.closest(OURS_SELECTOR));
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
      // 우리가 그려 넣은 배너·강조 박스 안의 텍스트는 제외
      if (isOurs(el)) continue;
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
    let text = document.body.innerText || "";
    // 우리가 쓴 문구를 페이지의 문구로 착각하지 않도록 배너와 강조 박스의
    // 텍스트를 걷어낸다. 배너만 빼면 박스 라벨이 그대로 남아 오탐이 난다.
    document.querySelectorAll(OURS_SELECTOR).forEach((el) => {
      const t = el.innerText;
      if (t) text = text.split(t).join("");
    });
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
    // 정확한 문구를 먼저 찾는다. "입실" 만으로 찾으면 "입실 현황" 같은 다른
    // 문구에도 걸려 엉뚱한 곳을 강조하게 되므로, 느슨한 검색은 최후에만 쓴다.
    const el =
      findClickableByText(/입실\s*(하기|체크)/) ||
      findClickableByText(/정상\s*출석/) ||
      findClickableByText(/입실/);
    if (!el) return null;
    // 이미 클릭 가능한 셀이면 그대로, 아니면 셀 크기까지 올라가서 감싼다.
    if (el.matches && el.matches('button, a, [role="button"], [onclick]')) return el;
    return climbToBox(el, 50, 50, 240, 240);
  }

  function findCheckOutButton() {
    return findClickableByText(/퇴실\s*하기/);
  }

  // ── 지금 이 화면에 로그인된 에듀싸피 계정 ─────────────────────────────
  // 왜 이걸 읽어야 하나:
  // 이 확장의 Mattermost 설정은 "크롬 프로필"에 붙어 있는데, 출석 상태는
  // 그때그때 edu.ssafy.com 에 로그인된 "사람"의 것이다. 평소에는 둘이 같아서
  // 문제가 없지만, 시험처럼 자리를 옮겨 앉는 날 남의 PC(크롬은 그 사람 계정으로
  // 로그인된 채)에서 자기 아이디로 에듀싸피에 로그인해 입실을 누르면, 그
  // "입실 체크 완료" 알림이 PC 주인에게 간다. 주인은 아직 오지도 않았는데
  // 자기가 체크된 줄 알고 안심하다 미입실 처리된다 - 실제로 일어난 사고다.
  //
  // 그래서 화면에 뜬 이름을 함께 보고해서, 백그라운드가 "이건 이 브라우저
  // 주인의 출석이 아니다"를 판단할 수 있게 한다.
  //
  // 못 읽으면 빈 문자열이고, 그러면 백그라운드는 예전과 똑같이 동작한다.
  // 사이트 구조가 바뀌어 이름을 못 읽게 되는 순간 알림이 통째로 멎는 쪽이
  // 훨씬 나쁘기 때문에, 확신이 설 때만 막는다.

  // 이름이 들어 있을 법한 곳. 사이트가 바뀌어도 하나쯤은 걸리도록 넉넉히 둔다.
  const ACCOUNT_NAME_SELECTORS = [
    ".user-name",
    ".userName",
    ".username",
    "#userName",
    ".user_name",
    ".profile-name",
    ".my-name",
    ".user-info .name",
    ".userInfo .name",
    ".login-info .name",
  ];

  // 상단 영역. "OOO님"을 찾을 때 이 안에서만 찾는다. 본문까지 뒤지면
  // 게시글 작성자("홍길동님이 댓글을...")처럼 화면마다 바뀌는 이름을 잡아
  // 애먼 사람을 남으로 오해하게 된다.
  const ACCOUNT_SCOPE_SELECTORS = [
    "header",
    "#header",
    ".header",
    "#gnb",
    ".gnb",
    ".util",
    ".top-util",
    ".user-info",
    ".userInfo",
    ".login-info",
  ];

  // "홍길동 님" / "홍길동님" 에서 이름만 뽑는다. 한글 이름은 2~4자가
  // 대부분이라 그보다 길게 잡으면 앞말까지 딸려온다.
  const ACCOUNT_NAME_RE = /([가-힣]{2,4})\s*님/g;

  // "님"이 붙지만 사람 이름이 아닌 말들. 이걸 이름으로 잡으면 화면마다
  // 주인이 바뀌는 것처럼 보인다.
  const NOT_A_NAME = ["선생", "고객", "회원", "관리자", "여러분", "교수", "조교", "학부모"];

  function cleanAccountName(text) {
    const t = String(text == null ? "" : text)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s*님$/, "");
    if (!t) return "";

    // 화면마다 이름 옆에 붙는 것이 다르다 ("홍길동", "홍길동님", "홍길동 (0123456)").
    // 붙은 것까지 그대로 쓰면 같은 사람인데도 화면을 옮길 때마다 다른 사람으로
    // 보여서, 자기 출석이 자기 알림에서 막힌다. 한글 이름 부분만 뽑아 어느
    // 경로로 읽든 같은 값이 나오게 한다.
    const hangul = /[가-힣]{2,4}/.exec(t);
    const name = hangul ? hangul[0] : t;
    if (name.length > 20) return "";
    if (NOT_A_NAME.includes(name)) return "";
    return name;
  }

  function nameFromScope(root) {
    if (!root) return "";
    const text = root.innerText || root.textContent || "";
    // "선생님" 같은 말이 먼저 걸려도 거기서 포기하지 않고 계속 본다.
    ACCOUNT_NAME_RE.lastIndex = 0;
    let m;
    while ((m = ACCOUNT_NAME_RE.exec(text))) {
      const name = cleanAccountName(m[1]);
      if (name) return name;
    }
    return "";
  }

  // 한 번 갱신할 때 여러 번 부르고(배너 판단 + 보고 두 곳), update 는 DOM이
  // 바뀔 때마다 도는데 innerText 는 레이아웃을 강제한다. 잠깐 캐싱해서
  // 화면이 활발히 바뀌는 동안에도 부담이 되지 않게 한다.
  const ACCOUNT_CACHE_MS = 5000;
  let accountCache = { at: 0, value: "" };

  function pageAccount() {
    const now = Date.now();
    if (now - accountCache.at < ACCOUNT_CACHE_MS) return accountCache.value;
    const value = findPageAccount();
    accountCache = { at: now, value };
    return value;
  }

  function findPageAccount() {
    // 1) 이름만 들어 있는 전용 요소가 있으면 그게 가장 정확하다.
    for (const sel of ACCOUNT_NAME_SELECTORS) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch (e) {
        continue; // 선택자를 못 쓰는 브라우저가 있어도 나머지는 계속 본다
      }
      if (!el || isOurs(el)) continue;
      const name = cleanAccountName(el.textContent);
      if (name) return name;
    }

    // 2) 로그아웃 버튼 옆에는 거의 항상 내 이름이 붙어 있다.
    const logout = findClickableByText(/로그아웃/);
    if (logout) {
      const name = nameFromScope(logout.parentElement) || nameFromScope(logout.closest("div, li, ul, nav, header"));
      if (name) return name;
    }

    // 3) 마지막으로 상단 영역에서 "OOO님"을 찾는다.
    for (const sel of ACCOUNT_SCOPE_SELECTORS) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch (e) {
        continue;
      }
      if (!el || isOurs(el)) continue;
      const name = nameFromScope(el);
      if (name) return name;
    }

    return "";
  }

  // 이 브라우저에 연결된 주인(eduAccount.name)과 지금 화면의 계정이 다르면
  // 그 주인 이름을 돌려준다. 같거나 알 수 없으면 빈 문자열.
  function otherOwnerName() {
    const owner = eduAccount && eduAccount.name ? String(eduAccount.name) : "";
    if (!owner) return "";
    const here = pageAccount();
    if (!here || here === owner) return "";
    return owner;
  }

  // ── 페이지에 표시된 출석 상태 읽기 ──────────────────────────────────
  // SSAFY 홈 출석 위젯의 실제 구조:
  //   <div class="wrap-going">
  //     <div class="state inRoomEnd"><span><span class="t1">08:25</span> 정상 출석</span></div>
  //     <div class="state2 outRoomEnd"><a id="checkOut"><span class="t1">13:50</span>퇴실하기</a></div>
  //   </div>
  // 입실은 문구가 "입실하기" → "정상 출석"으로 바뀌지만, 퇴실은 누른 뒤에도
  // 문구가 "퇴실하기" 그대로이고 .t1에 시각만 찍힌다. 그래서 퇴실 여부는
  // 문구가 아니라 이 시각으로만 판별할 수 있다.
  function attendanceWidget() {
    return document.querySelector(".wrap-going");
  }

  function parseHhmm(text) {
    const m = /(\d{1,2}):(\d{2})/.exec(text || "");
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  // 위젯에 찍힌 입실 시각(분). 아직 입실 전이면 null.
  function pageCheckinMinutes() {
    const w = attendanceWidget();
    const cell = w && w.querySelector(".state");
    return cell ? parseHhmm(cell.textContent) : null;
  }

  // 위젯에 찍힌 퇴실 시각(분). 아직 퇴실 기록이 없으면 null.
  function pageCheckoutMinutes() {
    const w = attendanceWidget();
    const cell = (w && w.querySelector(".state2")) || document.getElementById("checkOut");
    return cell ? parseHhmm(cell.textContent) : null;
  }

  function minutesToHhmm(min) {
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  }

  // 출석 위젯(노란 박스) - 입실/퇴실 셀을 모두 못 찾을 때의 대체 강조 대상.
  function findAttendanceWidget() {
    const label = findClickableByText(/출석체크/);
    if (!label) return null;
    return climbToBox(label, 180, 90, 560, 460);
  }

  // 출석 위젯이 있는 화면(메인/홈)인지 판단한다.
  // 커리큘럼·로그인 등 다른 화면에는 위젯이 없어 출석 상태를 알 수 없으므로,
  // 그런 화면에서는 "미입실"로 오판하지 않도록 강조/배너를 표시하지 않는다.
  function onAttendancePage() {
    return !!attendanceWidget() || !!findClickableByText(/출석체크/);
  }

  function isCheckedIn() {
    if (dev.enabled && dev.checkedIn === "true") return true;
    if (dev.enabled && dev.checkedIn === "false") return false;
    // 위젯에 입실 시각이 찍혀 있으면 서버 기준으로 확정이다.
    if (pageCheckinMinutes() != null) return true;
    // 오늘 입실 클릭 기록이 있거나 "정상 출석" 문구가 보이면 입실 완료
    if (hasCheckinToday() || pageHasText(/정상\s*출석/)) return true;
    // "입실하기" 문구가 명시적으로 보이면 아직 입실 전이다. 퇴실 버튼은
    // 입실 전에도 (비활성 상태로) 화면에 존재할 수 있어 판단 기준으로
    // 쓸 수 없으므로, 입실하기 문구가 우선한다.
    if (pageHasText(/입실\s*하기/)) return false;
    // 그 외에는 퇴실 버튼 존재 여부로 추정한다. (최후 수단)
    return !!findCheckOutButton();
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
    // 우리 박스나 라벨을 대상으로 잡으면, 박스가 자기 크기를 다시 재면서
    // 갱신할 때마다 커지고 위로 밀려 올라간다. isOurs() 로 텍스트 검색에서
    // 이미 걸러내지만, 다른 경로로 새어 들어오더라도 여기서 끊는다.
    // 갱신을 건너뛸 뿐 기존 박스는 그대로 둬서 경고가 사라지지 않게 한다.
    if (isOurs(target)) return;
    let entry = boxes.get(id);
    if (!entry) {
      const el = document.createElement("div");
      el.className = BOX_CLASS;
      const lbl = document.createElement("div");
      lbl.className = "ssafy-alert-box-label";
      el.appendChild(lbl);
      document.body.appendChild(el);
      entry = { el, lbl, target };
      boxes.set(id, entry);
    }
    entry.target = target;
    entry.el.dataset.tone = tone; // "danger" | "warn"
    entry.lbl.textContent = label || "";
    entry.lbl.style.display = label ? "block" : "none";
    // 사이트 자체 헤더 메뉴(마우스오버 드롭다운 등)가 나중에 body에 추가/이동
    // 되면서 우리 박스보다 뒤에 그려져 라벨이 가려 보일 수 있어, 갱신할 때마다
    // body의 맨 끝으로 옮겨 항상 가장 나중에 그려지도록 한다.
    if (entry.el.parentElement === document.body && document.body.lastElementChild !== entry.el) {
      document.body.appendChild(entry.el);
    }
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

  // ── 사이트 상단 메뉴(드롭다운) 위에는 우리 박스를 띄우지 않기 ────────────
  // 사이트 자체 상단 메뉴에 마우스를 올려 하위 메뉴가 펼쳐질 때, 우리 강조
  // 박스/라벨/배너가 그 위에 겹쳐 보여서 메뉴 글자를 가리는 문제가 있었다.
  // z-index를 아무리 올려도 결국 "우리가 메뉴 위"가 되어 반대 문제만
  // 생기므로, 메뉴에 마우스가 올라가 있는 동안은 우리 오버레이를 아예
  // 숨겨서 메뉴가 항상 위에 보이도록 한다.
  let navEl = null;
  let navHovered = false;

  function findNavElement() {
    if (navEl && document.contains(navEl)) return navEl;
    let el =
      document.querySelector('header, nav, [role="navigation"]') ||
      findClickableByText(/마이캠퍼스/) ||
      findClickableByText(/HELP\s*DESK/);
    if (!el) return null;
    // 텍스트로 찾은 경우, 상단 메뉴바(펼쳐지는 하위 메뉴까지 포함) 전체를
    // 감싸는 넓은 조상까지 올라간다.
    if (!(el.matches && el.matches("header, nav"))) {
      let cur = el;
      let best = el;
      for (let i = 0; i < 8 && cur.parentElement; i++) {
        cur = cur.parentElement;
        if (cur.getBoundingClientRect().width >= window.innerWidth * 0.6) best = cur;
      }
      el = best;
    }
    navEl = el;
    return navEl;
  }

  function setNavHovered(hovered) {
    if (navHovered === hovered) return;
    navHovered = hovered;
    document.body.classList.toggle("ssafy-nav-open", navHovered);
  }

  function attachNavHoverGuard() {
    const nav = findNavElement();
    if (!nav || nav.dataset.ssafyNavGuard) return;
    nav.dataset.ssafyNavGuard = "1";
    nav.addEventListener("mouseenter", () => setNavHovered(true));
    nav.addEventListener("mouseleave", () => setNavHovered(false));
  }

  // 이 크롬의 주인과 지금 로그인한 사람이 다를 때 띄우는 문구. 비어 있지
  // 않으면 다른 어떤 안내보다 우선해서 배너를 차지한다 - 지금 이 자리에 앉은
  // 사람에게는 "네 알림은 여기로 오지 않는다"가 가장 먼저 알아야 할 사실이고,
  // 이 안내를 보고 자기 크롬에 확장을 설치하러 갈 수 있다.
  let accountNotice = "";

  function showBanner(message, tone) {
    if (accountNotice) {
      message = accountNotice;
      tone = "warn";
    }
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
    // 주인이 다르다는 안내는 감출 수 없다. 다른 안내가 사라지는 자리마다
    // 이 문구가 남아야, 화면 어느 상태에서도 한 번은 눈에 들어온다.
    if (accountNotice) {
      showBanner(accountNotice, "warn");
      return;
    }
    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.style.display = "none";
  }

  // 자정 기준 밀리초. 개발자 모드에서 가상 시각이 켜져 있으면 그 시각에
  // 고정된다(분 단위, 초는 흐르지 않음 - 미리보기용이라 실시간 흐름은 불필요).
  function nowMs() {
    if (dev.enabled && dev.time != null) return dev.time * 60000;
    const d = serverNow();
    return ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
  }

  function secondsLeftText(targetMin) {
    const leftMs = targetMin * 60000 - nowMs();
    if (leftMs <= 0) return "";
    let leftSec = Math.ceil(leftMs / 1000);
    const h = Math.floor(leftSec / 3600);
    leftSec %= 3600;
    const m = Math.floor(leftSec / 60);
    const s = leftSec % 60;
    if (h > 0) return `${h}시간 ${m}분 ${s}초 남음`;
    if (m > 0) return `${m}분 ${s}초 남음`;
    return `${s}초 남음`;
  }

  // ── 입실 / 퇴실 클릭 기록 ─────────────────────────────────────────────
  //  - 입실: 한 번 누르면(=오늘 입실 완료) 09:00 이전이어도 더 이상 강조하지 않는다.
  //  - 퇴실: 미리 눌러도 되지만, 18:00 이후에 누른 기록이 있어야 정상 퇴실로
  //    인정된다. 18:00 이후 클릭이 생길 때까지 계속 강조한다.
  const CHECKIN_KEY = "ssafy-alert-last-checkin";
  const CHECKOUT_KEY = "ssafy-alert-last-checkout";

  function todayStr() {
    const d = serverNow();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // debug.js 가 없어도 (로드 실패 등) 컨텐트 스크립트가 죽지 않게 감싼다.
  function dlog(...args) {
    if (typeof SsafyDebug !== "undefined" && SsafyDebug.log) SsafyDebug.log("page", ...args);
  }

  // 백그라운드로 보고를 보낸다. 실패하면 잠깐 뒤에 몇 번 더 시도한다.
  //
  // MV3 서비스 워커는 할 일이 없으면 잠든다. 잠든 워커에 sendMessage를 하면
  // 크롬이 워커를 깨우는데, 그 사이에 페이지가 넘어가버리면 이 보고가 통째로
  // 유실된다. 아침 입실이 정확히 그 상황이다 - 그날 첫 알람(08:50)보다 이른
  // 시각이라 워커가 밤새 잠들어 있고, 입실 버튼을 누르면 화면이 갱신된다.
  // 반면 퇴실은 17:50·18:00 알람이 막 워커를 깨워둔 뒤라 잘 도착한다.
  // 웹스토어 빌드에는 15분마다 도는 릴리스 확인 알람마저 없어서(IS_WEBSTORE),
  // 아침에 워커가 잠들어 있을 확률이 개발용 설치본보다 훨씬 높다.
  function sendToBackground(payload, tries) {
    const left = tries == null ? 3 : tries;
    const retry = (e) => {
      dlog("보고 실패", { type: payload.type, 남은시도: left - 1, error: String(e && e.message ? e.message : e) });
      if (left > 1) setTimeout(() => sendToBackground(payload, left - 1), 1000);
    };
    try {
      const p = chrome.runtime.sendMessage(payload);
      // 서비스 워커가 없을 때 나는 "Receiving end does not exist"를 여기서 받는다.
      if (p && typeof p.catch === "function") p.catch(retry);
    } catch (e) {
      /* 확장 컨텍스트가 무효화된 경우 */
      retry(e);
    }
  }

  function recordClick(key) {
    const minutes = nowMinutes();
    dlog("버튼 클릭 감지", { kind: key === CHECKIN_KEY ? "checkin" : "checkout", minutes });
    try {
      localStorage.setItem(key, JSON.stringify({ date: todayStr(), minutes, at: Date.now() }));
    } catch (e) {
      /* localStorage 사용 불가 시 무시 */
    }
    // 백그라운드에도 알린다. 서비스 워커는 페이지의 localStorage를 읽을 수
    // 없어서, 이 보고가 있어야 "아직 안 눌렀는지"를 판단해 Mattermost 경고를
    // 보낼 수 있다. 같은 보고가 두 번 도착해도 백그라운드가 하루 한 번만
    // 보내도록 막아두어서, 재시도가 메시지 중복으로 이어지지 않는다.
    sendToBackground({
      type: "attendanceRecorded",
      kind: key === CHECKIN_KEY ? "checkin" : "checkout",
      minutes,
      date: todayStr(),
      // 이 출석이 누구 것인지. 남의 PC에서 눌렀을 때 그 PC 주인에게 "완료"
      // 알림이 가는 것을 백그라운드에서 막기 위한 값이다.
      account: pageAccount(),
    });
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

  // 위젯에서 읽은 서버 기준 시각을 백그라운드에 알린다. 서비스 워커는 페이지를
  // 읽을 수 없어서, 이 보고가 없으면 Mattermost 경고가 이 브라우저의 클릭
  // 기록에만 의존하게 된다. (폰으로 체크했거나 서버 반영이 실패한 경우를 놓침)
  let lastReportedObserved = "";

  function reportObserved() {
    if (dev.enabled) return; // 개발자 모드의 가상 상태는 보고하지 않는다
    if (!attendanceWidget()) return;
    const checkinMin = pageCheckinMinutes();
    const checkoutMin = pageCheckoutMinutes();
    // 계정도 서명에 넣는다. 시각이 같아도 로그인한 사람이 바뀌었으면 그건
    // 다른 사람의 출석이라 다시 보고해야 한다.
    const sig = `${todayStr()}|${pageAccount()}|${checkinMin}|${checkoutMin}`;
    if (sig === lastReportedObserved) return; // 값이 바뀔 때만 보낸다
    lastReportedObserved = sig;
    dlog("위젯에서 읽음", { checkinMin, checkoutMin });
    sendToBackground({
      type: "attendanceObserved",
      date: todayStr(),
      checkinMin,
      checkoutMin,
      account: pageAccount(),
    });
  }

  // 퇴실 클릭 직후에는 위젯에 시각이 아직 안 찍혔을 수 있다(서버 반영 전).
  // 이 유예 시간 동안만 클릭 기록을 임시로 인정하고, 그 뒤에는 위젯에 실제로
  // 반영됐는지로만 판단한다. 눌렀지만 서버에 안 들어간 경우를 잡기 위함이다.
  const CHECKOUT_GRACE_MS = 90 * 1000;

  // 오늘 18:00 이후의 퇴실 기록이 있으면 정상 퇴실로 본다.
  // 위젯을 읽을 수 있으면 거기 찍힌 시각이 서버 기준 진실이므로 최우선이다.
  function hasValidCheckoutToday() {
    const pageMin = pageCheckoutMinutes();
    if (pageMin != null) return pageMin >= CHECK_OUT_START_MIN;

    const rec = readRecord(CHECKOUT_KEY);
    if (!rec || rec.minutes < CHECK_OUT_START_MIN) return false;
    // 위젯이 없는 화면에서는 클릭 기록이 유일한 근거다.
    if (!attendanceWidget()) return true;
    // 위젯은 보이는데 시각이 아직 없으면, 클릭 직후 잠깐만 인정한다.
    return rec.at != null && Date.now() - rec.at < CHECKOUT_GRACE_MS;
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
  // 입실/퇴실 버튼 위에 네모 박스를 겹쳐 그린다.
  //  - 입실 박스: 아직 입실 전이면 빨간색으로 표시 (09:00 이전엔 남은 시간 표시)
  //  - 퇴실 박스: 입실 완료 후 표시. 18:00 전엔 주황색("18시 이후에"),
  //              18:00 이후엔 빨간색("지금 퇴실")
  //  - 18:30 부터는 둘 다 그리지 않는다 (ALERT_END_MIN)
  // 초 단위 카운트다운이 필요한 상태일 때, 매초 가볍게 갱신하기 위한 정보.
  // (버튼 재탐색 없이 라벨/배너 텍스트만 다시 그린다)
  let countdown = null;

  function update() {
    countdown = null;
    accountNotice = "";
    attachNavHoverGuard();

    // 아무것도 표시하지 않는 경우:
    //  - 쉬는 날(주말·공휴일·등록한 휴무일)
    //  - 출석 위젯이 없는 화면(커리큘럼·로그인 등). 상태를 알 수 없으므로
    //    다른 화면에서 "미입실"로 오판하는 것을 막는다.
    //  - 18:30 부터 (ALERT_END_MIN). 이 시각을 넘기면 눌러도 소용이 없다.
    if (!isWorkday() || !onAttendancePage() || nowMinutes() >= ALERT_END_MIN) {
      removeBox("checkin");
      removeBox("checkout");
      hideBanner();
      return;
    }

    // ── Mattermost 설정이 끝나기 전에는 강조를 켜지 않는다 ──────────────
    // 화면 강조는 이 페이지를 열어놓고 있을 때만 보인다. 자리를 비우거나
    // 탭을 닫으면 아무 소용이 없고, 정작 놓치는 상황이 바로 그때다. 폰으로
    // 푸시가 오는 Mattermost 경로까지 갖춰야 이 확장이 제 역할을 하므로,
    // 설정을 마칠 때까지는 강조 대신 설정하라는 안내만 띄운다.
    //
    // mm 이 null 인 동안은 아직 저장소를 읽지 못한 것이므로 아무 판단도 하지
    // 않는다. 여기서 "설정 안 됨"으로 단정하면 페이지를 열 때마다 안내가
    // 잠깐씩 번쩍인다.
    if (mm && !isMattermostConfigured()) {
      removeBox("checkin");
      removeBox("checkout");
      showBanner("⚙️ 설정을 마쳐야 동작합니다. 확장 아이콘을 눌러 Mattermost 알림을 설정하세요.", "warn");
      return;
    }

    // 이 크롬에 연결된 알림의 주인과 지금 로그인한 사람이 다른지 본다.
    // 화면 강조(네모 박스)는 그대로 둔다 - 지금 앉은 사람도 입실·퇴실은
    // 눌러야 하고, 그건 누가 눌러도 맞는 안내다. 다만 "폰으로 오는 알림"은
    // 주인에게만 가므로 그 사실만 배너로 알린다. (쉬는 날·강조가 꺼진
    // 시간대에는 여기까지 오지 않아 조용하다)
    const owner = otherOwnerName();
    accountNotice = owner
      ? `👤 이 크롬에는 ${owner}님의 출석 알리미가 연결돼 있어요. 지금 로그인한 계정의 알림은 오지 않습니다 — 본인 크롬에 확장을 설치해 설정하세요.`
      : "";

    const now = nowMinutes();
    const checkedIn = isCheckedIn();
    reportObserved();

    // ── 입실 박스 ──
    if (!checkedIn) {
      const target = findCheckInButton() || findAttendanceWidget();
      if (now < CHECK_IN_START_MIN) {
        // 08:00 이전에는 SSAFY 쪽에서 실제로 입실 체크가 열리지 않으므로,
        // 재촉하는 대신 언제부터 가능한지만 조용히 안내한다(퇴실 전 안내와
        // 같은 스타일: 주황색, 배너 없음).
        const left = secondsLeftText(CHECK_IN_START_MIN);
        ensureBox("checkin", target, "warn", `⏳ 입실은 08:00부터 가능 (${left})`);
        hideBanner();
        removeBox("checkout");
        countdown = {
          boxId: "checkin",
          targetMin: CHECK_IN_START_MIN,
          renderLabel: (l) => `⏳ 입실은 08:00부터 가능 (${l})`,
          renderBanner: null,
        };
        return;
      }
      if (now < CHECK_IN_DEADLINE_MIN) {
        const left = secondsLeftText(CHECK_IN_DEADLINE_MIN);
        ensureBox("checkin", target, "danger", `🚨 입실 체크! 09:00 마감 (${left})`);
        showBanner(`🚨 입실 체크를 하세요! 09:00 마감 (${left})`, "danger");
        countdown = {
          boxId: "checkin",
          targetMin: CHECK_IN_DEADLINE_MIN,
          renderLabel: (l) => `🚨 입실 체크! 09:00 마감 (${l})`,
          renderBanner: (l) => `🚨 입실 체크를 하세요! 09:00 마감 (${l})`,
        };
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
      // 위젯에 18시 이전 시각이 찍혀 있으면 "안 누름"이 아니라 "일찍 누름"이라,
      // 무엇이 문제인지 정확히 알려준다.
      const early = pageCheckoutMinutes();
      if (early != null && early < CHECK_OUT_START_MIN) {
        const t = minutesToHhmm(early);
        ensureBox("checkout", checkOutTarget, "danger", `🚨 ${t} 기록뿐! 지금 다시 누르세요`);
        showBanner(
          `🚨 퇴실 기록이 ${t}(18시 이전)뿐입니다! 지금 다시 눌러야 조퇴 처리를 피할 수 있어요.`,
          "danger"
        );
      } else {
        ensureBox("checkout", checkOutTarget, "danger", "🚨 지금 퇴실하세요! (18시 이후)");
        showBanner("🚨 18시가 지났습니다! 지금 퇴실 버튼을 누르세요. (18시 이전 기록만으로는 조퇴 처리될 수 있어요)", "danger");
      }
    } else {
      // 18:00 이전: 주황색 안내 박스 (미리 눌러도 되지만 18시 이후 재클릭 필요)
      const left = secondsLeftText(CHECK_OUT_START_MIN);
      ensureBox("checkout", checkOutTarget, "warn", `⏳ 퇴실은 18:00 이후에 (${left})`);
      hideBanner();
      countdown = {
        boxId: "checkout",
        targetMin: CHECK_OUT_START_MIN,
        renderLabel: (l) => `⏳ 퇴실은 18:00 이후에 (${l})`,
        renderBanner: null,
      };
    }
  }

  // 버튼 재탐색 없이, 표시 중인 카운트다운의 초만 매초 갱신한다.
  // 목표 시각을 지나면(=left가 빈 문자열) 전체 재판단(update)을 트리거한다.
  function tickCountdown() {
    if (!countdown) return;
    const left = secondsLeftText(countdown.targetMin);
    if (!left) {
      update();
      return;
    }
    const entry = boxes.get(countdown.boxId);
    if (entry) entry.lbl.textContent = countdown.renderLabel(left);
    if (countdown.renderBanner) showBanner(countdown.renderBanner(left), "danger");
  }

  // 주기 실행 + DOM 변경 감지
  syncServerTime(); // 페이지 로드 시 1회 보정
  setInterval(maybeSyncServerTime, 30 * 1000); // 입실/퇴실 마감 5분 전에만 재보정
  loadDevSettings(update);
  setInterval(update, 15 * 1000);
  setInterval(tickCountdown, 1000);

  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(update, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
