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
  const tabs = []; // 열린 탭
  const store = {};

  const listeners = { addListener() {} };
  // 저장소 변화를 듣는 쪽은 직접 불러봐야 해서 따로 붙잡아 둔다.
  const storageListeners = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    },
    chrome: {
      windows: {
        async create(opts) { tabs.push(opts); return { id: 1 }; },
      },
      alarms: { create() {}, clear() {}, onAlarm: listeners },
      tabs: {
        create(opts) {
          tabs.push(opts);
        },
      },
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
        onChanged: {
          addListener(fn) {
            storageListeners.push(fn);
          },
        },
        local: {
          async get(keys, callback) {
            const list = typeof keys === "string" ? [keys] : keys;
            const out = {};
            for (const k of list) if (k in store) out[k] = store[k];
            if (callback) callback(out);
            return out;
          },
          async set(obj, callback) {
            Object.assign(store, obj);
            if (callback) callback();
          },
          // 진짜 chrome.storage 는 키 하나든 배열이든 받는다. 한쪽만
          // 흉내 내면 여러 키를 한 번에 지우는 코드가 테스트에서만 조용히
          // 아무것도 안 지운다.
          async remove(keys) {
            for (const k of typeof keys === "string" ? [keys] : keys) delete store[k];
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

  // 저장소가 바뀌었다고 알린다 (크롬이 하는 일을 대신한다).
  const notifyChanged = (changes) => {
    for (const fn of storageListeners) fn(changes, "local");
  };

  return { sandbox, store, posts, notes, tabs, notifyChanged };
}

// 나간 메시지 본문을 한 줄로 합친다 (attachments 안에 들어 있다).
function textOf(post) {
  return (post.body.attachments || []).map((a) => a.text || "").join("\n");
}

function sent(posts, re) {
  return posts.filter((p) => re.test(textOf(p)));
}

// 백그라운드 핸들러를 부르고, 그 안에서 일어난 일이 전부 끝날 때까지 기다린다.
// 여러 개를 넘기면 동시에 도착한 보고가 된다.
//
// 돌려받은 프로미스를 그냥 await 하면 안 되는 경우가 있다. vm 컨텍스트 안에서
// 만들어진 프로미스를 호스트에서 곧바로 await 하면, 그 경로가 호스트 쪽
// 비동기(여기서는 fetch 흉내)를 한 번도 거치지 않을 때 node:test 아래에서
// 영영 돌아오지 않는다. 설정을 지운 뒤라 알림을 한 건도 안 보내는 경로가
// 정확히 그렇다. 그래서 프로미스 대신 호스트 타이머로 한 틱 쉬어, 그 사이에
// 마이크로태스크가 다 흐르게 한다. 제품 코드와 무관한 이 하네스만의 문제다.
function run(...calls) {
  let failed = null;
  for (const call of calls) {
    try {
      const p = call();
      if (p && typeof p.then === "function") p.then(null, (e) => (failed = e));
    } catch (e) {
      failed = e;
    }
  }
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    if (failed) throw failed;
  });
}

test("계정 불일치 보고가 반복되어도 방해하는 팝업은 열지 않는다", async () => {
  const { sandbox, store, tabs } = loadBackground();
  const owner = { mine: "홍길동", theirs: "김철수" };
  await run(() => sandbox.refuseOtherAccount(owner), () => sandbox.refuseOtherAccount(owner));
  await run(() => sandbox.refuseOtherAccount(owner));
  assert.equal(tabs.length, 0);
  assert.equal(store.accountPaused.theirs, "김철수");
});

test("처음 본 계정을 이 브라우저의 주인으로 기억한다", async () => {
  const { sandbox, store, posts } = loadBackground();

  await sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "홍길동" });

  assert.equal(store.eduAccount.name, "홍길동", "처음 본 이름이 주인으로 저장되어야 한다");
  assert.equal(sent(posts, /입실 체크 완료/).length, 1, "주인의 입실은 평소대로 알려야 한다");
});

test("주인이 아닌 계정의 입실은 알리지도, 오늘치로 기록하지도 않는다", async () => {
  const { sandbox, store, posts, notes, tabs } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: "2026-08-24" };

  // B가 A의 크롬에서 자기 아이디로 로그인해 입실을 누른 상황.
  await sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "김철수" });
  assert.equal(tabs.filter((tab) => tab.type === "popup").length, 0, "계정 안내는 작은 카드로 표시하고 팝업은 자동으로 열지 않는다");

  assert.equal(sent(posts, /입실 체크 완료/).length, 0, "남의 입실을 '완료'로 알리면 안 된다");
  assert.equal(
    store.attendance == null || store.attendance.checkinMin == null,
    true,
    "남의 입실을 내 오늘치로 저장하면 '아직 입실 안 했어요' 경고까지 멎는다"
  );

  assert.equal(posts.length, 0, "다른 사람에게 계정 안내 메시지를 보내지 않는다");
  assert.equal(notes.length, 0);
  assert.equal(store.accountPaused.theirs, "김철수");
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

  assert.equal(sent(posts, /다른 계정/).length, 0, "같은 사정을 반복해서 보내면 그게 새로운 소음이 된다");
  assert.equal(notes.length, 0);
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

// 자리 이동 시 삭제 대신 중지하고, 본인이 돌아오면 원래 설정을 재사용한다.
const YESTERDAY = "2026-08-24";
const 남의출석 = { checkinMin: 496, checkoutMin: null, account: "김철수" };

test("자리 이동을 감지해도 개인 설정과 휴무일을 삭제하지 않는다", async () => {
  const { sandbox, store, posts, notes } = loadBackground();
  store.eduAccount = { name: "홍길동", lastSeenAt: YESTERDAY };
  store.dayOff = { offDays: ["2026-11-02"], workDays: [] };
  const previous = JSON.stringify(store.mattermost);
  await sandbox.handleAttendanceObserved(남의출석);
  assert.equal(JSON.stringify(store.mattermost), previous);
  assert.equal(store.eduAccount.name, "홍길동");
  assert.equal(store.dayOff.offDays[0], "2026-11-02");
  assert.equal(store.accountPaused.theirs, "김철수");
  assert.equal(posts.length, 0);
  assert.equal(notes.length, 0);
});

test("원래 사용자가 돌아오면 중지를 해제하고 출석을 정상 기록한다", async () => {
  const { sandbox, store } = loadBackground();
  store.eduAccount = { name: "홍길동", lastSeenAt: YESTERDAY };
  await sandbox.handleAttendanceObserved(남의출석);
  await sandbox.handleAttendanceObserved({ ...남의출석, account: "홍길동" });
  assert.equal(store.accountPaused, null);
  assert.equal(store.attendance.pageCheckinMin, 496);
});

test("계정 전환은 설정과 출석을 계정별로 복구하고 웹훅 토큰은 활성 계정만 보관한다", async () => {
  const { sandbox, store } = loadBackground();
  store.mattermost.notifyMissing = false;
  store.dayOff = { offDays: ["2026-11-02"], workDays: [] };
  store.attendance = { date: sandbox.todayStr(), checkinMin: 496 };
  store.mmSent = { date: sandbox.todayStr(), keys: ["click-checkin"] };
  const hong = { ...store.mattermost };
  await sandbox.applyAccountConnection({ userId: "kim-id", channel: "@kim", ownerNames: ["김철수"], webhookUrl: "https://meeting.ssafy.com/hooks/kim" }, "김철수");
  assert.equal(store.attendance, null);
  assert.equal(store.mattermost.notifyMissing, true);
  assert.equal(store.dayOff.offDays.length, 0);
  assert.doesNotMatch(JSON.stringify(store.accountPreferences), /hooks\//);
  await sandbox.applyAccountConnection(hong, "홍길동");
  assert.equal(store.mattermost.notifyMissing, false);
  assert.equal(store.attendance.checkinMin, 496);
  assert.equal(store.mmSent.keys[0], "click-checkin");
  assert.equal(store.dayOff.offDays[0], "2026-11-02");
});

test("인증된 Mattermost 세션이 일치하면 다른 자리에서 기존 연결을 자동 복구한다", async () => {
  const { sandbox, store } = loadBackground();
  store.eduAccount = { name: "홍길동" };
  let calls = 0;
  sandbox.chrome.permissions = { contains: async () => true };
  sandbox.SsafyMattermost.restorePersonalWebhook = async name => {
    calls++;
    assert.equal(name, "김철수");
    return { userId: "kim-id", channel: "@kim", ownerNames: [name], webhookUrl: "https://meeting.ssafy.com/hooks/kim" };
  };
  await sandbox.handleAttendanceObserved(남의출석);
  assert.equal(calls, 1);
  assert.equal(store.eduAccount.name, "김철수");
  assert.equal(store.mattermost.channel, "@kim");
  assert.equal(store.attendance.pageCheckinMin, 496);
  assert.equal(store.accountPaused, null);
});

test("복구할 계정이 없으면 반복 요청을 제한하고 이전 사용자 설정을 보존한다", async () => {
  const { sandbox, store } = loadBackground();
  store.eduAccount = { name: "홍길동" };
  sandbox.chrome.permissions = { contains: async () => true };
  let calls = 0;
  sandbox.SsafyMattermost.restorePersonalWebhook = async () => { calls++; return null; };
  await Promise.all([sandbox.handleAttendanceObserved(남의출석), sandbox.handleAttendanceObserved(남의출석)]);
  assert.equal(calls, 1);
  assert.equal(store.mattermost.channel, "@hong");
  assert.equal(store.eduAccount.name, "홍길동");
  assert.equal(store.accountPaused.theirs, "김철수");
});

test("사용자가 꺼둔 연동은 자동 복구가 다시 켜지 않는다", async () => {
  const { sandbox, store } = loadBackground();
  store.mattermost.enabled = false;
  sandbox.chrome.permissions = { contains: async () => true };
  sandbox.SsafyMattermost.restorePersonalWebhook = async () => { throw new Error("호출되면 안 됨"); };
  await sandbox.handleAttendanceObserved(남의출석);
  assert.equal(store.mattermost.enabled, false);
});

// ── 주인을 "먼저 연 사람"이 아니라 연결된 계정으로 잡는다 ──────────────
// 연결만 해두고 아직 edu 를 열지 않은 사이에 다른 사람이 그 자리에 앉아 자기
// 아이디로 열면, 그 사람이 내 브라우저의 주인이 되어버렸다. 그때부터 내 출석이
// "남의 출석"으로 무시되고, 나에게는 내 출석을 두고 "다른 계정의 출석이라
// 알리지 않았어요"가 온다. 웹훅은 본인이 로그인해 만든 것이므로 그 계정이 곧
// 주인이다.

// 연결된 계정의 한글 이름을 아는 상태로 시작한다.
function withOwnerNames(store, names) {
  store.mattermost = { ...store.mattermost, ownerNames: names };
}

test("연결된 계정이 아니면 주인으로 잡지 않는다", async () => {
  const { sandbox, store, posts, notes } = loadBackground();
  withOwnerNames(store, ["홍길동"]);

  // 홍길동이 연결만 해두고 edu 를 열기 전에 김철수가 앉았다.
  await run(() => sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "김철수" }));

  assert.equal(store.eduAccount, undefined, "여기서 주인으로 기억하면 정작 본인이 계속 막힌다");
  assert.equal(sent(posts, /입실 체크 완료/).length, 0, "남의 입실을 완료로 알리면 안 된다");
  assert.equal(
    store.attendance == null || store.attendance.checkinMin == null,
    true,
    "남의 입실을 내 오늘치로 저장하면 미체크 경고까지 멎는다"
  );
  assert.equal(notes.length, 0);
  assert.equal(posts.length, 0);
  assert.equal(store.accountPaused.mine, "홍길동");
});

test("연결된 계정 본인이면 그대로 주인이 된다", async () => {
  const { sandbox, store, posts } = loadBackground();
  withOwnerNames(store, ["홍길동"]);

  await run(() => sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "홍길동" }));

  assert.equal(store.eduAccount.name, "홍길동");
  assert.equal(sent(posts, /입실 체크 완료/).length, 1, "본인 출석은 평소대로 알려야 한다");
});

test("이름 후보가 여럿이면 그중 하나만 맞아도 본인이다", async () => {
  // 성과 이름이 어느 칸에 들어가는지는 계정마다 다를 수 있어서 순서를 짐작하지
  // 않고 후보를 모두 남긴다.
  const { sandbox, store } = loadBackground();
  withOwnerNames(store, ["길동홍", "홍길동"]);

  await run(() => sandbox.handleAttendanceObserved({ checkinMin: 8 * 60 + 16, checkoutMin: null, account: "홍길동" }));

  assert.equal(store.eduAccount.name, "홍길동");
});

test("사이 공백이 달라도 본인으로 본다", async () => {
  // 두 사이트가 같은 이름을 다르게 띄울 수 있다. 공백 하나 때문에 본인이
  // 막히면, 알림이 통째로 안 오는데 이유를 알 길이 없다.
  const { sandbox, store } = loadBackground();
  withOwnerNames(store, ["홍길동"]);

  await run(() => sandbox.handleAttendanceObserved({ checkinMin: 8 * 60 + 16, checkoutMin: null, account: "홍 길동" }));

  assert.equal(store.eduAccount.name, "홍 길동", "주인으로 잡혀야 한다");
});

test("연결된 계정 이름을 모르면 예전처럼 처음 본 계정을 주인으로 잡는다", async () => {
  // 프로필에 한글 이름이 없는 계정(영문 아이디뿐)도 있다. 그때 이름으로
  // 가리려 들면 아무도 주인이 못 되어 확장이 통째로 멎는다.
  const { sandbox, store, posts } = loadBackground();
  withOwnerNames(store, []);

  await run(() => sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "김철수" }));

  assert.equal(store.eduAccount.name, "김철수");
  assert.equal(sent(posts, /입실 체크 완료/).length, 1);
});

test("경고는 하루 한 번만 간다", async () => {
  const { sandbox, store, posts, notes } = loadBackground();
  withOwnerNames(store, ["홍길동"]);

  for (let i = 0; i < 4; i++) {
    await run(() =>
      sandbox.handleAttendanceObserved({ checkinMin: 8 * 60 + 16, checkoutMin: null, account: "김철수" })
    );
  }

  assert.equal(sent(posts, /본 적이 없어요/).length, 0, "같은 사정을 반복해서 보내면 그게 새로운 소음이 된다");
  assert.equal(notes.length, 0);
});

test("과거 주인 기록이 잘못되어 있어도 연결된 계정과 다르면 알림을 막는다", async () => {
  // 이름이 잘못 잡혔을 때 팝업에서 주인을 다시 지정하면 ownerNames 도 같이
  // 풀리지만, 옛 버전에서 저장된 주인이 남아 있을 수도 있다. 그때는 이미
  // 잡힌 주인이 우선이고, 판정은 예전 규칙 그대로여야 한다.
  const { sandbox, store, posts } = loadBackground();
  store.eduAccount = { name: "김철수", boundAt: sandbox.todayStr(), lastSeenAt: sandbox.todayStr() };
  withOwnerNames(store, ["홍길동"]);

  await run(() => sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "김철수" }));

  assert.equal(sent(posts, /입실 체크 완료/).length, 0, "오래된 주인 기록보다 연결된 계정 검증이 우선이다");
  assert.equal(store.accountPaused.theirs, "김철수");
  assert.equal(sent(posts, /본 적이 없어요/).length, 0);
});

test("반 정보가 붙은 실제 이름 형식으로도 본인을 알아본다", async () => {
  // 실제 SSAFY Mattermost 프로필은 "박경태[서울_3반]" 형식이다. edu 화면에는
  // 이름만 뜨므로, 이 둘이 안 맞으면 본인이 자기 브라우저에서 막힌다.
  const { sandbox, store, posts } = loadBackground();
  withOwnerNames(store, ["박경태[서울_3반]"]);

  await run(() => sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "박경태" }));

  assert.equal(store.eduAccount.name, "박경태", "본인이 주인으로 잡혀야 한다");
  assert.equal(sent(posts, /입실 체크 완료/).length, 1);
  assert.equal(sent(posts, /본 적이 없어요/).length, 0);
});

test("막았을 때 문구에는 반 정보를 빼고 이름만 쓴다", async () => {
  const { sandbox, store, posts } = loadBackground();
  withOwnerNames(store, ["박경태[서울_3반]"]);

  await run(() => sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "김철수" }));

  assert.equal(posts.length, 0);
  assert.equal(store.accountPaused.mine, "박경태");
  assert.doesNotMatch(store.accountPaused.mine, /서울_3반/);
});

// ── 연결이 끝나면 출석 화면을 연다 ────────────────────────────────────
// 주인을 연결한 계정으로 잡으려면, 연결한 사람이 아직 그 자리에 있을 때 edu 를
// 한 번 열어둬야 한다.
//
// 이 일을 팝업에서 하게 했더니 탭도 안 열리고 결과 문구도 안 보이는 일이
// 있었다. 팝업은 포커스를 잃는 순간 닫히고, 닫히면 그 뒤의 코드가 통째로
// 사라진다. 그래서 "설정이 저장됐다"는 사실을 보고 서비스 워커가 연다.

const DONE_MM = {
  enabled: true,
  channel: "@hong",
  webhookUrl: "https://meeting.ssafy.com/hooks/abcdefghijklmnop",
};

test("연결이 끝나면 출석 화면을 뒤에서 연다", async () => {
  const { tabs, notifyChanged } = loadBackground();

  notifyChanged({ mattermost: { oldValue: undefined, newValue: DONE_MM } });

  assert.equal(tabs.length, 1, "주인을 확정할 기회가 이때뿐이다");
  assert.match(tabs[0].url, /edu\.ssafy\.com/);
  assert.equal(tabs[0].active, false, "앞으로 띄우면 설정을 마치던 사람을 끌어낸다");
});

test("알림 설정을 켜고 끄는 것으로는 탭이 열리지 않는다", async () => {
  // mattermost 키 하나에 알림 종류까지 같이 들어 있다. 바뀔 때마다 열면
  // 체크박스를 누를 때마다 탭이 하나씩 생긴다.
  const { tabs, notifyChanged } = loadBackground();

  notifyChanged({
    mattermost: { oldValue: DONE_MM, newValue: { ...DONE_MM, notifyCheckin: false } },
  });

  assert.deepEqual(tabs, []);
});

test("연결이 끝나지 않은 저장은 탭을 열지 않는다", async () => {
  const { tabs, notifyChanged } = loadBackground();

  // 웹훅만 있고 받을 곳이 없는 중간 상태.
  notifyChanged({ mattermost: { oldValue: undefined, newValue: { ...DONE_MM, channel: "" } } });
  // 연결을 끈 경우.
  notifyChanged({ mattermost: { oldValue: DONE_MM, newValue: { ...DONE_MM, enabled: false } } });

  assert.deepEqual(tabs, []);
});

test("다른 값이 바뀔 때는 열지 않는다", async () => {
  const { tabs, notifyChanged } = loadBackground();

  notifyChanged({ eduAccount: { oldValue: undefined, newValue: { name: "홍길동" } } });

  assert.deepEqual(tabs, []);
});

// ── 쉬는 날에는 아무것도 내보내지 않는다 ──────────────────────────────
// 헛경고를 막으려고 출석 상태 보고를 화면 표시 조건보다 앞으로 옮겼다. 그래서
// 쉬는 날에도 보고가 올라온다. 상태를 최신으로 두는 것은 맞지만, 사람에게
// 무언가를 보내는 것은 별개다 - 싸피는 주말에 나오지 않으므로 주말에 가는
// 알림은 그 자체로 헛것이다.

// 오늘을 개인 휴무일로 등록해 쉬는 날로 만든다 (주말·공휴일과 같은 취급).
function makeDayOff(store, sandbox) {
  store.dayOff = { offDays: [sandbox.todayStr()], workDays: [] };
}

test("쉬는 날에는 완료 알림을 보내지 않는다", async () => {
  const { sandbox, store, posts } = loadBackground();
  makeDayOff(store, sandbox);

  await run(() => sandbox.handleAttendanceObserved({ checkinMin: 8 * 60 + 16, checkoutMin: null, account: "홍길동" }));

  assert.equal(sent(posts, /체크 완료/).length, 0, "주말에 페이지를 잠깐 열어본 것만으로 알림이 가면 안 된다");
  // 상태는 그대로 기록해야 한다. 이걸 막으면 헛경고 수정이 도로 깨진다.
  assert.equal(store.attendance.pageCheckinMin, 8 * 60 + 16, "보내지 않는 것과 모르는 것은 다르다");
});

test("쉬는 날에는 다른 계정 안내도 보내지 않는다", async () => {
  const { sandbox, store, posts, notes } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: sandbox.todayStr(), lastSeenAt: sandbox.todayStr() };
  makeDayOff(store, sandbox);

  await run(() => sandbox.handleAttendanceObserved({ checkinMin: 8 * 60 + 16, checkoutMin: null, account: "김철수" }));

  assert.equal(sent(posts, /다른 계정/).length, 0);
  assert.equal(notes.length, 0, "그 자리에 앉은 사람에게도 주말에 알릴 것이 없다");
  assert.equal(store.eduAccount.name, "홍길동", "남의 출석을 내 것으로 기록하지도 않는다");
});

test("쉬는 날에는 떠난 자리 정리도 미룬다", async () => {
  // 알림만 막고 지우기만 하면, 주인은 설정이 사라진 것도 모른 채 월요일을
  // 맞는다. 정리는 반드시 먼저 알리고 지워야 하므로 하루 미루는 편이 낫다.
  const { sandbox, store, posts } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: YESTERDAY, lastSeenAt: YESTERDAY };
  makeDayOff(store, sandbox);

  await run(() => sandbox.handleAttendanceObserved(남의출석));

  assert.notEqual(store.mattermost, undefined, "쉬는 날에 조용히 지우면 안 된다");
  assert.notEqual(store.eduAccount, undefined);
  assert.equal(sent(posts, /지웠어요/).length, 0);
});

test("쉬는 날이 아니면 지금까지처럼 보낸다", async () => {
  // 위 검사가 너무 넓게 걸려 평일까지 조용해지면 확장이 통째로 멎는다.
  const { sandbox, store, posts } = loadBackground();
  store.dayOff = { offDays: [], workDays: [sandbox.todayStr()] }; // 오늘은 반드시 일하는 날

  await run(() => sandbox.handleAttendanceObserved({ checkinMin: 8 * 60 + 16, checkoutMin: null, account: "홍길동" }));

  assert.equal(sent(posts, /입실 체크 완료/).length, 1);
});


test("숨은 이전 계정 탭은 현재 계정의 알림을 중지하지 않는다", async () => {
  const { sandbox, store } = loadBackground();
  store.eduAccount = { name: "홍길동" };
  const result = await sandbox.handleAttendanceObserved({ ...남의출석, visible: false });
  assert.equal(result.ignored, "background-account");
  assert.equal(store.accountPaused, undefined);
  assert.equal(store.eduAccount.name, "홍길동");
});

test("권한이 없는 새 프로필은 자동 요청 없이 기존 연결을 보존한다", async () => {
  const { sandbox, store } = loadBackground();
  store.eduAccount = { name: "홍길동" };
  sandbox.chrome.permissions = { contains: async () => false };
  let calls = 0;
  sandbox.SsafyMattermost.restorePersonalWebhook = async () => { calls++; };
  await sandbox.handleAttendanceObserved(남의출석);
  assert.equal(calls, 0);
  assert.equal(store.mattermost.channel, "@hong");
});

test("복구 요청 중 수동으로 저장한 연결은 자동 복구가 덮어쓰지 않는다", async () => {
  const { sandbox, store } = loadBackground();
  store.eduAccount = { name: "홍길동" };
  sandbox.chrome.permissions = { contains: async () => true };
  sandbox.SsafyMattermost.restorePersonalWebhook = async () => {
    store.mattermost = { ...store.mattermost, channel: "@manual" };
    return { channel: "@kim", ownerNames: ["김철수"], webhookUrl: "https://meeting.ssafy.com/hooks/kim" };
  };
  await sandbox.handleAttendanceObserved(남의출석);
  assert.equal(store.mattermost.channel, "@manual");
});

test("출석 보고가 동시에 와도 완료 메시지는 한 번만 발송된다", async () => {
  const { sandbox, posts } = loadBackground();
  await Promise.all(Array.from({length: 5}, () => sandbox.handleAttendanceRecorded({kind:"checkin", minutes:496, account:"홍길동"})));
  assert.equal(sent(posts, /입실 체크 완료/).length, 1);
});

test("계정 확인이 안 되는 동안에는 기록과 완료 알림을 중지한다", async () => {
  const { sandbox, store, posts } = loadBackground();
  store.accountPaused = {mine:"홍길동", theirs:"김철수"};
  await sandbox.handleAttendanceRecorded({kind:"checkin", minutes:496, account:""});
  assert.equal(store.attendance, undefined);
  assert.equal(sent(posts, /입실 체크 완료/).length, 0);
});


test("새 연결에서 다른 계정을 잠시 보았다가 본인을 확인하면 중지가 해제된다", async () => {
  const { sandbox, store, posts } = loadBackground();
  store.mattermost.ownerNames = ["홍길동"];
  await sandbox.handleAttendanceObserved(남의출석);
  assert.ok(store.accountPaused);
  await sandbox.handleAttendanceObserved({ ...남의출석, account: "홍길동" });
  assert.equal(store.accountPaused, null);
  assert.equal(store.eduAccount.name, "홍길동");
});

test("자동 복구 시 출석 탭을 추가로 열지 않는다", async () => {
  const { tabs, notifyChanged, store } = loadBackground();
  notifyChanged({mattermost: {oldValue: null, newValue: store.mattermost}, eduAccount: {newValue: {name:"홍길동"}}});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(tabs.length, 0);
});

test("처음 쓰는 PC도 기존 웹훅만으로 자동 연결된다", async () => {
  const { sandbox, store } = loadBackground();
  delete store.mattermost;
  sandbox.chrome.permissions = {contains: async () => true};
  sandbox.SsafyMattermost.restorePersonalWebhook = async () => ({userId:"u1", channel:"@hong", ownerNames:["홍길동"], webhookUrl:"https://meeting.ssafy.com/hooks/existing"});
  await sandbox.handleAttendanceObserved({...남의출석, account:"홍길동"});
  assert.equal(store.mattermost.channel, "@hong");
  assert.equal(store.eduAccount.name, "홍길동");
  assert.equal(store.accountPaused, null);
});
