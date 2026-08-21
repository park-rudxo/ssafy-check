// 출석 상태 보고(content.js → background.js)의 회귀 테스트.
//
// 이 테스트가 있는 이유:
// 크롬 창을 열어놓고 입실까지 마쳤는데도 "아직 입실 체크를 안 했어요!" 경고가
// 온 적이 있다. 화면은 입실한 걸 알고 강조를 껐는데, 그 사실이 백그라운드까지
// 가지 못한 것이다. 새는 곳이 두 군데였다.
//  1) 보고가 실패해도 "보냈다"로 표시해버려서, 값이 바뀌기 전까지 다시 보내지
//     않았다. 아침에는 서비스 워커가 잠들어 있어 첫 보고가 실패하기 쉽다.
//  2) 보고가 화면 표시 조건 뒤에 있어서, 강조를 안 그리는 상황(설정 미완료·
//     위젯 없는 화면·18:30 이후)에서는 보고까지 함께 막혔다.
// 둘 다 증상이 "메시지가 잘못 온다"라서 눈으로는 원인을 못 찾는다.
//
// 실행: npm test   (사전에 `npx playwright install chromium` 필요)

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const FIXTURE = "file://" + path.join(__dirname, "fixtures", "ssafy-home.html");

let browser;

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  if (browser) await browser.close();
});

// 개발자 모드는 끈 채로 연다. 가상 상태는 보고하지 않기 때문이다.
// failFirst 만큼의 보고는 서비스 워커가 잠든 것처럼 실패시킨다.
async function openPage({ mattermost, failFirst = 0 }) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(FIXTURE);
  await page.addScriptTag({
    content: `window.__sent = [];
    window.__fail = ${failFirst};
    window.chrome = {
      storage: {
        local: { get: (keys, cb) => cb({
          dayOff: { offDays: [], workDays: [] },
          mattermost: ${JSON.stringify(mattermost)}
        }) },
        onChanged: { addListener: () => {} }
      },
      runtime: {
        // 실제 sendMessage 처럼 프라미스를 돌려준다. 잠든 서비스 워커는
        // "Receiving end does not exist" 로 거절된다.
        sendMessage: (payload) => {
          if (window.__fail > 0) {
            window.__fail -= 1;
            return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
          }
          window.__sent.push(payload);
          return Promise.resolve({ ok: true });
        }
      }
    };`,
  });
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, "debug.js"), "utf8") });
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, "holidays.js"), "utf8") });
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, "content.js"), "utf8") });
  return { page, pageErrors };
}

// 설정이 끝난 상태(강조를 그리는 상태)
const MM_DONE = {
  enabled: true,
  channel: "@hong",
  webhookUrl: "https://meeting.ssafy.com/hooks/abcdefghijklmnopqrstuvwxyz",
};
// 설정이 안 끝난 상태 - 화면에는 강조 대신 안내 배너만 뜬다.
const MM_UNSET = { enabled: false, channel: "", webhookUrl: "" };

async function waitForReport(page, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const sent = await page.evaluate(() => window.__sent.filter((m) => m.type === "attendanceObserved"));
    if (sent.length) return sent;
    if (Date.now() - started > timeoutMs) return [];
    await page.waitForTimeout(500);
  }
}

test("위젯에서 읽은 입실 상태를 백그라운드에 보고한다", async () => {
  const { page, pageErrors } = await openPage({ mattermost: MM_DONE });
  const sent = await waitForReport(page, 5000);
  assert.equal(pageErrors.length, 0, "페이지 에러: " + pageErrors.join(" | "));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].checkinMin, 8 * 60 + 16, "fixture 의 08:16 을 읽어야 한다");
  assert.equal(sent[0].checkedIn, true, "'정상 출석' 도 함께 알려야 한다");
  await page.close();
});

test("강조를 그리지 않는 상황에서도 보고는 간다", async () => {
  // 설정 미완료라 화면에는 안내 배너만 뜬다. 예전에는 여기서 return 되어
  // 보고가 통째로 막혔고, 백그라운드는 입실을 영영 모른 채 경고를 보냈다.
  const { page, pageErrors } = await openPage({ mattermost: MM_UNSET });
  const sent = await waitForReport(page, 5000);
  assert.equal(pageErrors.length, 0, "페이지 에러: " + pageErrors.join(" | "));
  assert.equal(sent.length, 1, "강조가 꺼져 있어도 보고는 해야 한다");
  assert.equal(sent[0].checkedIn, true);
  await page.close();
});

test("보고가 실패하면 나중에 다시 보낸다", async () => {
  // 아침에 서비스 워커가 잠들어 있어 첫 보고 세 번이 다 실패한 상황.
  // 예전에는 "보냈다"로 표시해버려 이 페이지가 닫힐 때까지 다시 시도하지
  // 않았다. 재시도는 15초 주기의 갱신 루프에 실린다.
  const { page, pageErrors } = await openPage({ mattermost: MM_DONE, failFirst: 3 });
  const sent = await waitForReport(page, 30000);
  assert.equal(pageErrors.length, 0, "페이지 에러: " + pageErrors.join(" | "));
  assert.equal(sent.length, 1, "세 번 실패한 뒤에도 다시 보고해야 한다");
  assert.equal(sent[0].checkedIn, true);
  await page.close();
});
