// 강조 박스(content.js)의 회귀 테스트.
//
// 이 테스트가 있는 이유:
// 입실 강조 박스가 자기 라벨을 강조 대상으로 잡아, 갱신될 때마다 조금씩
// 커지면서 화면 위로 기어올라가 상단 메뉴를 덮어버리는 버그가 있었다.
// 라벨 문구("🚨 입실 체크! ...")에 "입실"이 들어 있는데 텍스트 검색이
// 우리 요소를 제외하지 않아서, 박스 → 라벨 → 박스로 되먹임이 생긴 것이다.
// 눈으로만 확인하기 쉽고 조용히 재발하기도 쉬워서 자동으로 잡아둔다.
//
// 실행: npm test   (사전에 `npx playwright install chromium` 필요)
// 이 저장소 밖에서 받은 크로미움을 쓰려면 CHROMIUM_PATH 로 지정한다.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const FIXTURE = "file://" + path.join(__dirname, "fixtures", "ssafy-home.html");

// 박스가 대상 요소보다 상하좌우로 더 그려지는 여백 (content.js 의 pad)
const PAD = 6;
// 좌표 비교 허용 오차 (렌더링 반올림)
const TOLERANCE = 2;

let browser;

before(async () => {
  browser = await chromium.launch({
    // 기본값은 playwright 가 관리하는 크로미움. 환경에 따라 직접 지정할 수 있다.
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
});

after(async () => {
  if (browser) await browser.close();
});

// 개발자 모드로 시각과 입실 상태를 강제한 페이지를 띄우고 content.js 를 올린다.
async function openPage(dev) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(FIXTURE);

  // content.js 가 실제로 쓰는 chrome API 만 흉내 낸다.
  await page.addScriptTag({
    content: `window.chrome = {
      storage: {
        local: { get: (keys, cb) => cb({
          ssafyDev: { enabled: true, forceWeekday: true, ...${JSON.stringify(dev)} },
          dayOff: { offDays: [], workDays: [] }
        }) },
        onChanged: { addListener: () => {} }
      },
      runtime: { sendMessage: () => {} }
    };`,
  });

  await page.addStyleTag({ content: fs.readFileSync(path.join(ROOT, "content.css"), "utf8") });
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, "holidays.js"), "utf8") });
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, "content.js"), "utf8") });

  return { page, pageErrors };
}

// 강조 박스들과 기대 대상 요소의 위치/크기를 읽는다.
function snapshot(page, targetSelector) {
  return page.evaluate((sel) => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const target = document.querySelector(sel);
    return {
      boxes: [...document.querySelectorAll(".ssafy-alert-box")].map(rect),
      target: target ? rect(target) : null,
    };
  }, targetSelector);
}

// 시나리오. expect 는 박스가 감싸야 할 요소.
// 퇴실 칸은 안쪽의 <a id="checkOut"> 이 대상이다. content.js 가 클릭 가능한
// 요소를 우선해서 찾기 때문이고, 이게 의도된 동작이다.
const SCENARIOS = [
  { name: "입실 전 08:30 - 입실 셀을 강조한다", dev: { checkedIn: "false", time: 8 * 60 + 30 }, expect: ".state" },
  { name: "입실 전 09:30 - 마감이 지나도 입실 셀을 강조한다", dev: { checkedIn: "false", time: 9 * 60 + 30 }, expect: ".state" },
  { name: "입실 완료 13:00 - 퇴실 버튼을 강조한다", dev: { checkedIn: "true", time: 13 * 60 }, expect: "#checkOut" },
  { name: "입실 완료 18:30 - 퇴실 버튼을 강조한다", dev: { checkedIn: "true", time: 18 * 60 + 30 }, expect: "#checkOut" },
];

for (const scn of SCENARIOS) {
  test(scn.name, async () => {
    const { page, pageErrors } = await openPage(scn.dev);
    try {
      // 박스가 그려질 때까지 기다린다.
      await page.waitForSelector(".ssafy-alert-box", { timeout: 5000 });
      await page.waitForTimeout(700); // 첫 배치가 자리를 잡을 시간
      const first = await snapshot(page, scn.expect);

      // 되먹임은 갱신을 반복하며 커진다. 고치기 전에는 이 사이에 눈에 띄게
      // 커지면서 위로 올라갔다. (예: 110x74 top:237 -> 249x34 top:19)
      await page.waitForTimeout(6000);
      const last = await snapshot(page, scn.expect);

      assert.equal(pageErrors.length, 0, "페이지 에러: " + pageErrors.join(" | "));
      assert.ok(last.target, `기대 대상(${scn.expect})이 페이지에 없다`);
      assert.equal(last.boxes.length, 1, "강조 박스는 한 개여야 한다");

      // 회귀 방지의 핵심: 시간이 지나도 박스가 그대로여야 한다.
      assert.deepEqual(
        last.boxes,
        first.boxes,
        "강조 박스가 시간이 지나며 움직이거나 커졌다 (자기 라벨을 대상으로 잡는 되먹임 의심)"
      );

      // 박스가 엉뚱한 곳이 아니라 기대한 요소를 감싸는지 확인한다.
      const box = last.boxes[0];
      const t = last.target;
      const near = (a, b) => Math.abs(a - b) <= TOLERANCE;
      assert.ok(
        near(box.top, t.top - PAD) && near(box.left, t.left - PAD) &&
          near(box.w, t.w + PAD * 2) && near(box.h, t.h + PAD * 2),
        `박스가 대상(${scn.expect})을 감싸지 않는다. 박스=${JSON.stringify(box)} 대상=${JSON.stringify(t)}`
      );
    } finally {
      await page.close();
    }
  });
}

// 위 회귀 테스트가 의미를 가지려면 두 가지 전제가 필요하다.
//  - 라벨 문구에 "입실"이 들어 있어야 한다 (그래야 탐색에 걸릴 수 있다)
//  - fixture 페이지 자체에는 "입실" 문구가 없어야 한다 (있으면 탐색이 그쪽을
//    먼저 잡아버려서, 되먹임이 생겨도 테스트가 눈치채지 못한다)
// 문구나 fixture 를 고치다 이 전제가 깨지면 회귀 테스트가 조용히 무력해지므로
// 여기서 따로 확인한다. 이 테스트 자체는 수정 여부를 판별하지 않는다.
test("회귀 테스트의 전제 - 라벨에는 '입실'이 있고 페이지에는 없다", async () => {
  const { page } = await openPage({ checkedIn: "false", time: 8 * 60 + 30 });
  try {
    await page.waitForSelector(".ssafy-alert-box", { timeout: 5000 });
    await page.waitForTimeout(700);

    const result = await page.evaluate(() => {
      const label = document.querySelector(".ssafy-alert-box-label");
      const box = document.querySelector(".ssafy-alert-box");
      // 페이지 전체에서 "입실"이 들어간 텍스트를 가진 요소를 훑어, 우리 요소
      // 바깥에도 후보가 있는지 확인한다.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const outside = [];
      while (walker.nextNode()) {
        const el = walker.currentNode.parentElement;
        if (!el || !/입실/.test(walker.currentNode.nodeValue || "")) continue;
        if (!el.closest(".ssafy-alert-box, #ssafy-alert-banner")) outside.push(el.textContent.trim().slice(0, 20));
      }
      return { labelText: label ? label.textContent : "", boxContainsLabel: !!(box && label && box.contains(label)), outside };
    });

    // 전제 확인: 라벨에 "입실"이 실제로 들어 있고, 라벨은 박스 안에 있다.
    assert.match(result.labelText, /입실/, "이 테스트는 라벨에 '입실'이 들어 있을 때만 의미가 있다");
    assert.ok(result.boxContainsLabel, "라벨은 박스 안에 있어야 한다");
    // 우리 요소를 걷어내고 나면, 페이지 자체에는 "입실" 텍스트가 없어야 한다.
    // (이 fixture 는 이미 입실한 상태라 "정상 출석"만 있다)
    assert.deepEqual(result.outside, [], "우리 오버레이 밖에서 '입실' 텍스트가 발견됐다");
  } finally {
    await page.close();
  }
});
