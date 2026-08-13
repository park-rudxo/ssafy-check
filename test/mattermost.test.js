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
    ["@ho ng", "@hong"], // 붙여넣다 섞인 공백 제거
  ];
  for (const [input, expected] of cases) {
    const res = MM.normalizeTarget(input);
    assert.equal(res.ok, true, `${input} 는 통과해야 한다`);
    assert.equal(res.value, expected);
  }
});

test("사용자명이 될 수 없는 값은 거절한다", () => {
  // 한글 표시 이름, 너무 짧거나 긴 값, 숫자로 시작하는 값 등
  for (const v of ["박경도", "@박경도", "ab", "9team", "team!", "a".repeat(23)]) {
    assert.equal(MM.normalizeTarget(v).ok, false, `${v} 는 거절되어야 한다`);
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
