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

  // 공용 웹훅. 개인 웹훅을 못 만든 사람만 여기로 물러난다.
  const WEBHOOK_URL = "https://meeting.ssafy.com/hooks/os38ib43ufrkumwckoffdyx7so";
  // 이 호스트에만 런타임 권한을 요청한다 (manifest의 optional_host_permissions).
  const WEBHOOK_ORIGIN = "https://meeting.ssafy.com/*";
  const API_BASE = "https://meeting.ssafy.com/api/v4";
  const HOOK_BASE = "https://meeting.ssafy.com/hooks/";

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

  // ── 개인 웹훅 자동 발급 ──────────────────────────────────────────────
  // 공용 웹훅 하나로 전원에게 DM을 보내면, 그 웹훅을 만든 사람이 모든 DM 방의
  // 참여자가 된다. 게다가 Mattermost는 보통 자기가 쓴 글에는 알림을 주지 않지만
  // 웹훅이 쓴 글만은 예외로 글쓴이에게도 알림을 보낸다. 그래서 쓰는 사람이
  // 늘어날수록 웹훅 주인 폰에만 남의 출석 알림이 쌓인다. 각자 자기 웹훅으로
  // 자기한테 보내면 이 구조 자체가 사라진다.
  //
  // 예전에 개인 웹훅을 포기한 이유는 "통합 메뉴에 직접 들어가 만들기"가 길고
  // 중간에 포기하기 쉬워서였다. 그 단계를 확장이 대신 밟아주면 그 이유가
  // 없어진다. 로그인된 Mattermost 세션 쿠키를 그대로 쓰므로 사용자는 버튼 한
  // 번만 누르면 되고, 아이디도 서버에서 읽어오니 오타로 조용히 실패하던 문제도
  // 같이 사라진다.
  const HOOK_NAME = "SSAFY 출석 알리미";

  function hookUrl(id) {
    return HOOK_BASE + id;
  }

  // 보낼 웹훅을 고른다. 개인 웹훅이 있으면 그걸 쓰고, 없으면 공용으로 물러난다.
  // 저장된 값이 엉뚱한 주소여도 공용으로 떨어지게 모양을 확인한다.
  function pickWebhookUrl(cfg) {
    const own = cfg && typeof cfg.webhookUrl === "string" ? cfg.webhookUrl.trim() : "";
    return own.startsWith(HOOK_BASE) ? own : WEBHOOK_URL;
  }

  // 쿠키로 인증된 요청은 CSRF 검사를 받는다. X-Requested-With 헤더가 있으면
  // 브라우저가 보낸 XHR로 인정되어 통과한다. (서버가 엄격 모드를 켠 경우에는
  // 이것만으로 부족한데, 그때는 아래에서 응답 코드를 그대로 알려준다)
  // 이 모듈은 debug.js 없이도 (테스트 등) 돌아야 하므로 없으면 조용히 넘긴다.
  function dlog(...args) {
    if (root.SsafyDebug && root.SsafyDebug.log) root.SsafyDebug.log("api", ...args);
  }

  async function api(path, body) {
    dlog("요청", { path, method: body === undefined ? "GET" : "POST" });
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      dlog("연결 실패", { path, error: String(e && e.message ? e.message : e) });
      throw new Error("Mattermost에 연결하지 못했어요. 잠시 후 다시 시도해주세요.");
    }
    dlog("응답", { path, status: res.status });
    if (!res.ok) {
      // 본문에 서버가 준 이유가 들어 있다. 특히 CSRF 거절과 권한 거절을
      // 구분하려면 이게 있어야 한다 - 둘 다 403으로 보이기 때문이다.
      const detail = await res.clone().text().catch(() => "");
      dlog("오류 본문", { path, body: detail.slice(0, 300) });
    }
    if (res.status === 401) {
      throw new Error("Mattermost에 로그인되어 있지 않아요. meeting.ssafy.com 에 로그인한 뒤 다시 눌러주세요.");
    }
    if (res.status === 403) {
      // 이 계정에 웹훅 생성 권한이 없는 경우. 드문 일이 아니라서 부르는 쪽이
      // 구분해 처리할 수 있게 표시를 달아준다.
      const err = new Error("이 계정은 웹훅을 만들 권한이 없어요. 공용 웹훅으로 보냅니다.");
      err.blocked = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Mattermost 응답 오류 (${res.status})`);
    try {
      return await res.json();
    } catch (e) {
      throw new Error("Mattermost 응답을 읽지 못했어요.");
    }
  }

  // 성공하면 { webhookUrl, channel } 을 돌려준다. 실패는 throw로 알린다.
  // 확장 페이지(팝업/설치 화면)에서 호출해야 한다 - 서비스 워커에는 이 호스트
  // 권한을 사용자 동작 없이 받을 방법이 없다.
  async function provisionPersonalWebhook() {
    const me = await api("/users/me");
    if (!me || !me.id || !me.username) throw new Error("내 계정 정보를 읽지 못했어요.");

    // "나와의 대화" 채널. 양쪽을 같은 사람으로 주면 된다. 이미 있으면 그대로
    // 돌려주므로 여러 번 불러도 채널이 늘어나지 않는다.
    const dm = await api("/channels/direct", [me.id, me.id]);
    if (!dm || !dm.id) throw new Error("나와의 대화 채널을 만들지 못했어요.");

    const hook = await api("/hooks/incoming", {
      channel_id: dm.id,
      display_name: HOOK_NAME,
      description: "SSAFY 출석 체크 알리미 확장이 자동으로 만든 웹훅",
    });
    if (!hook || !hook.id) throw new Error("웹훅을 만들지 못했어요.");

    dlog("개인 웹훅 발급 완료", { username: me.username, channelId: dm.id, hookId: hook.id });
    return { webhookUrl: hookUrl(hook.id), channel: "@" + me.username };
  }

  root.SsafyMattermost = {
    WEBHOOK_URL,
    WEBHOOK_ORIGIN,
    normalizeTarget,
    isValidTarget,
    pickWebhookUrl,
    provisionPersonalWebhook,
    ERR_EMPTY,
    ERR_SHAPE,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
