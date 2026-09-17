// Mattermost "받을 곳" 검증(mattermost.js)의 회귀 테스트.
//
// 이 테스트가 있는 이유:
// 받을 곳을 비운 채로 연동을 켜면 웹훅을 걸어둔 채널로 메시지가 가서, 한
// 사람의 미체크 경고가 그 방 전체에 반복해서 울린다. 아이디는 이제 서버에서
// 읽어오므로 사람이 비워둘 일은 없지만, 예전 버전에서 저장된 값이 남아 있을
// 수 있어 판정 자체는 그대로 살아 있어야 한다. 설정 화면 세 곳(팝업·설치
// 화면·백그라운드)이 모두 이 판정을 쓰므로, 규칙이 조용히 느슨해지면 사고가
// 그대로 재발한다.
//
// 실행: npm test  (브라우저 없이 도는 순수 노드 테스트)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// mattermost.js는 전역(globalThis.SsafyMattermost)에 붙는 브라우저용 모듈이라
// require로 못 읽는다. 빈 컨텍스트에서 실행해 그 전역을 꺼내 쓴다.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "mattermost.js"), "utf8"), sandbox);
const MM = sandbox.SsafyMattermost;

test("받을 곳을 비우면 거절한다 (채널 전체 알림 방지)", () => {
  for (const v of ["", "   ", null, undefined, "@", "@@"]) {
    const res = MM.normalizeTarget(v);
    assert.equal(res.ok, false, `${JSON.stringify(v)} 는 거절되어야 한다`);
    // 무엇을 해야 하는지 알려주는 안내여야 한다. "잘못됐다"만 있으면
    // 사용자는 어디를 눌러야 할지 모른다.
    assert.match(res.error, /시작하기|연결/);
  }
});

test("@아이디를 받아들이고 항상 @가 붙은 형태로 다듬는다", () => {
  const cases = [
    ["@hong", "@hong"],
    ["hong", "@hong"], // @를 빼먹어도 DM으로 보정
    ["  @hong.gildong  ", "@hong.gildong"],
    ["@Hong_Gil-Dong", "@hong_gil-dong"], // 사용자명은 소문자
    ["\n@hong\t", "@hong"], // 붙여넣기 부스러기(앞뒤 공백)는 걷어낸다
  ];
  for (const [input, expected] of cases) {
    const res = MM.normalizeTarget(input);
    assert.equal(res.ok, true, `${input} 는 통과해야 한다`);
    assert.equal(res.value, expected);
  }
});

// Mattermost의 사용자명 규칙 그대로:
// "문자로 시작해야 하며 3~22 사이의 숫자, 문자 및 기호 '.', '-', '_'로
//  구성된 소문자로 구성되어야 합니다."
// 규칙보다 느슨해지면 존재할 수 없는 아이디를 통과시켜 전송이 조용히
// 실패하고, 규칙보다 빡빡해지면 멀쩡한 사람이 설정을 못 한다.
test("사용자명 규칙: 길이 경계 3~22자", () => {
  assert.equal(MM.isValidTarget("a".repeat(2)), false, "2자는 짧다");
  assert.equal(MM.isValidTarget("a".repeat(3)), true, "3자는 된다");
  assert.equal(MM.isValidTarget("a".repeat(22)), true, "22자는 된다");
  assert.equal(MM.isValidTarget("a".repeat(23)), false, "23자는 길다");
  // @ 는 길이에 세지 않는다 (입력 편의를 위해 붙였다 떼는 표시일 뿐)
  assert.equal(MM.isValidTarget("@" + "a".repeat(22)), true);
});

test("사용자명 규칙: 첫 글자는 문자 또는 숫자여야 한다 (기호 시작은 거절)", () => {
  // SSAFY가 발급하는 계정 중에는 "9wxyz"처럼 숫자로 시작하는 실제 사용자명이
  // 있어서, 이걸 거절하면 그 계정은 연동에 영원히 성공할 수 없다 (버튼이 계속
  // 비활성화 상태로 남는 실제 버그였다). 그래서 숫자 시작은 허용하고, 실제로
  // 존재할 수 없는 기호 시작만 거절한다.
  for (const v of [".hong", "-hong", "_hong"]) {
    assert.equal(MM.isValidTarget(v), false, `${v} 는 기호로 시작해 거절되어야 한다`);
  }
  assert.equal(MM.isValidTarget("h9team"), true);
  assert.equal(MM.isValidTarget("9team"), true);
  assert.equal(MM.isValidTarget("1a2"), true);
  assert.equal(MM.isValidTarget("9wxyz"), true);
});

test("사용자명 규칙: 숫자·문자와 . - _ 만 쓸 수 있다", () => {
  assert.equal(MM.isValidTarget("hong.gil-dong_9"), true);
  for (const v of ["team!", "hong+gil", "hong@gil", "hong/gil", "hong#1"]) {
    assert.equal(MM.isValidTarget(v), false, `${v} 에는 쓸 수 없는 기호가 있다`);
  }
});

test("가운데 공백은 이어붙이지 않고 거절한다", () => {
  // 이어붙이면 "honggil"이라는 없는 아이디가 만들어져, 전송이 왜 실패하는지
  // 알 수 없게 된다. 규칙에 공백은 없으므로 그대로 거절하고 고치게 한다.
  const res = MM.normalizeTarget("@hong gil");
  assert.equal(res.ok, false);
  assert.equal(res.value, "@hong gil"); // 친 그대로 되돌려준다
});

test("사용자명 규칙: 한글 표시 이름은 거절한다", () => {
  for (const v of ["박경도", "@박경도", "hong길동"]) {
    assert.equal(MM.isValidTarget(v), false, `${v} 는 거절되어야 한다`);
  }
});

test("채널명처럼 보이는 값도 채널이 아니라 DM으로 나간다", () => {
  // 사용자명과 채널명은 생김새가 같아 구분할 수 없다. 그래서 무조건 @를
  // 붙여 DM으로만 보낸다. 없는 사용자명이면 Mattermost가 오류를 돌려줄 뿐,
  // 채널에 뿌려지는 일은 없다.
  const res = MM.normalizeTarget("town-square");
  assert.equal(res.ok, true);
  assert.equal(res.value, "@town-square");
});

test("거절해도 입력값은 되돌려준다 (입력창에 다시 채우기 위함)", () => {
  const res = MM.normalizeTarget("박경도");
  assert.equal(res.ok, false);
  assert.equal(res.value, "@박경도");
});

test("웹훅은 SSAFY Mattermost 하나로 고정되어 있다", () => {
  // 주소가 바뀌면 아무에게도 알림이 가지 않는데 조용히 실패하므로, 여기에
  // 박아두고 바뀔 때 눈에 띄게 한다. 권한 요청 호스트도 같은 곳이어야 한다.
  assert.equal(MM.WEBHOOK_URL, undefined, "공용 웹훅은 더 이상 두지 않는다");
  assert.equal(MM.WEBHOOK_ORIGIN, "https://meeting.ssafy.com/*");
  assert.equal(MM.WEBHOOK_ORIGIN, "https://meeting.ssafy.com/*");

  // manifest에 없는 호스트는 권한을 요청할 수 없다. 웹훅 주소만 바꾸고
  // manifest를 안 고치면 "권한을 허용해야..."에서 영영 막힌다.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.optional_host_permissions, [MM.WEBHOOK_ORIGIN]);
});

test("isValidTarget은 normalizeTarget의 판정과 같다", () => {
  assert.equal(MM.isValidTarget("@hong"), true);
  assert.equal(MM.isValidTarget(""), false);
  assert.equal(MM.isValidTarget("박경도"), false);
});

// ── 개인 웹훅 고르기 ──────────────────────────────────────────────────
// 개인 웹훅이 있으면 그걸 써야 공용 웹훅 주인에게 남의 출석 알림이 가지 않는다.
// 반대로 저장된 값이 엉뚱하면 조용히 아무 데도 안 보내는 것보다 공용으로
// 물러나는 편이 낫다 - 알림이 끊기는 쪽이 사용자에게 더 나쁜 실패다.
test("개인 웹훅이 있으면 그걸 쓴다", () => {
  const own = "https://meeting.ssafy.com/hooks/aaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(MM.pickWebhookUrl({ webhookUrl: own }), own);
  assert.equal(MM.pickWebhookUrl({ webhookUrl: "  " + own + "  " }), own);
});

test("내 웹훅이 없거나 모양이 이상하면 아무 데도 보내지 않는다", () => {
  // 예전에는 여기서 공용 웹훅으로 물러났다. 그 길이 있으면 자동 연결이 안 된
  // 사람의 알림이 조용히 공용 웹훅 주인에게 흘러가므로, 빈 값이어야 한다.
  for (const v of [undefined, null, "", "   ", 123, "https://evil.example/hooks/x", "hooks/x"]) {
    assert.equal(MM.pickWebhookUrl({ webhookUrl: v }), "", `${JSON.stringify(v)}`);
  }
  assert.equal(MM.pickWebhookUrl(undefined), "");
  assert.equal(MM.pickWebhookUrl({}), "");
});

// ── 필수 설정 판정 ────────────────────────────────────────────────────
// 팝업·설치 화면·페이지 배너가 모두 이 판정 하나로 움직인다. 여기가 느슨해지면
// 설정이 안 끝났는데 끝난 것처럼 보이고, 사용자는 "설치했는데 아무 일도
// 안 일어난다"만 겪게 된다.
test("설정 완료는 연동이 켜져 있고 내 웹훅과 내 아이디가 다 있을 때만", () => {
  const hook = "https://meeting.ssafy.com/hooks/aaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(MM.isConfigured({ enabled: true, webhookUrl: hook, channel: "@hong.gildong" }), true);
  assert.equal(MM.isConfigured({ enabled: true, webhookUrl: hook, channel: "hong.gildong" }), true);

  assert.equal(MM.isConfigured({ enabled: false, webhookUrl: hook, channel: "@hong" }), false, "꺼져 있으면 미완료");
  assert.equal(MM.isConfigured({ enabled: true, webhookUrl: "", channel: "@hong" }), false, "웹훅이 없으면 미완료");
  assert.equal(MM.isConfigured({ enabled: true, webhookUrl: hook, channel: "" }), false, "받을 곳이 비면 미완료");
  assert.equal(MM.isConfigured({ enabled: true, webhookUrl: hook, channel: "홍길동" }), false, "한글 이름은 미완료");
  assert.equal(MM.isConfigured(null), false);
  assert.equal(MM.isConfigured(undefined), false);
  assert.equal(MM.isConfigured({}), false);
});

// ── 웹훅 재사용과 정리 ────────────────────────────────────────────────
// 예전에는 연결할 때마다 새 웹훅을 만들었다. 싸피는 자리 이동이 잦아서 옮길
// 때마다 하나씩 늘고, 그 토큰은 떠나온 PC에 그대로 남는다. 다섯 대를 거치면
// 계정 아래에 웹훅이 다섯 개다. 이미 있는 것을 다시 쓰면 더 늘지 않는다.

const HOOK_NAME = "SSAFY 출석 알리미";

// mattermost.js 가 쓰는 API 만 흉내 낸 가짜 서버 위에서 모듈을 올린다.
// hooks 는 서버에 이미 있는 웹훅 목록, listStatus 는 목록 조회 응답 코드다.
function loadWithServer(opts) {
  const o = opts || {};
  const server = {
    me: o.me || { id: "u1", username: "hong" },
    teams: o.teams || [{ id: "t1", name: "ssafy" }],
    hooks: (o.hooks || []).map((h) => ({ ...h })),
    listStatus: o.listStatus || 200,
    created: [],
    deleted: [],
    calls: [],
  };

  const json = (body, status) => ({
    ok: (status || 200) < 400,
    status: status || 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone: () => json(body, status),
  });

  const sandbox = {
    console,
    fetch: async (url, init) => {
      const method = (init && init.method) || "GET";
      const path = String(url).replace("https://meeting.ssafy.com/api/v4", "");
      server.calls.push(`${method} ${path}`);

      if (path === "/users/me") return json(server.me);
      if (path === "/users/me/teams") return json(server.teams);
      if (/^\/teams\/[^/]+\/channels\/name\/ssafy-attendance$/.test(path)) return json({ id: "c1" });
      if (path.startsWith("/hooks/incoming?")) {
        if (server.listStatus !== 200) return json({ message: "no" }, server.listStatus);
        return json(server.hooks);
      }
      if (path === "/hooks/incoming" && method === "POST") {
        const made = { id: "new" + (server.created.length + 1) };
        server.created.push(JSON.parse(init.body));
        return json(made);
      }
      const del = /^\/hooks\/incoming\/(.+)$/.exec(path);
      if (del && method === "DELETE") {
        server.deleted.push(del[1]);
        server.hooks = server.hooks.filter((h) => h.id !== del[1]);
        return json({ status: "OK" });
      }
      return json({ message: "not found" }, 404);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "mattermost.js"), "utf8"), sandbox);
  return { MM: sandbox.SsafyMattermost, server };
}

// 이 확장이 내 계정으로 만든, 멀쩡히 쓸 수 있는 웹훅.
function myHook(id, extra) {
  return { id, user_id: "u1", display_name: HOOK_NAME, channel_id: "c1", channel_locked: false, ...extra };
}

test("이미 만들어 둔 웹훅이 있으면 새로 만들지 않고 그걸 쓴다", async () => {
  const { MM, server } = loadWithServer({ hooks: [myHook("h1")] });

  const res = await MM.provisionPersonalWebhook();

  assert.equal(res.webhookUrl, "https://meeting.ssafy.com/hooks/h1");
  assert.equal(res.reused, true, "다시 쓴 것인지 부르는 쪽이 알아야 한다");
  assert.equal(server.created.length, 0, "자리를 옮길 때마다 웹훅이 하나씩 늘던 것이 이 문제였다");
});

test("쓸 수 있는 웹훅이 없으면 예전처럼 새로 만든다", async () => {
  const { MM, server } = loadWithServer({ hooks: [] });

  const res = await MM.provisionPersonalWebhook();

  assert.equal(res.webhookUrl, "https://meeting.ssafy.com/hooks/new1");
  assert.equal(res.reused, false);
  assert.equal(server.created.length, 1);
});

test("남의 웹훅이나 손으로 만든 웹훅은 물려받지 않는다", async () => {
  // 목록에는 권한에 따라 남의 것이 섞여 올 수 있다. 남의 웹훅을 물려받으면
  // 내 알림이 그 사람 이름으로 나가고, 정리할 때 남의 것을 지우게 된다.
  const { MM, server } = loadWithServer({
    hooks: [
      myHook("other", { user_id: "u2" }), // 남의 것
      myHook("manual", { display_name: "내가 손으로 만든 것" }), // 이 확장이 만든 게 아님
      myHook("locked", { channel_locked: true }), // 잠긴 웹훅으로는 DM을 못 보낸다
      myHook("elsewhere", { channel_id: "c9" }), // 살아 있는지 알 수 없는 채널
    ],
  });

  const res = await MM.provisionPersonalWebhook();

  assert.equal(res.reused, false, "하나도 물려받으면 안 된다");
  assert.equal(server.created.length, 1, "대신 새로 만들어야 한다");
});

test("목록을 못 읽는 계정은 예전처럼 새로 만든다", async () => {
  // 여기서 막히면 설정 자체를 못 하게 된다. 재사용은 덤이지 관문이 아니다.
  const { MM, server } = loadWithServer({ hooks: [myHook("h1")], listStatus: 403 });

  const res = await MM.provisionPersonalWebhook();

  assert.equal(res.webhookUrl, "https://meeting.ssafy.com/hooks/new1");
  assert.equal(server.created.length, 1);
});

test("정리하면 지금 쓰는 것만 남기고 내 웹훅을 지운다", async () => {
  const { MM, server } = loadWithServer({
    hooks: [myHook("h1"), myHook("h2"), myHook("h3"), myHook("h4"), myHook("h5")],
  });

  const res = await MM.cleanupMyWebhooks("https://meeting.ssafy.com/hooks/h3");

  assert.equal(res.found, 5);
  assert.equal(res.deleted, 4);
  assert.equal(res.keptId, "h3", "지금 쓰는 것을 지우면 이 PC의 알림까지 끊긴다");
  assert.deepEqual(server.deleted.sort(), ["h1", "h2", "h4", "h5"]);
});

test("정리는 남의 웹훅과 손으로 만든 웹훅을 건드리지 않는다", async () => {
  const { MM, server } = loadWithServer({
    hooks: [
      myHook("mine1"),
      myHook("mine2"),
      myHook("other", { user_id: "u2" }),
      myHook("manual", { display_name: "내 개인 알림" }),
    ],
  });

  const res = await MM.cleanupMyWebhooks("https://meeting.ssafy.com/hooks/mine1");

  assert.equal(res.found, 2, "내가 이 확장으로 만든 것만 센다");
  assert.deepEqual(server.deleted, ["mine2"]);
});

test("세어보기(dryRun)는 아무것도 지우지 않는다", async () => {
  // 팝업은 몇 개가 지워지는지 먼저 보여주고, 한 번 더 눌러야 지운다.
  const { MM, server } = loadWithServer({ hooks: [myHook("h1"), myHook("h2"), myHook("h3")] });

  const res = await MM.cleanupMyWebhooks("https://meeting.ssafy.com/hooks/h1", { dryRun: true });

  assert.equal(res.found, 3);
  assert.equal(res.extras, 2, "몇 개가 지워지는지 미리 알려줘야 한다");
  assert.equal(res.deleted, 0);
  assert.deepEqual(server.deleted, [], "세어보기만 해도 지워지면 되돌릴 수 없다");
});

test("지금 쓰는 웹훅이 목록에 없어도 하나는 남긴다", async () => {
  // 이미 지워졌거나 다른 계정 것일 수 있다. 전부 지워버리면 남는 게 없다.
  const { MM, server } = loadWithServer({
    hooks: [myHook("old2", { create_at: 200 }), myHook("old1", { create_at: 100 })],
  });

  const res = await MM.cleanupMyWebhooks("https://meeting.ssafy.com/hooks/사라진것");

  assert.equal(res.keptId, "old1", "가장 먼저 만든 것을 남긴다");
  assert.deepEqual(server.deleted, ["old2"]);
});

test("여러 팀에 걸린 웹훅도 빠뜨리지 않는다", async () => {
  const { MM, server } = loadWithServer({
    teams: [
      { id: "t1", name: "a" },
      { id: "t2", name: "b" },
    ],
    hooks: [myHook("h1"), myHook("h2")],
  });

  // 가짜 서버는 팀과 무관하게 같은 목록을 주므로, 팀 수만큼 조회가 나가고
  // 같은 웹훅이 두 번 보인다. 팀을 하나만 보고 끝내지 않는다는 것과, 그렇게
  // 겹쳐 보여도 같은 것을 두 번 지우려 들지 않는다는 것을 함께 본다.
  const res = await MM.cleanupMyWebhooks("https://meeting.ssafy.com/hooks/h1");

  const listCalls = server.calls.filter((c) => c.includes("/hooks/incoming?"));
  assert.equal(listCalls.length, 2, "팀을 하나만 보면 다른 팀의 웹훅이 조용히 남는다");
  assert.equal(res.found, 2, "같은 웹훅이 겹쳐 보여도 두 개로 세면 안 된다");
  assert.deepEqual(server.deleted, ["h2"], "같은 것을 두 번 지우려 들면 두 번째가 실패로 잡힌다");
  assert.equal(res.failed, 0);
});

test("hookIdOf 는 우리 웹훅 주소에서만 id를 떼어낸다", () => {
  const { MM } = loadWithServer({});
  assert.equal(MM.hookIdOf("https://meeting.ssafy.com/hooks/abc123"), "abc123");
  assert.equal(MM.hookIdOf("  https://meeting.ssafy.com/hooks/abc123  "), "abc123");
  assert.equal(MM.hookIdOf("https://evil.example.com/hooks/abc123"), "", "남의 도메인은 받지 않는다");
  assert.equal(MM.hookIdOf(""), "");
  assert.equal(MM.hookIdOf(null), "");
});

// ── 연결한 계정의 이름 ────────────────────────────────────────────────
// edu 화면에는 한글 이름이 뜨는데 Mattermost 의 username 은 corqjffp010 같은
// 아이디라 비교가 안 된다. 게다가 실제 SSAFY 계정의 이름에는 반 정보가 붙어
// 온다 - "박경태[서울_3반]". 그래서 이름 칸을 통째로 들고 있다가 "한글 이름이
// 그 안에 들어 있는가"로 맞춘다.

// vm 컨텍스트가 만든 배열은 호스트의 Array 와 프로토타입이 달라서, 내용이
// 같아도 deepStrictEqual 이 거절한다. 내용만 보려고 호스트 배열로 옮긴다.
const names = (v) => Array.from(v || []);

test("반 정보가 붙은 실제 이름을 그대로 들고 있는다", () => {
  const { MM } = loadWithServer({});
  // 예전에는 순수 한글만 받아서 이 형태가 통째로 버려졌고, 그러면 이름 대조가
  // 아예 안 걸린다.
  assert.deepEqual(names(MM.ownerNameHints({ nickname: "박경태[서울_3반]" })), ["박경태[서울_3반]"]);
});

test("반 정보가 붙어 있어도 본인으로 본다", () => {
  const { MM } = loadWithServer({});
  const hints = names(MM.ownerNameHints({ nickname: "박경태[서울_3반]" }));

  assert.equal(MM.matchesOwnerName(hints, "박경태"), true, "edu 에는 이름만 뜬다");
  assert.equal(MM.matchesOwnerName(hints, "박 경태"), true, "사이 공백은 걷어낸다");
  assert.equal(MM.matchesOwnerName(hints, "김철수"), false, "남까지 통과시키면 기능이 없는 것과 같다");
  assert.equal(MM.matchesOwnerName(hints, ""), false, "이름을 못 읽었으면 판단 근거가 없다");
});

test("성과 이름이 칸으로 나뉘어 있어도 맞춘다", () => {
  // 어느 칸에 무엇이 들어가는지는 계정마다 다를 수 있어 순서를 짐작하지 않는다.
  const { MM } = loadWithServer({});
  for (const me of [
    { last_name: "박", first_name: "경태[서울_3반]" },
    { first_name: "경태", last_name: "박" },
    { nickname: "박경태" },
  ]) {
    const hints = names(MM.ownerNameHints(me));
    assert.equal(MM.matchesOwnerName(hints, "박경태"), true, `${JSON.stringify(me)} 에서 본인을 못 찾았다`);
  }
});

test("한글이 없는 값은 후보로 쓰지 않는다", () => {
  // 영문 아이디를 후보로 남기면 edu 의 한글 이름과 무엇도 맞지 않아, 정작
  // 본인이 주인으로 잡히지 못하고 확장이 통째로 멎는다. 후보가 비면 예전처럼
  // 처음 본 계정을 주인으로 잡는다.
  const { MM } = loadWithServer({});
  for (const me of [
    { username: "corqjffp010" },
    { first_name: "Gildong", last_name: "Hong" },
    { nickname: "hong[seoul_3]" },
    {},
    null,
  ]) {
    assert.deepEqual(names(MM.ownerNameHints(me)), [], `${JSON.stringify(me)} 는 후보가 없어야 한다`);
  }
});

test("문구에 쓸 이름은 반 정보를 뺀다", () => {
  // "박경태[서울_3반]님을 본 적이 없어요" 는 읽기 나쁘다.
  const { MM } = loadWithServer({});
  assert.equal(MM.displayOwnerName("박경태[서울_3반]"), "박경태");
  assert.equal(MM.displayOwnerName("박경태 (서울 3반)"), "박경태");
  assert.equal(MM.displayOwnerName("서울3반_박경태"), "서울");  // 이름이 뒤면 앞의 한글을 집는다
  assert.equal(MM.displayOwnerName("hong"), "", "뽑을 게 없으면 부르는 쪽이 원본을 쓴다");
});

test("연결 결과에 이름이 실려 온다", async () => {
  const { MM } = loadWithServer({
    me: { id: "u1", username: "corqjffp010", nickname: "박경태[서울_3반]" },
    hooks: [],
  });

  const res = await MM.provisionPersonalWebhook();

  assert.equal(res.channel, "@corqjffp010", "받는 곳은 지금까지처럼 username 이다");
  assert.deepEqual(names(res.ownerNames), ["박경태[서울_3반]"], "주인 판정에 쓸 이름은 따로 실어야 한다");
});

test("웹훅을 물려받을 때도 이름이 실려 온다", async () => {
  const { MM } = loadWithServer({
    me: { id: "u1", username: "corqjffp010", nickname: "박경태[서울_3반]" },
    hooks: [myHook("h1")],
  });

  const res = await MM.provisionPersonalWebhook();

  assert.equal(res.reused, true);
  assert.deepEqual(names(res.ownerNames), ["박경태[서울_3반]"], "다시 쓰는 경로에서 빠지면 그쪽만 예전처럼 동작한다");
});
