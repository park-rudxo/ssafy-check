// SSAFY 출석 체크 알리미 - Mattermost 연동 설정 (공용 모듈)
//
// ── 웹훅은 각자 자기 것을 쓴다 ────────────────────────────────────────
// 예전에는 공용 웹훅 하나를 모두가 나눠 썼다. 그런데 Mattermost는 보통
// 자기가 쓴 글에는 알림을 주지 않으면서, 웹훅이 쓴 글만은 예외로 글쓴이에게도
// 알림을 보낸다. 게다가 웹훅이 만드는 DM 방에는 언제나 웹훅 주인이 참여자로
// 들어간다. 그래서 공용 웹훅을 쓰면 그 주인 한 사람이 전원의 출석 알림을
// 자기 폰으로 다 받게 된다 - 쓰는 사람이 늘수록 감당이 안 된다.
//
// 각자 자기 계정으로 웹훅을 만들면 글쓴이가 본인이라 이 구조가 사라진다.
// 옛날에 이 방식을 접었던 이유(통합 메뉴에 직접 들어가 만들기가 번거로움)는
// 아래 provisionPersonalWebhook 이 그 단계를 대신 밟아주면서 없어졌다.
// 공용 웹훅은 더 이상 두지 않는다 - 남겨두면 자동 설정이 실패했을 때 조용히
// 그쪽으로 새어 나가고, 그게 정확히 없애려던 문제다.
//
// ── 왜 아이디를 직접 받지 않는가 ──────────────────────────────────────
// 받을 곳을 비워두면 웹훅을 만들 때 고른 채널로 메시지가 간다. 오타가 나면
// 조용히 실패하고, 남의 아이디를 넣으면 그 사람에게 간다. 그래서 아이디는
// 사람이 입력하지 않고 /users/me 에서 읽어온다. 손으로 넣을 길이 없으면
// 이 세 가지 사고가 전부 일어날 수 없다.
//
// 사용하는 곳 (holidays.js와 같은 방식으로 전역에 붙인다)
//   - service worker : importScripts("mattermost.js")
//   - popup / welcome: <script src="mattermost.js"> 를 각 스크립트보다 앞에 둔다

(function (root) {
  "use strict";

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

  const ERR_EMPTY = "아직 설정되지 않았어요. [Mattermost 로그인하여 시작하기]를 눌러주세요.";
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

  // ── 필수 설정 판정 ────────────────────────────────────────────────────
  // Mattermost 연동은 이 확장의 곁다리가 아니라 본체다. 크롬 알림은 자리를
  // 비우거나 크롬을 닫으면 못 보기 때문에, 폰으로 푸시가 오는 이 경로가 없으면
  // 정작 필요한 순간에 아무것도 못 받는다. 그래서 설정을 마치기 전까지는
  // 화면 강조도 켜지 않고 설정하라는 안내만 띄운다.
  //
  // 팝업·설치 화면·페이지 배너 세 곳이 모두 이 함수 하나로 판단해야 한다.
  // 각자 조건을 따로 쓰면 한쪽만 "설정됨"으로 보이는 어긋남이 생긴다.
  //
  // 내 웹훅과 내 아이디가 둘 다 있어야 끝난 것으로 본다. 웹훅이 없으면 보낼
  // 곳이 없고, 아이디가 없으면 보낼 대상이 없다.
  function isConfigured(cfg) {
    return !!(cfg && cfg.enabled && !!pickWebhookUrl(cfg) && isValidTarget(cfg.channel));
  }

  // 로그인 여부를 확인하러 보낼 곳. 자동 설정은 로그인된 세션을 쓰기 때문에,
  // 로그인이 안 되어 있으면 무엇을 눌러도 401만 난다.
  const HOME_URL = "https://meeting.ssafy.com/";

  // ── 개인 웹훅 자동 발급 ──────────────────────────────────────────────
  // 로그인된 Mattermost 세션 쿠키를 그대로 써서, 통합 메뉴에서 손으로 하던
  // 일을 대신 해준다. 사용자는 버튼 한 번만 누르면 된다. (왜 각자 웹훅이어야
  // 하는지는 파일 머리말 참고)
  const HOOK_NAME = "SSAFY 출석 알리미";

  function hookUrl(id) {
    return HOOK_BASE + id;
  }

  // 내 웹훅 주소. 없거나 모양이 이상하면 빈 문자열이고, 그러면 아무것도
  // 보내지 않는다. 예전에는 여기서 공용 웹훅으로 물러났는데, 그 길이 있으면
  // 자동 설정이 실패한 사람의 알림이 조용히 공용 웹훅 주인에게 흘러간다.
  function pickWebhookUrl(cfg) {
    const own = cfg && typeof cfg.webhookUrl === "string" ? cfg.webhookUrl.trim() : "";
    return own.startsWith(HOOK_BASE) ? own : "";
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
      // 이 계정에 웹훅/채널 생성 권한이 없는 경우. 드문 일이 아니라서 부르는
      // 쪽이 구분해 처리할 수 있게 표시를 달아준다.
      const err = new Error("이 계정은 웹훅을 만들 권한이 없어요. 관리자에게 문의해주세요.");
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

  // 웹훅을 걸어둘 채널을 정한다.
  //
  // 웹훅은 DM 채널에 걸 수 없다 - Mattermost는 "이름이 있는 채널"에만 웹훅을
  // 허용하고, DM으로 보내는 것은 만들 때가 아니라 보낼 때 payload의 @아이디로
  // 한다. DM 채널을 주면 403이 온다.
  //
  // 그래서 "집" 채널이 하나 필요한데, 여기를 전체 공개 채널로 두면 나중에
  // @아이디가 빠졌을 때 팀 전원에게 알림이 가는 사고가 난다. 나만 있는 비공개
  // 채널로 만들어 두면 그런 실수가 나도 나만 본다. 못 만드는 계정을 위해서만
  // town-square로 물러난다.
  const HOME_CHANNEL_NAME = "ssafy-attendance";

  async function ensureHomeChannel(teamId) {
    // 전에 만들어 둔 게 있으면 그대로 쓴다 (여러 번 눌러도 채널이 안 늘어난다).
    try {
      const found = await api(`/teams/${teamId}/channels/name/${HOME_CHANNEL_NAME}`);
      if (found && found.id) return found.id;
    } catch (e) {
      /* 없으면 아래에서 만든다 */
    }

    try {
      const made = await api("/channels", {
        team_id: teamId,
        name: HOME_CHANNEL_NAME,
        display_name: "SSAFY 출석 알림",
        type: "P", // 비공개
        purpose: "SSAFY 출석 체크 알리미가 쓰는 통로입니다. 실제 알림은 개인 메시지로 옵니다.",
      });
      if (made && made.id) return made.id;
    } catch (e) {
      dlog("비공개 채널 생성 실패, town-square로 물러남", { error: String(e && e.message ? e.message : e) });
    }

    const ts = await api(`/teams/${teamId}/channels/name/town-square`);
    if (!ts || !ts.id) throw new Error("웹훅을 걸어둘 채널을 찾지 못했어요.");
    return ts.id;
  }

  // 성공하면 { webhookUrl, channel } 을 돌려준다. 실패는 throw로 알린다.
  // 확장 페이지(팝업/설치 화면)에서 호출해야 한다 - 서비스 워커에는 이 호스트
  // 권한을 사용자 동작 없이 받을 방법이 없다.
  async function provisionPersonalWebhook() {
    const me = await api("/users/me");
    if (!me || !me.id || !me.username) throw new Error("내 계정 정보를 읽지 못했어요.");

    // 웹훅은 팀에 속한다. 여러 팀에 있으면 살아 있는 첫 팀을 쓴다 - 어느 팀에
    // 걸리든 DM 전송에는 영향이 없다.
    const teams = await api("/users/me/teams");
    const team = (Array.isArray(teams) ? teams : []).find((t) => t && t.id && !t.delete_at);
    if (!team) throw new Error("소속된 팀을 찾지 못했어요.");

    const channelId = await ensureHomeChannel(team.id);

    const hook = await api("/hooks/incoming", {
      channel_id: channelId,
      // 잠기면 payload의 @아이디로 DM을 보낼 수 없게 된다. 이 확장은 DM으로만
      // 보내므로 반드시 열어둬야 한다.
      channel_locked: false,
      display_name: HOOK_NAME,
      description: "SSAFY 출석 체크 알리미 확장이 자동으로 만든 웹훅",
    });
    if (!hook || !hook.id) throw new Error("웹훅을 만들지 못했어요.");

    dlog("개인 웹훅 발급 완료", { username: me.username, team: team.name, channelId, hookId: hook.id });
    return { webhookUrl: hookUrl(hook.id), channel: "@" + me.username };
  }

  root.SsafyMattermost = {
    WEBHOOK_ORIGIN,
    HOME_URL,
    normalizeTarget,
    isValidTarget,
    isConfigured,
    pickWebhookUrl,
    provisionPersonalWebhook,
    ERR_EMPTY,
    ERR_SHAPE,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
