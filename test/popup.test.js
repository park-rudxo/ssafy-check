// 팝업·설치 화면이 여는 탭에 대한 회귀 테스트.
//
// 이 테스트가 있는 이유:
// 연결이 끝나면 출석 화면을 열어 그 자리에서 주인을 확정하는데, 이 탭을 앞으로
// 띄우면 새 탭이 포커스를 가져가고 그 순간 팝업이 닫힌다. 그러면 바로 뒤에
// 그리는 연결 결과("전에 만들어 둔 웹훅을 그대로 씁니다")도, "테스트 메시지를
// 보내라"는 다음 단계 안내도 사람이 한 번도 못 본다. 실제로 그렇게 나가서,
// 연결은 잘 됐는데 화면에 아무 말도 없는 상태를 만들었다.
//
// 눈으로만 확인하기 쉽고(연결 자체는 멀쩡히 된다) 조용히 재발하기도 쉬워서
// 여기서 붙잡는다. 팝업은 DOM 과 chrome API 가 모두 필요해 통째로 돌리기
// 어려우므로, 소스에서 이 한 가지 약속만 확인한다.
//
// 실행: npm test  (브라우저 없이 도는 순수 노드 테스트)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

for (const file of ["popup.js", "welcome.js"]) {
  test(`${file} - 연결 뒤 여는 출석 화면은 뒤에서 연다`, () => {
    const src = read(file);
    assert.match(
      src,
      /chrome\.tabs\.create\(\{\s*url: SSAFY_HOME,\s*active: false\s*\}\)/,
      "active: false 가 빠지면 새 탭이 포커스를 가져가 팝업이 닫히고, 연결 결과와 다음 단계 안내가 통째로 안 보인다"
    );
  });
}

test("연결 결과 문구는 탭을 열기 전에 그린다", () => {
  // 순서가 뒤집히면 active: false 여도 위험하다. 탭을 먼저 여는 코드는
  // "닫힌 팝업에 그리기"와 한 끗 차이라, 순서 자체를 고정해 둔다.
  const src = read("popup.js");
  const status = src.indexOf("전에 만들어 둔 웹훅을 그대로 씁니다");
  const tab = src.indexOf("chrome.tabs.create({ url: SSAFY_HOME, active: false })");

  assert.notEqual(status, -1, "연결 결과 문구를 찾지 못했다");
  assert.notEqual(tab, -1, "출석 화면을 여는 곳을 찾지 못했다");
  assert.ok(status < tab, "결과를 먼저 그리고 나서 탭을 열어야 한다");
});

test("사람이 직접 누르는 [출석 페이지 열기] 는 앞으로 띄운다", () => {
  // 위 규칙을 일괄 적용해버리면 이 버튼까지 뒤에서 열려, 눌러도 아무 일도
  // 안 일어난 것처럼 보인다. 두 경우는 서로 다르다.
  const src = read("popup.js");
  const m = /open-ssafy"\)\.addEventListener\("click", \(\) => \{\s*chrome\.tabs\.create\(\{([^}]*)\}\)/.exec(src);

  assert.ok(m, "[출석 페이지 열기] 버튼의 탭 열기를 찾지 못했다");
  assert.doesNotMatch(m[1], /active:\s*false/, "사람이 누른 버튼은 그 탭을 보여줘야 한다");
});
