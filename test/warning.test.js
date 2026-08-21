// 미체크 경고(background.js)의 회귀 테스트.
//
// 이 테스트가 있는 이유:
// 아침 09:30에 "09:00까지 2분/5분/10분 남았습니다"가 순서까지 뒤죽박죽으로
// 세 통 한꺼번에 온 적이 있다. 이미 입실을 마친 뒤였다. 크롬 알람은 예정
// 시각에 못 울리면(절전·크롬 종료) 사라지는 게 아니라 다시 깨어나는 순간
// 밀린 것들이 한꺼번에 울리는데, 그때 예정 시각만 믿고 보냈기 때문이다.
// 눈에 잘 띄는 사고인데 재현하려면 절전을 흉내내야 해서 자동으로 잡아둔다.
//
// 실행: npm test  (브라우저 없이 도는 순수 노드 테스트)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

// background.js는 서비스 워커라 require로 못 읽는다. 확장이 실제로 쓰는
// chrome API만 흉내 낸 빈 컨텍스트에서 통째로 실행하고, 그 안의 함수를
// 꺼내 부른다.
function loadBackground({ now, storage }) {
  const posts = [];
  const listener = { addListener() {} };
  const store = { ...storage };

  const sandbox = {
    console,
    // 시각을 고정한다. 인자 없는 new Date()만 "지금"으로 바꿔치기한다.
    Date: class extends Date {
      constructor(...args) {
        if (args.length === 0) super(now.getTime());
        else super(...args);
      }
    },
    chrome: {
      storage: {
        // 확장 코드가 콜백식(debug.js)과 프라미스식(background.js)을 섞어 쓴다.
        local: {
          get(key, cb) {
            const keys = Array.isArray(key) ? key : [key];
            const out = {};
            for (const k of keys) if (k in store) out[k] = store[k];
            if (cb) return void cb(out);
            return Promise.resolve(out);
          },
          set(obj, cb) {
            Object.assign(store, obj);
            if (cb) return void cb();
            return Promise.resolve();
          },
        },
        onChanged: listener,
      },
      alarms: { create() {}, async clear() {}, onAlarm: listener },
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener },
      notifications: { create() {}, onClicked: listener },
      tabs: { create() {} },
    },
    // 실제로 나가는 메시지를 여기서 가로챈다.
    async fetch(url, opts) {
      posts.push(JSON.parse(opts.body).attachments[0].text);
      return { ok: true, async text() { return ""; } };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext("globalThis.self = globalThis;", sandbox);
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox);
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), sandbox);
  return { sandbox, posts, store };
}

// 2026-08-20(목)은 평일이고 공휴일이 아니다.
function at(h, m) {
  return new Date(2026, 7, 20, h, m, 0, 0);
}

const SETTINGS = {
  mattermost: {
    enabled: true,
    channel: "@hong",
    webhookUrl: "https://meeting.ssafy.com/hooks/abcdefghijklmnopqrstuvwxyz",
    notifyCheckin: true,
    notifyCheckout: true,
    notifyMissing: true,
  },
};

const CHECKIN_WARNS = [8 * 60 + 50, 8 * 60 + 55, 8 * 60 + 58];

test("예정 시각에 울린 경고는 그대로 보낸다", async () => {
  for (const min of CHECKIN_WARNS) {
    const { sandbox, posts } = loadBackground({ now: at(Math.floor(min / 60), min % 60), storage: SETTINGS });
    await sandbox.handleMattermostWarning(min);
    assert.equal(posts.length, 1, `${min}분 경고는 제 시각에 가야 한다`);
    assert.match(posts[0], /아직 입실 체크를 안 했어요/);
  }
});

test("절전에서 깨어나 밀린 경고가 한꺼번에 울려도 보내지 않는다", async () => {
  // 09:30에 크롬이 켜지면서 08:50·08:55·08:58 알람이 몰려 울리는 상황.
  const { sandbox, posts } = loadBackground({ now: at(9, 30), storage: SETTINGS });
  for (const min of CHECKIN_WARNS) await sandbox.handleMattermostWarning(min);
  assert.deepEqual(posts, [], "지나간 경고는 한 통도 가면 안 된다");
});

test("퇴실 경고도 지나간 알람은 보내지 않는다", async () => {
  // 18:30 알람이 다음 날 아침에야 울린 경우까지 포함한다.
  for (const [now, min] of [
    [at(19, 40), 18 * 60],
    [at(19, 40), 18 * 60 + 30],
    [at(8, 10), 18 * 60 + 30],
  ]) {
    const { sandbox, posts } = loadBackground({ now, storage: SETTINGS });
    await sandbox.handleMattermostWarning(min);
    assert.deepEqual(posts, [], `${min}분 경고가 ${now.getHours()}시에 가면 안 된다`);
  }
});

test("몇 분 늦게 울리면 남은 시간을 지금 기준으로 다시 센다", async () => {
  // 08:50 알람이 08:52에 울려도 "10분 남았습니다"라고 하면 안 된다.
  const { sandbox, posts } = loadBackground({ now: at(8, 52), storage: SETTINGS });
  await sandbox.handleMattermostWarning(8 * 60 + 50);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /8분 남았습니다/);
});

test("같은 시각의 경고는 알람이 두 번 울려도 한 번만 보낸다", async () => {
  const { sandbox, posts } = loadBackground({ now: at(8, 50), storage: SETTINGS });
  await sandbox.handleMattermostWarning(8 * 60 + 50);
  await sandbox.handleMattermostWarning(8 * 60 + 50);
  assert.equal(posts.length, 1);
});

test("이미 입실했으면 제 시각에 울려도 보내지 않는다", async () => {
  const { sandbox, posts } = loadBackground({
    now: at(8, 55),
    storage: {
      ...SETTINGS,
      // 위젯에서 읽은 서버 기준 입실 시각 (폰으로 눌렀어도 여기 찍힌다)
      attendance: { date: "2026-08-20", checkinMin: null, checkoutMin: null, pageCheckinMin: 8 * 60 + 40, pageCheckoutMin: null },
    },
  });
  await sandbox.handleMattermostWarning(8 * 60 + 55);
  assert.deepEqual(posts, []);
});
