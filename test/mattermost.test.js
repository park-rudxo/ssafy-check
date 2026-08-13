// Mattermost "받을 곳" 검증(mattermost.js)의 회귀 테스트.
//
// 이 테스트가 있는 이유:
// 받을 곳을 비운 채로 연동을 켜면 웹훅을 만들 때 고른 채널로 메시지가 가서,
// 한 사람의 미체크 경고가 그 방 전체에 반복해서 울린다. 설정 화면 세 곳
// (팝업·설치 화면·백그라운드)이 모두 이 판정을 쓰므로, 규칙이 조용히
// 느슨해지면 사고가 그대로 재발한다.
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
    assert.match(res.error, /전원|모든 사람|입력/);
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

test("사용자명 규칙: 첫 글자는 문자여야 한다", () => {
  for (const v of ["9team", "1a2", ".hong", "-hong", "_hong"]) {
    assert.equal(MM.isValidTarget(v), false, `${v} 는 문자로 시작하지 않는다`);
  }
  assert.equal(MM.isValidTarget("h9team"), true);
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

test("isValidTarget은 normalizeTarget의 판정과 같다", () => {
  assert.equal(MM.isValidTarget("@hong"), true);
  assert.equal(MM.isValidTarget(""), false);
  assert.equal(MM.isValidTarget("박경도"), false);
});
