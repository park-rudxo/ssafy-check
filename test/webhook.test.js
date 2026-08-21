// 개인 웹훅 발급(mattermost.js)의 회귀 테스트.
//
// 이 테스트가 있는 이유:
// "내 계정 연결하기"를 누를 때마다 웹훅을 새로 만들던 시절이 있었다. 웹훅은
// 지우기 전까지 살아 있으므로, 다시 연결할 때마다(기기를 옮기거나·설정을 다시
// 하거나·테스트하거나) 통합 목록에 좀비가 한 줄씩 쌓였다. 실제로 13개까지
// 늘어난 계정이 있었다. 그중 하나를 아직 들고 있는 옛 설치본이 어딘가에서
// 돌고 있으면, 그쪽이 자기가 아는 출석 상태로 메시지를 계속 보낸다 -
// 이미 출석을 마친 사람에게 "아직 입실 체크를 안 했어요"가 가는 것이다.
//
// 실행: npm test  (브라우저 없이 도는 순수 노드 테스트)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ME = { id: "me1", username: "corqjffp010" };
const TEAM = { id: "team1", name: "s16public" };
const CHANNEL = { id: "chan1" };

// mattermost.js 를 빈 컨텍스트에 올리고, Mattermost 서버를 흉내 낸 fetch 를
// 물려준다. hooks 는 서버에 이미 있는 웹훅 목록이다.
function load({ hooks = [], listFails = false } = {}) {
  const calls = [];
  const created = [];
  const sandbox = {
    console,
    async fetch(url, opts) {
      const method = opts.method;
      const p = url.replace(/^https?:\/\/[^/]+\/api\/v4/, "");
      calls.push(`${method} ${p}`);
      const ok = (body) => ({
        ok: true,
        status: 200,
        async json() {
          return body;
        },
        clone() {
          return this;
        },
        async text() {
          return "";
        },
      });
      if (p === "/users/me") return ok(ME);
      if (p === "/users/me/teams") return ok([TEAM]);
      if (p.startsWith(`/teams/${TEAM.id}/channels/name/`)) return ok(CHANNEL);
      if (p.startsWith("/hooks/incoming?")) {
        if (listFails) return { ok: false, status: 403, clone() { return this; }, async text() { return ""; }, async json() { return {}; } };
        return ok(hooks);
      }
      if (p === "/hooks/incoming" && method === "POST") {
        const made = { id: "newhook" + (created.length + 1), ...JSON.parse(opts.body), user_id: ME.id };
        created.push(made);
        return ok(made);
      }
      throw new Error("예상치 못한 요청: " + method + " " + p);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext("globalThis.self = globalThis;", sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "mattermost.js"), "utf8"), sandbox);
  return { MM: sandbox.SsafyMattermost, calls, created };
}

// 이 확장이 전에 만들어 둔 내 웹훅
const MINE = {
  id: "oldhook",
  user_id: ME.id,
  channel_id: CHANNEL.id,
  display_name: "SSAFY 출석 알리미",
};

test("전에 만들어 둔 내 웹훅이 있으면 새로 만들지 않고 그대로 쓴다", async () => {
  const { MM, created } = load({ hooks: [MINE] });
  const res = await MM.provisionPersonalWebhook();
  assert.equal(res.webhookUrl, "https://meeting.ssafy.com/hooks/oldhook");
  assert.equal(res.channel, "@corqjffp010");
  assert.equal(created.length, 0, "웹훅이 늘어나면 안 된다");
});

test("여러 번 연결해도 웹훅이 하나로 유지된다", async () => {
  // 첫 연결에서 만든 것을 서버가 그대로 들고 있는 상태로 다시 연결한다.
  const first = load();
  const a = await first.MM.provisionPersonalWebhook();
  assert.equal(first.created.length, 1, "처음에는 만들어야 한다");

  const again = load({ hooks: [{ ...first.created[0], channel_id: CHANNEL.id }] });
  const b = await again.MM.provisionPersonalWebhook();
  assert.equal(again.created.length, 0, "두 번째부터는 재사용해야 한다");
  assert.equal(b.webhookUrl, a.webhookUrl);
});

test("남이 만든 웹훅이나 손으로 만든 웹훅은 낚아채지 않는다", async () => {
  const others = [
    { id: "h1", user_id: "someone-else", channel_id: CHANNEL.id, display_name: "SSAFY 출석 알리미" },
    { id: "h2", user_id: ME.id, channel_id: "other-channel", display_name: "SSAFY 출석 알리미" },
    { id: "h3", user_id: ME.id, channel_id: CHANNEL.id, display_name: "싸피 출석체크방" },
  ];
  const { MM, created } = load({ hooks: others });
  const res = await MM.provisionPersonalWebhook();
  assert.equal(created.length, 1, "내 것이 없으면 새로 만들어야 한다");
  assert.equal(res.webhookUrl, "https://meeting.ssafy.com/hooks/newhook1");
});

test("목록을 못 읽어도 연결 자체는 성공한다", async () => {
  // 재사용은 덤이라, 목록 조회가 막힌 계정에서 연결이 실패하면 안 된다.
  const { MM, created } = load({ listFails: true });
  const res = await MM.provisionPersonalWebhook();
  assert.equal(created.length, 1);
  assert.match(res.webhookUrl, /\/hooks\/newhook1$/);
});
