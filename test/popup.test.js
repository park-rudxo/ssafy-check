// 팝업·설치 화면이 여는 탭에 대한 회귀 테스트.
//
// 이 테스트가 있는 이유:
// 연결이 끝나면 출석 화면을 열어 그 자리에서 주인을 확정한다. 이 일을 팝업에서
// 하게 했더니 탭도 안 열리고 결과 문구도 안 보였다. 팝업은 포커스를 잃는 순간
// 닫히고, 닫히면 그 뒤의 코드가 통째로 사라진다. 연결 자체는 멀쩡해서 눈치채기
// 어렵다.
//
// 그래서 탭은 백그라운드가 연다(설정이 저장되는 것을 보고 연다 - 그 동작은
// account.test.js 에서 확인한다). 여기서는 팝업 쪽이 그 일을 도로 가져가지
// 않는지만 본다. 양쪽이 같이 열면 탭이 두 개 열리고, 팝업 쪽은 다시 닫힘에
// 휘둘린다.
//
// 실행: npm test  (브라우저 없이 도는 순수 노드 테스트)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

for (const file of ["popup.js", "welcome.js"]) {
  test(`${file} - 연결 뒤 출석 화면을 직접 열지 않는다`, () => {
    // 연결 처리 안에서 탭을 여는 곳이 있으면 안 된다. 사람이 버튼을 눌러 여는
    // 것(아래 테스트)은 click 핸들러 안에 있으므로 여기 걸리지 않는다.
    const src = read(file);
    const connect = src.slice(src.indexOf("provisionPersonalWebhook"));
    const end = connect.indexOf("function testMattermost");
    const block = end === -1 ? connect : connect.slice(0, end);

    assert.doesNotMatch(
      block,
      /chrome\.tabs\.create/,
      "탭은 백그라운드가 연다. 여기서 열면 팝업이 닫히는 순간 통째로 사라진다"
    );
  });
}

test("사람이 직접 누르는 [출석 페이지 열기] 는 앞으로 띄운다", () => {
  // 이 버튼은 반대다. 뒤에서 열면 눌러도 아무 일도 안 일어난 것처럼 보인다.
  const src = read("popup.js");
  const m = /open-ssafy"\)\.addEventListener\("click", \(\) => \{\s*chrome\.tabs\.create\(\{([^}]*)\}\)/.exec(src);

  assert.ok(m, "[출석 페이지 열기] 버튼의 탭 열기를 찾지 못했다");
  assert.doesNotMatch(m[1], /active:\s*false/, "사람이 누른 버튼은 그 탭을 보여줘야 한다");
});
