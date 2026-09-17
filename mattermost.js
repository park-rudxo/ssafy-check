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
//   - content script : manifest 의 content_scripts.js 에서 content.js 앞에 둔다
//                      (설정 완료 판정을 페이지 배너도 같은 함수로 해야 한다)

(function (root) {
  "use strict";

  // 이 호스트에만 런타임 권한을 요청한다 (manifest의 optional_host_permissions).
  const WEBHOOK_ORIGIN = "https://meeting.ssafy.com/*";
  const API_BASE = "https://meeting.ssafy.com/api/v4";
  const HOOK_BASE = "https://meeting.ssafy.com/hooks/";

  // Mattermost가 계정을 만들 때 요구하는 사용자명 규칙을 그대로 옮긴 것이었는데,
  // 실제로는 숫자로 시작하는 계정(예: SSAFY가 발급한 "9wxyz" 같은 아이디)도
  // 서버가 정상적으로 존재를 허용한다는 게 확인됐다. 그래서 첫 글자도 숫자를
  // 허용하도록 완화한다 - 그래야 자동 연동(provisionPersonalWebhook)이 서버에서
  // 그대로 받아온 내 username을 다시 이 정규식에 통과시켜도 false가 나지 않는다.
  // 즉 [첫 글자는 a-z 0-9] + [나머지 2~21자는 a-z 0-9 . - _] = 전체 3~22자.
  // 기호(. - _)로 시작하는 것만 막는다 - 그런 사용자명은 실제로 존재하지 않는다.
  // (한글 표시 이름이 아니라 프로필의 영문 사용자명)
  const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,21}$/;

  const ERR_EMPTY = "아직 설정되지 않았어요. [Mattermost 로그인하여 시작하기]를 눌러주세요.";
  const ERR_SHAPE =
    "사용자 아이디는 영문 소문자나 숫자로 시작하는 3~22자여야 하고, 숫자와 기호 . - _ 만 쓸 수 있어요 (예: @hong.gildong). 한글 표시 이름은 안 됩니다.";

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

  async function api(path, body, method) {
    const verb = method || (body === undefined ? "GET" : "POST");
    dlog("요청", { path, method: verb });
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method: verb,
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
      // 데스크탑 앱은 자기 저장소에 로그인 정보를 들고 있어서, 앱에 로그인해도
      // 크롬에는 쿠키가 생기지 않는다. 여기서 앱 얘기를 빼놓으면 "로그인했는데
      // 왜 안 되냐"로 돌아온다.
      throw new Error(
        "Mattermost에 로그인되어 있지 않아요. 데스크탑 앱 로그인은 인식되지 않습니다 — " +
          "이 크롬 브라우저에서 meeting.ssafy.com 웹페이지로 로그인한 뒤 다시 눌러주세요."
      );
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

  // ── 이미 만들어 둔 내 웹훅 ──────────────────────────────────────────
  // 예전에는 연결할 때마다 새 웹훅을 만들었다. 싸피는 자리 이동이 잦아서 자리를
  // 옮길 때마다 하나씩 늘어나고, 그 토큰은 떠나온 PC에 그대로 남는다. 다섯 대를
  // 거치면 내 계정 아래에 웹훅이 다섯 개다. 이미 있는 것을 다시 쓰면 더 늘지
  // 않는다.
  //
  // 서버가 주는 목록에는 권한에 따라 남의 것이 섞여 올 수 있다. 반드시 user_id
  // 로 내 것인지 확인한다 - 남의 웹훅을 물려받으면 내 알림이 그 사람 이름으로
  // 나가고, 지우는 쪽에서는 남의 것을 지우게 된다. 이 확장이 만든 것인지도
  // display_name 으로 같이 본다. 사람이 손으로 만든 웹훅은 건드리지 않는다.
  function isMyHook(hook, meId) {
    return !!(hook && hook.id && hook.user_id === meId && hook.display_name === HOOK_NAME);
  }

  async function listMyHooks(teamId, meId) {
    const hooks = await api(`/hooks/incoming?team_id=${encodeURIComponent(teamId)}&per_page=200`);
    return (Array.isArray(hooks) ? hooks : []).filter((h) => isMyHook(h, meId));
  }

  // 웹훅 주소에서 id 만 떼어낸다. 주소 모양이 아니면 빈 문자열.
  function hookIdOf(url) {
    const s = typeof url === "string" ? url.trim() : "";
    return s.startsWith(HOOK_BASE) ? s.slice(HOOK_BASE.length) : "";
  }

  // 내가 이 확장으로 만든 웹훅 중 지금 쓰는 것 하나만 남기고 지운다.
  // dryRun 이면 세어보기만 하고 아무것도 지우지 않는다.
  //   { found, extras, deleted, failed, keptId }
  //
  // 이미 뿌려진 웹훅을 회수할 방법은 이것뿐이다. 다만 아직 그 웹훅을 들고 있는
  // PC가 있으면 그 PC의 알림은 전송만 실패하며 조용히 멎는다. 그래서 이 함수는
  // 스스로 도는 일이 없고, 부르는 쪽이 그 사실을 먼저 알린 뒤 사용자가 직접
  // 누를 때만 불러야 한다.
  async function cleanupMyWebhooks(keepUrl, opts) {
    const dryRun = !!(opts && opts.dryRun);
    const me = await api("/users/me");
    if (!me || !me.id) throw new Error("내 계정 정보를 읽지 못했어요.");

    // 팀을 하나만 보면 다른 팀에 걸어둔 웹훅이 조용히 남는다. 살아 있는 팀을
    // 전부 훑는다 (보통 한 개다).
    const teams = await api("/users/me/teams");
    const live = (Array.isArray(teams) ? teams : []).filter((t) => t && t.id && !t.delete_at);
    if (!live.length) throw new Error("소속된 팀을 찾지 못했어요.");

    // id 로 모은다. 서버가 팀 필터를 무시하고 같은 웹훅을 여러 번 주더라도,
    // 같은 것을 두 번 지우려다 두 번째가 404로 떨어져 "실패 1건"으로 보이면
    // 안 된다.
    const byId = new Map();
    for (const t of live) {
      try {
        for (const h of await listMyHooks(t.id, me.id)) byId.set(h.id, h);
      } catch (e) {
        dlog("이 팀의 웹훅 목록을 읽지 못했다", { team: t.name, error: String(e && e.message ? e.message : e) });
      }
    }
    const mine = [...byId.values()];

    // 남길 것을 정한다. 지금 쓰는 웹훅이 목록에 있으면 그것을, 없으면(다른
    // 계정 것이거나 이미 지워졌으면) 가장 먼저 만든 것을 남긴다. 하나는 반드시
    // 남겨야 지금 이 PC의 알림까지 끊기지 않는다.
    const inUse = hookIdOf(keepUrl);
    const oldest = mine.slice().sort((a, b) => (a.create_at || 0) - (b.create_at || 0))[0];
    const keepId = mine.some((h) => h.id === inUse) ? inUse : oldest ? oldest.id : "";

    const extras = mine.filter((h) => h.id !== keepId);
    let deleted = 0;
    let failed = 0;
    if (!dryRun) {
      for (const h of extras) {
        try {
          await api(`/hooks/incoming/${encodeURIComponent(h.id)}`, undefined, "DELETE");
          deleted++;
        } catch (e) {
          failed++;
          dlog("웹훅을 지우지 못했다", { hookId: h.id, error: String(e && e.message ? e.message : e) });
        }
      }
    }

    dlog("웹훅 정리", { found: mine.length, extras: extras.length, deleted, failed, dryRun });
    return { found: mine.length, extras: extras.length, deleted, failed, keptId: keepId };
  }

  // 성공하면 { webhookUrl, channel, reused } 를 돌려준다. 실패는 throw로 알린다.
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

    // 이미 만들어 둔 것이 있으면 그걸 쓴다. 방금 확인한 채널에 걸린 것만
    // 물려받는다 - 다른 채널에 걸린 웹훅은 그 채널이 아직 살아 있는지 알 수
    // 없고, 없어진 채널의 웹훅을 물려받으면 전송이 조용히 실패한다.
    // channel_locked 인 웹훅도 거른다. 잠긴 웹훅으로는 DM을 보낼 수 없다.
    //
    // 목록을 못 읽는 계정도 있으므로(권한 등), 실패하면 예전처럼 새로 만드는
    // 쪽으로 조용히 물러난다. 여기서 막히면 설정 자체를 못 하게 된다.
    try {
      const mine = await listMyHooks(team.id, me.id);
      const reusable = mine.find((h) => h.channel_id === channelId && !h.channel_locked);
      if (reusable) {
        dlog("이미 있는 개인 웹훅을 다시 쓴다", { username: me.username, hookId: reusable.id, 가진개수: mine.length });
        return { webhookUrl: hookUrl(reusable.id), channel: "@" + me.username, reused: true };
      }
    } catch (e) {
      dlog("웹훅 목록을 읽지 못해 새로 만든다", { error: String(e && e.message ? e.message : e) });
    }

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
    return { webhookUrl: hookUrl(hook.id), channel: "@" + me.username, reused: false };
  }

  root.SsafyMattermost = {
    WEBHOOK_ORIGIN,
    HOME_URL,
    normalizeTarget,
    isValidTarget,
    isConfigured,
    pickWebhookUrl,
    provisionPersonalWebhook,
    cleanupMyWebhooks,
    hookIdOf,
    ERR_EMPTY,
    ERR_SHAPE,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
