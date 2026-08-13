// SSAFY 출석 체크 알리미 - Mattermost 연동 설정 (공용 모듈)
//
// ── 웹훅은 하나로 고정한다 ────────────────────────────────────────────
// 예전에는 각자 웹훅을 만들어 URL을 붙여넣게 했지만, 통합(Integrations)
// 메뉴가 막혀 있는 사람도 있고 단계가 길어 중간에 포기하기 쉬웠다.
// SSAFY Mattermost의 웹훅 하나로 고정하면 사용자는 자기 아이디만 넣으면
// 된다. 이 URL은 확장에 들어 있는 값이라 비밀이 아니다 - 설치한 사람은
// 누구나 꺼내 볼 수 있으므로, 여기에 비밀로 지켜야 할 것을 두면 안 된다.
//
// ── 왜 아이디를 필수로 받는가 ─────────────────────────────────────────
// 받을 곳을 비워두면 웹훅을 만들 때 고른 채널로 메시지가 간다. 반 사람들이
// 같은 채널에서 각자 웹훅을 만들면, 한 사람이 퇴실을 안 눌렀다는 경고가
// 그 방 전체에 울린다. 미체크 경고는 체크할 때까지 반복해서 보내기 때문에
// 한 명만 설정을 빠뜨려도 하루에 수십 번씩 전원에게 알림이 간다.
// 그래서 "받을 곳"은 비워둘 수 없게 하고, 반드시 @아이디(개인 메시지)로만
// 보낸다. 채널명은 받지 않는다 - 채널로 보내는 순간 같은 사고가 난다.
//
// 사용하는 곳 (holidays.js와 같은 방식으로 전역에 붙인다)
//   - service worker : importScripts("mattermost.js")
//   - popup / welcome: <script src="mattermost.js"> 를 각 스크립트보다 앞에 둔다

(function (root) {
  "use strict";

  // 고정 웹훅. 바꿔야 할 일이 생기면 여기 한 줄만 고치면 된다.
  const WEBHOOK_URL = "https://meeting.ssafy.com/hooks/os38ib43ufrkumwckoffdyx7so";
  // 이 호스트에만 런타임 권한을 요청한다 (manifest의 optional_host_permissions).
  const WEBHOOK_ORIGIN = "https://meeting.ssafy.com/*";

  // Mattermost가 계정을 만들 때 요구하는 사용자명 규칙을 그대로 옮긴 것이다.
  //   "사용자 아이디는 문자로 시작해야 하며 3~22 사이의 숫자, 문자 및
  //    기호 '.', '-', '_'로 구성된 소문자로 구성되어야 합니다."
  // 즉 [첫 글자는 a-z] + [나머지 2~21자는 a-z 0-9 . - _] = 전체 3~22자.
  // 여기 통과하는 값만 실제로 존재할 수 있는 사용자명이다.
  // (한글 표시 이름이 아니라 프로필의 영문 사용자명)
  const USERNAME_RE = /^[a-z][a-z0-9._-]{2,21}$/;

  const ERR_EMPTY =
    "받을 곳에 @내아이디를 입력해주세요. 비워두면 웹훅 채널에 있는 모든 사람에게 알림이 갑니다.";
  const ERR_SHAPE =
    "사용자 아이디는 영문 소문자로 시작하는 3~22자여야 하고, 숫자와 기호 . - _ 만 쓸 수 있어요 (예: @hong.gildong). 한글 표시 이름은 안 됩니다.";

  // 입력값을 "@아이디"로 다듬는다.
  //   { ok: true,  value: "@hong" }
  //   { ok: false, value: "다듬은 입력값", error: "사람이 읽을 안내" }
  // 실패해도 value를 돌려주는 이유: 입력창에 그대로 되돌려놓아 사용자가
  // 방금 친 내용을 잃지 않게 하기 위해서다.
  function normalizeTarget(value) {
    // 앞뒤 공백은 붙여넣기 부스러기라 걷어낸다. 하지만 가운데 공백은 지우지
    // 않는다 - "hong gil"을 "honggil"로 이어붙이면 규칙은 통과하지만 있지도
    // 않은 아이디가 되어, 전송이 실패하는 이유를 알 수 없게 된다.
    const raw = String(value == null ? "" : value).trim();
    const id = raw.replace(/^@+/, "").toLowerCase();

    if (!id) return { ok: false, value: "", error: ERR_EMPTY };
    if (!USERNAME_RE.test(id)) return { ok: false, value: "@" + id, error: ERR_SHAPE };
    return { ok: true, value: "@" + id };
  }

  function isValidTarget(value) {
    return normalizeTarget(value).ok;
  }

  root.SsafyMattermost = {
    WEBHOOK_URL,
    WEBHOOK_ORIGIN,
    normalizeTarget,
    isValidTarget,
    ERR_EMPTY,
    ERR_SHAPE,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
