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
          async get(keys) {
            const list = typeof keys === "string" ? [keys] : keys;
            const out = {};
            for (const k of list) if (k in store) out[k] = store[k];
            return out;
          },
          async set(obj) {
            Object.assign(store, obj);
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

// ── 떠난 자리 정리 ────────────────────────────────────────────────────
// 자리를 옮겨도 확장과 확장의 저장소는 그 PC에 그대로 남는다(크롬 기록을
// 지워도 마찬가지다). 그래서 옮겨 다닌 PC마다 내 웹훅 토큰이 하나씩 살아남고
// 그 자리에 다음 사람이 앉는다. 주인이 하루 동안 한 번도 안 보이는데 다른
// 계정이 쓰고 있으면, 주인은 떠난 것으로 보고 그 PC의 개인 설정을 지운다.
//
// 아래 테스트들은 await 대신 run() 을 쓴다 (이유는 run() 의 주석 참고).

const YESTERDAY = "2026-08-24"; // 오늘일 리 없는 날짜
const 남의출석 = { checkinMin: 8 * 60 + 16, checkoutMin: null, account: "김철수" };

test("주인이 오늘 안 보인 PC에 다른 계정이 앉으면 개인 설정을 지운다", async () => {
  const { sandbox, store, notes } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: YESTERDAY, lastSeenAt: YESTERDAY };
  store.attendance = { date: YESTERDAY, checkinMin: 500 };
  store.dayOff = { offDays: ["2026-09-01"], workDays: [] };

  await run(() => sandbox.handleAttendanceObserved(남의출석));

  assert.equal(store.mattermost, undefined, "웹훅 토큰이 남의 PC에 살아 있으면 안 된다");
  assert.equal(store.eduAccount, undefined, "주인을 지워야 다음 사람이 자연스럽게 주인이 된다");
  assert.equal(store.attendance, undefined, "주인의 출석 상태도 남기지 않는다");
  assert.equal(
    store.dayOff,
    undefined,
    "주인의 연차가 남으면 다음 사람은 그날 알림을 통째로 못 받고 이유도 알 수 없다"
  );
  assert.equal(notes.length, 1, "그 자리에 앉은 사람에게 정리했다고 알려야 한다");
});

test("지우기 전에 주인에게 먼저 알린다", async () => {
  // 순서가 뒤집히면 웹훅이 먼저 사라져서 알릴 길이 없어진다. 주인은 알림이
  // 멎은 줄도 모른 채 그날 퇴실을 놓친다 - 이 확장이 막으려던 바로 그 상황이다.
  const { sandbox, store, posts } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: YESTERDAY, lastSeenAt: YESTERDAY };

  await run(() => sandbox.handleAttendanceObserved(남의출석));

  const bye = sent(posts, /지웠어요/);
  assert.equal(bye.length, 1, "주인은 자기 설정이 지워졌다는 것을 반드시 알아야 한다");
  assert.match(textOf(bye[0]), /알림은 이제 없습니다/, "그 PC에서 알림이 안 온다는 사실을 적어야 한다");
  assert.equal(sent(posts, /입실 체크 완료/).length, 0, "남의 입실을 완료로 알리면 안 된다");
});

test("주인을 오늘 봤으면 잠깐 남이 앉은 것이라 지우지 않는다", async () => {
  const { sandbox, store, posts } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: YESTERDAY };

  // 주인이 먼저 자기 자리에서 출석을 본다 (lastSeenAt 이 오늘로 갱신된다).
  await run(() =>
    sandbox.handleAttendanceObserved({ checkinMin: 8 * 60 + 16, checkoutMin: null, account: "홍길동" })
  );
  assert.equal(store.eduAccount.lastSeenAt, sandbox.todayStr(), "주인을 본 날을 남겨야 한다");

  // 그 뒤 같은 날 남이 앉았다.
  await run(() => sandbox.handleAttendanceObserved({ ...남의출석, checkinMin: 9 * 60 }));

  assert.notEqual(store.mattermost, undefined, "주인이 오늘 쓴 PC의 설정을 지우면 안 된다");
  assert.equal(store.eduAccount.name, "홍길동", "주인도 그대로여야 한다");
  assert.equal(sent(posts, /지웠어요/).length, 0);
  assert.equal(sent(posts, /다른 계정/).length, 1, "대신 예전처럼 사정만 알린다");
});

test("확장을 업데이트한 것만으로는 지우지 않는다", async () => {
  // lastSeenAt 은 이 기능과 함께 생겼다. 그 전에 저장된 주인에게는 이 값이
  // 없는데, 이것을 "오래 안 보였다"로 읽으면 업데이트 당일 남이 잠깐
  // 앉기만 해도 멀쩡한 설정이 날아간다.
  const { sandbox, store, posts } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: YESTERDAY }; // lastSeenAt 없음

  await run(() => sandbox.handleAttendanceObserved(남의출석));

  assert.notEqual(store.mattermost, undefined, "업데이트 당일은 예전과 똑같이 동작해야 한다");
  assert.equal(sent(posts, /지웠어요/).length, 0);
  assert.equal(sent(posts, /다른 계정/).length, 1);
});

test("보고가 연달아 와도 한 번만 정리한다", async () => {
  // SSAFY 탭을 여러 개 열어두면 같은 보고가 거의 동시에 여러 번 온다.
  const { sandbox, store, posts, notes } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: YESTERDAY, lastSeenAt: YESTERDAY };

  await run(
    () => sandbox.handleAttendanceObserved(남의출석),
    () => sandbox.handleAttendanceObserved({ ...남의출석, checkoutMin: 18 * 60 }),
    () => sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "김철수" })
  );

  assert.equal(sent(posts, /지웠어요/).length, 1, "같은 작별 인사를 여러 번 보내면 안 된다");
  assert.equal(notes.length, 1);
  assert.equal(store.mattermost, undefined);
});

test("정리한 사실을 그날 화면에 띄울 수 있게 남긴다", async () => {
  // 지우고 나면 확장은 갓 설치한 것과 똑같아진다. 지금 앉은 사람에게 아무
  // 설명이 없으면 그냥 고장 난 것으로 보인다.
  const { sandbox, store } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: YESTERDAY, lastSeenAt: YESTERDAY };

  await run(() => sandbox.handleAttendanceObserved(남의출석));

  assert.equal(store.eduHandover.date, sandbox.todayStr());
  assert.equal(store.eduHandover.from, "홍길동", "누구 설정을 정리했는지 화면에 적어야 한다");
});

test("정리한 뒤 다음 사람이 새 주인이 된다", async () => {
  const { sandbox, store } = loadBackground();
  store.eduAccount = { name: "홍길동", boundAt: YESTERDAY, lastSeenAt: YESTERDAY };

  await run(() => sandbox.handleAttendanceObserved(남의출석));
  await run(() => sandbox.handleAttendanceObserved(남의출석));

  assert.equal(store.eduAccount.name, "김철수");
  assert.equal(store.eduAccount.lastSeenAt, sandbox.todayStr());
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
  assert.equal(notes.length, 1, "그 자리에 앉은 사람에게도 알려야 한다");
  const warn = sent(posts, /본 적이 없어요/);
  assert.equal(warn.length, 1, "주인은 왜 아무 알림도 안 오는지 알아야 한다");
  assert.match(textOf(warn[0]), /김철수/, "지금 누가 로그인해 있는지 적어야 한다");
  assert.match(textOf(warn[0]), /다시 지정하기/, "이름이 잘못 잡혔을 때의 탈출구를 알려줘야 한다");
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

  assert.equal(sent(posts, /본 적이 없어요/).length, 1, "같은 사정을 반복해서 보내면 그게 새로운 소음이 된다");
  assert.equal(notes.length, 1);
});

test("주인이 이미 잡혀 있으면 연결된 계정 이름은 끼어들지 않는다", async () => {
  // 이름이 잘못 잡혔을 때 팝업에서 주인을 다시 지정하면 ownerNames 도 같이
  // 풀리지만, 옛 버전에서 저장된 주인이 남아 있을 수도 있다. 그때는 이미
  // 잡힌 주인이 우선이고, 판정은 예전 규칙 그대로여야 한다.
  const { sandbox, store, posts } = loadBackground();
  store.eduAccount = { name: "김철수", boundAt: sandbox.todayStr(), lastSeenAt: sandbox.todayStr() };
  withOwnerNames(store, ["홍길동"]);

  await run(() => sandbox.handleAttendanceRecorded({ kind: "checkin", minutes: 8 * 60 + 16, account: "김철수" }));

  assert.equal(sent(posts, /입실 체크 완료/).length, 1, "주인으로 잡힌 사람의 출석은 알린다");
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

  const warn = sent(posts, /본 적이 없어요/);
  assert.equal(warn.length, 1);
  assert.match(textOf(warn[0]), /박경태님/, "'박경태[서울_3반]님' 은 읽기 나쁘다");
  assert.doesNotMatch(textOf(warn[0]), /서울_3반/);
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
