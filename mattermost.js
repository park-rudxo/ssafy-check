// SSAFY 출석 체크 알리미 - Mattermost "받을 곳" 검증 (공용 모듈)
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

  // Mattermost 사용자명 규칙: 소문자·숫자와 . _ - 만, 3~22자, 첫 글자는 문자.
  // (한글 표시 이름이 아니라 프로필의 영문 사용자명)
  const USERNAME_RE = /^[a-z][a-z0-9._-]{2,21}$/;

  const ERR_EMPTY =
    "받을 곳에 @내아이디를 입력해주세요. 비워두면 웹훅 채널에 있는 모든 사람에게 알림이 갑니다.";
  const ERR_SHAPE =
    "@내아이디 형태의 영문 사용자명만 쓸 수 있어요 (예: @hong.gildong). 한글 표시 이름이나 채널명은 안 됩니다.";

  // 입력값을 "@아이디"로 다듬는다.
  //   { ok: true,  value: "@hong" }
  //   { ok: false, value: "다듬은 입력값", error: "사람이 읽을 안내" }
  // 실패해도 value를 돌려주는 이유: 입력창에 그대로 되돌려놓아 사용자가
  // 방금 친 내용을 잃지 않게 하기 위해서다.
  function normalizeTarget(value) {
    // 붙여넣다 섞인 공백만 걷어낸다. 사용자명·채널명에 공백은 없다.
    const raw = String(value == null ? "" : value)
      .trim()
      .replace(/\s+/g, "");
    const id = raw.replace(/^@+/, "").toLowerCase();

    if (!id) return { ok: false, value: "", error: ERR_EMPTY };
    if (!USERNAME_RE.test(id)) return { ok: false, value: "@" + id, error: ERR_SHAPE };
    return { ok: true, value: "@" + id };
  }

  function isValidTarget(value) {
    return normalizeTarget(value).ok;
  }

  root.SsafyMattermost = {
    normalizeTarget,
    isValidTarget,
    ERR_EMPTY,
    ERR_SHAPE,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
