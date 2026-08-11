// SSAFY 출석 체크 알리미 - 공휴일 판정 (공용 모듈)
//
// content.js / background.js / popup.js 세 곳에서 같은 판정을 써야 하므로
// 파일 하나로 빼고 전역(globalThis.SsafyHolidays)에 붙인다.
//   - content script : manifest의 js 배열에서 content.js보다 앞에 둔다
//   - service worker : importScripts("holidays.js")
//   - popup          : <script src="holidays.js"> 를 popup.js보다 앞에 둔다
//
// ── 왜 표로 관리하는가 ────────────────────────────────────────────────
// 설날·추석·부처님오신날은 음력이라 계산으로 구하려면 음양력 변환표가 통째로
// 필요하다. 확장 크기에 비해 과하므로 해당 연도의 양력 날짜만 표에 적는다.
// 대신 대체공휴일은 규정이 명확하므로 표에 적지 않고 아래 규칙으로 계산한다.
// (표에 적으면 사람이 옮겨 적다가 틀릴 여지가 생긴다)
//
// ── 표에 없는 연도는? ─────────────────────────────────────────────────
// COVERED_YEARS 밖의 날짜는 "모름"으로 두고 기존처럼 평일이면 동작시킨다.
// 조용히 넘어가서 조퇴 처리되는 것보다 헛알림 한 번이 낫다는 이 확장의
// 기존 원칙(README "동작 원리" 참고)을 공휴일 판정에도 그대로 적용한 것이다.

(function (root) {
  "use strict";

  // 음력 기반 공휴일의 양력 날짜. 설날/추석은 "당일"만 적고 전날·다음날은 계산한다.
  const LUNAR_BY_YEAR = {
    2026: { seollal: "2026-02-17", buddha: "2026-05-24", chuseok: "2026-09-25" },
    2027: { seollal: "2027-02-07", buddha: "2027-05-13", chuseok: "2027-09-15" },
  };

  // 양력 고정 공휴일.
  //   substitute : 대체공휴일 대상 여부
  //   from       : 이 연도부터 공휴일 (제헌절은 2026년에 다시 공휴일이 됐다)
  const FIXED = [
    { md: "01-01", name: "신정", substitute: false },
    { md: "03-01", name: "삼일절", substitute: true },
    { md: "05-05", name: "어린이날", substitute: true },
    { md: "06-06", name: "현충일", substitute: false }, // 국가추모일이라 대체 대상이 아니다
    { md: "07-17", name: "제헌절", substitute: true, from: 2026 },
    { md: "08-15", name: "광복절", substitute: true },
    { md: "10-03", name: "개천절", substitute: true },
    { md: "10-09", name: "한글날", substitute: true },
    { md: "12-25", name: "성탄절", substitute: true },
  ];

  const COVERED_YEARS = Object.keys(LUNAR_BY_YEAR).map(Number);
  const MIN_YEAR = Math.min(...COVERED_YEARS);
  const MAX_YEAR = Math.max(...COVERED_YEARS);

  // ── 날짜 유틸 (모두 로컬 시각 기준) ─────────────────────────────────
  function toKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function fromKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(key, n) {
    const d = fromKey(key);
    d.setDate(d.getDate() + n);
    return toKey(d);
  }
  function isWeekend(key) {
    const day = fromKey(key).getDay();
    return day === 0 || day === 6;
  }

  // ── 연도별 공휴일 표 만들기 ─────────────────────────────────────────
  // 관공서의 공휴일에 관한 규정 제3조(대체공휴일)를 그대로 옮긴 것:
  //   · 설날·추석 연휴는 "일요일"과 겹칠 때만 (토요일과 겹치는 건 해당 없음)
  //   · 그 외 대체 대상 공휴일은 "토요일 또는 일요일"과 겹칠 때
  //   · 겹친 날 수만큼, 연휴 다음의 공휴일이 아닌 첫날(들)로 지정
  const cache = {};

  function buildYear(year) {
    const lunar = LUNAR_BY_YEAR[year];
    if (!lunar) return null;

    const holidays = {}; // key -> 이름
    const add = (key, name) => {
      if (!holidays[key]) holidays[key] = name;
    };

    // 대체공휴일 계산 순서를 날짜순으로 맞추기 위해 후보를 모아둔다.
    //   days      : 이 공휴일이 차지하는 날짜들
    //   sundayOnly: 일요일과 겹칠 때만 대체 (명절)
    const candidates = [];

    for (const f of FIXED) {
      if (f.from && year < f.from) continue;
      const key = `${year}-${f.md}`;
      add(key, f.name);
      if (f.substitute) candidates.push({ days: [key], name: f.name, sundayOnly: false });
    }

    add(lunar.buddha, "부처님오신날");
    candidates.push({ days: [lunar.buddha], name: "부처님오신날", sundayOnly: false });

    for (const [center, name] of [
      [lunar.seollal, "설날"],
      [lunar.chuseok, "추석"],
    ]) {
      const days = [addDays(center, -1), center, addDays(center, 1)];
      add(days[0], `${name} 연휴`);
      add(days[1], name);
      add(days[2], `${name} 연휴`);
      candidates.push({ days, name, sundayOnly: true });
    }

    candidates.sort((a, b) => (a.days[0] < b.days[0] ? -1 : 1));

    for (const c of candidates) {
      const overlap = c.days.filter((key) => {
        const day = fromKey(key).getDay();
        return c.sundayOnly ? day === 0 : day === 0 || day === 6;
      }).length;
      if (overlap === 0) continue;

      // 연휴 마지막 날 다음부터, 주말도 공휴일도 아닌 날을 겹친 수만큼 찾는다.
      let cursor = c.days[c.days.length - 1];
      for (let i = 0; i < overlap; i++) {
        do {
          cursor = addDays(cursor, 1);
        } while (isWeekend(cursor) || holidays[cursor]);
        holidays[cursor] = `${c.name} 대체공휴일`;
      }
    }

    return holidays;
  }

  function tableFor(year) {
    if (!(year in cache)) cache[year] = buildYear(year);
    return cache[year];
  }

  // ── 공개 API ────────────────────────────────────────────────────────

  // 공휴일이면 이름, 아니면 null. 표에 없는 연도도 null(= 모름)을 준다.
  function holidayName(date) {
    const key = typeof date === "string" ? date : toKey(date);
    const table = tableFor(Number(key.slice(0, 4)));
    return (table && table[key]) || null;
  }

  function isCovered(date) {
    const key = typeof date === "string" ? date : toKey(date);
    return Boolean(tableFor(Number(key.slice(0, 4))));
  }

  // 오늘이 "출석 체크가 필요한 날"인지 판단한다.
  // settings.offDays  : 사용자가 등록한 개인 휴무일(연차·공가 등) 날짜 배열
  // settings.workDays : 공휴일 판정을 무시하고 평일로 취급할 날짜 배열
  //                     (표가 틀렸거나 공휴일에도 출석해야 할 때의 탈출구)
  //
  // 반환: { off, reason, label }
  //   off    : true면 강조·알림을 모두 끈다
  //   reason : "weekend" | "holiday" | "personal" | null
  //   label  : 사용자에게 보여줄 문구 (off가 false면 null)
  function dayInfo(date, settings) {
    const key = typeof date === "string" ? date : toKey(date);
    const s = settings || {};
    const offDays = s.offDays || [];
    const workDays = s.workDays || [];

    if (offDays.includes(key)) return { off: true, reason: "personal", label: "개인 휴무일" };
    if (workDays.includes(key)) return { off: false, reason: null, label: null };

    const name = holidayName(key);
    // 주말과 공휴일이 겹치면(예: 토요일 광복절) 어차피 쉬는 날이지만,
    // 이름을 알려주는 편이 사용자에게 더 친절하다.
    if (isWeekend(key)) return { off: true, reason: "weekend", label: name ? `주말·${name}` : "주말" };
    if (name) return { off: true, reason: "holiday", label: name };

    return { off: false, reason: null, label: null };
  }

  root.SsafyHolidays = {
    toKey,
    holidayName,
    isCovered,
    dayInfo,
    coveredYears: { min: MIN_YEAR, max: MAX_YEAR },
    // 테스트용
    _tableFor: tableFor,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
