// "남의 출석이 내 알림으로 오는" 사고(background.js)의 회귀 테스트.
//
// 이 테스트가 있는 이유:
// 시험날 자리를 옮겨 앉으면서, A의 PC(크롬은 A로 로그인된 채)에 B가 앉아
// 자기 아이디로 edu.ssafy.com 에 로그인해 입실을 눌렀다. 확장의 Mattermost
// 설정은 크롬 프로필에 붙어 있어서, B의 입실이 A에게 "✅ 입실 체크 완료"로
// 갔다. A는 아직 오지도 않았는데 자기가 체크된 줄 알게 되고, 그 기록이 A의
// 오늘치로 저장되는 바람에 "아직 입실 안 했어요" 경고까지 멎는다.
// 이 확장이 막으려던 상황을 이 확장이 만들어내는 셈이라, 조용히 재발하면
// 특히 위험하다.
//
// 실행: npm test  (브라우저 없이 도는 순수 노드 테스트)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

// background.js는 서비스 워커라 require로 못 읽는다. 워커가 쓰는 API만
// 흉내 낸 컨텍스트에서 통째로 실행하고, 거기 선언된 함수를 직접 부른다.
// (importScripts로 불러오는 debug/holidays/mattermost 도 같은 컨텍스트에 올린다)
function loadBackground() {
  const posts = []; // Mattermost로 나간 메시지
  const notes = []; // 크롬 알림
  const store = {};

  const listeners = { addListener() {} };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    },
    chrome: {
      alarms: { create() {}, clear() {}, onAlarm: listeners },
      tabs: { create() {} },
      notifications: {
        create(id, opts) {
          notes.push(opts);
        },
        clear() {},
        onClicked: listeners,
      },
      runtime: {
        onMessage: listeners,
        onInstalled: listeners,
        onStartup: listeners,
        getURL: (p) => "chrome-extension://test/" + p,
      },
      storage: {
        onChanged: listeners,
        local: {
          async get(keys) {
            const list = typeof keys === "string" ? [keys] : keys;
            const out = {};
            for (const k of list) if (k in store) out[k] = store[k];
            return out;
          },
          async set(obj) {
            Object.assign(store, obj);
          },
          async remove(k) {
            delete store[k];
          },
        },
      },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), sandbox, { filename: "background.js" });

  // 연동은 끝난 상태에서 시작한다. 그래야 "보냈는지"로 판정할 수 있다.
  store.mattermost = {
    enabled: true,
    channel: "@hong",
    webhookUrl: "https://meeting.ssafy.com/hooks/abcdefghijklmnop",
    notifyCheckin: true,
    notifyCheckout: true,
    notifyMissing: true,
  };

  return { sandbox, store, posts, notes };
}

// 나간 메시지 본문을 한 줄로 합친다 (attachments 안에 들어 있다).
function textOf(post) {
  return (post.body.attachments || []).map((a) => a.text || "").join("\n");
}

function sent(posts, re) {
  return posts.filter((p) => re.test(textOf(p)));
}

test("처음 본 계정을 이 브라우저의 주인으로 기억한다", async () => {
  const { sandbox, store, posts } = loadBackground();

  await sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "홍길동" });

  assert.equal(store.eduAccount.name, "홍길동", "처음 본 이름이 주인으로 저장되어야 한다");
  assert.equal(sent(posts, /입실 체크 완료/).length, 1, "주인의 입실은 평소대로 알려야 한다");
});

test("주인이 아닌 계정의 입실은 알리지도, 오늘치로 기록하지도 않는다", async () => {
  const { sandbox, store, posts, notes } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: "2026-08-24" };

  // B가 A의 크롬에서 자기 아이디로 로그인해 입실을 누른 상황.
  await sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "김철수" });

  assert.equal(sent(posts, /입실 체크 완료/).length, 0, "남의 입실을 '완료'로 알리면 안 된다");
  assert.equal(
    store.attendance == null || store.attendance.checkinMin == null,
    true,
    "남의 입실을 내 오늘치로 저장하면 '아직 입실 안 했어요' 경고까지 멎는다"
  );

  // 조용히 버리기만 하면 주인은 아무것도 모른 채 하루를 보낸다.
  assert.equal(sent(posts, /다른 계정/).length, 1, "주인에게 사정을 한 번은 알려야 한다");
  assert.equal(notes.length, 1, "그 자리에 앉은 사람에게도 크롬 알림으로 알려야 한다");
  const text = textOf(sent(posts, /다른 계정/)[0]);
  assert.match(text, /홍길동/, "누구의 크롬인지 적어야 한다");
  assert.match(text, /김철수/, "지금 누가 로그인해 있는지 적어야 한다");
});

test("주인이 아닌 계정의 위젯 관찰도 내 상태를 덮어쓰지 않는다", async () => {
  const { sandbox, store, posts } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: "2026-08-24" };

  await sandbox.handleAttendanceObserved({ checkinMin: 8 * 60 + 16, checkoutMin: null, account: "김철수" });

  assert.equal(sent(posts, /입실 체크 완료/).length, 0, "위젯에서 읽은 남의 시각도 알리면 안 된다");
  assert.equal(
    store.attendance == null || store.attendance.pageCheckinMin == null,
    true,
    "남의 출석 상태를 내 오늘치로 저장하면 안 된다"
  );
});

test("경고는 하루 한 번만 간다 (화면을 볼 때마다 보고가 온다)", async () => {
  const { sandbox, store, posts, notes } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: "2026-08-24" };

  for (let i = 0; i < 5; i++) {
    await sandbox.handleAttendanceObserved({ checkinMin: 8 * 60 + 16, checkoutMin: null, account: "김철수" });
  }

  assert.equal(sent(posts, /다른 계정/).length, 1, "같은 사정을 반복해서 보내면 그게 새로운 소음이 된다");
  assert.equal(notes.length, 1);
});

test("이름을 못 읽으면 예전처럼 그대로 알린다", async () => {
  // 사이트 구조가 바뀌어 이름을 못 읽게 되는 순간 모두의 알림이 통째로 멎는
  // 쪽이, 어쩌다 한 번 남의 알림이 가는 것보다 훨씬 나쁘다. 확신이 설 때만
  // 막는다는 규칙이 조용히 뒤집히지 않도록 못 박아 둔다.
  const { sandbox, store, posts } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: "2026-08-24" };

  await sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "" });

  assert.equal(sent(posts, /입실 체크 완료/).length, 1, "이름을 못 읽었다고 알림을 멈추면 안 된다");
  assert.equal(sent(posts, /다른 계정/).length, 0);
});

test("주인 본인의 출석은 그대로 알린다", async () => {
  const { sandbox, store, posts } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: "2026-08-24" };

  await sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: " 홍길동 " });

  assert.equal(sent(posts, /입실 체크 완료/).length, 1, "앞뒤 공백 때문에 남으로 취급하면 안 된다");
  assert.equal(sent(posts, /다른 계정/).length, 0);
});
