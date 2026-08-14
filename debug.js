// SSAFY 출석 체크 알리미 - 진단 로그 (공용 모듈)
//
// ── 왜 필요한가 ───────────────────────────────────────────────────────
// 이 확장에서 무언가 잘못되면 증상이 "아무 일도 안 일어남"이다. 아이디에 오타가
// 나도, 웹훅 권한이 없어도, 서비스 워커가 잠들어 보고가 유실돼도 사용자에게는
// 똑같이 "메시지가 안 왔다"로만 보인다. 그래서 무엇이 어디서 멈췄는지 나중에
// 확인할 수 있도록 마지막 몇백 줄을 남겨둔다.
//
// 콘솔에도 찍지만 그것만으로는 부족하다. 서비스 워커 콘솔은 chrome://extensions
// 에서 따로 열어야 하고, 워커가 잠들면 그때까지의 콘솔 내용이 사라진다.
// chrome.storage 에 남겨야 잠들었다 깨어난 뒤에도, 다른 화면(팝업)에서도 읽을 수
// 있다. 팝업의 "🐞 진단 로그"에서 통째로 복사해 그대로 보낼 수 있다.
//
// 사용하는 곳 (holidays.js·mattermost.js와 같은 방식으로 전역에 붙인다)
//   - service worker : importScripts("debug.js")
//   - content script : manifest 의 content_scripts.js 목록에서 content.js 앞
//   - popup / welcome: <script src="debug.js"> 를 각 스크립트보다 앞에 둔다

(function (root) {
  "use strict";

  const KEY = "ssafyLog";
  // 하루치 출퇴근이면 수십 줄이라 300줄이면 며칠 분이 남는다. 무한정 쌓으면
  // storage.local 용량(기본 10MB)을 갉아먹으므로 오래된 줄부터 버린다.
  const MAX_LINES = 300;

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmt(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.message || String(v);
    try {
      return JSON.stringify(v);
    } catch (e) {
      // 순환 참조 등으로 직렬화가 안 되는 값. 로그 한 줄 때문에 호출한 쪽이
      // 죽으면 안 되므로 모양만 남기고 넘어간다.
      return String(v);
    }
  }

  // 쓰기를 직렬화한다. 읽고-고치고-쓰는 사이에 다른 호출이 끼어들면 그 줄이
  // 통째로 사라진다. 로그가 유실되면 진단하려던 문제를 못 잡으므로 줄을 세운다.
  let queue = Promise.resolve();

  function append(line) {
    queue = queue
      .then(
        () =>
          new Promise((resolve) => {
            try {
              chrome.storage.local.get(KEY, (data) => {
                const list = (data && Array.isArray(data[KEY]) ? data[KEY] : []).concat(line);
                if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES);
                try {
                  chrome.storage.local.set({ [KEY]: list }, () => resolve());
                } catch (e) {
                  resolve();
                }
              });
            } catch (e) {
              /* 확장 컨텍스트가 무효화된 경우 */
              resolve();
            }
          })
      )
      .catch(() => {});
    return queue;
  }

  // log("mm", "전송 실패", { status: 404 })
  //   → "08/14 09:01:12 [mm] 전송 실패 {"status":404}"
  function log(tag, ...parts) {
    const line = `${stamp()} [${tag}] ${parts.map(fmt).join(" ")}`;
    try {
      console.log("[SSAFY]", line);
    } catch (e) {
      /* 콘솔이 없는 환경 */
    }
    return append(line);
  }

  function read() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY, (data) => {
          resolve(data && Array.isArray(data[KEY]) ? data[KEY] : []);
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  function clear() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [KEY]: [] }, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  root.SsafyDebug = { log, read, clear, KEY, MAX_LINES };
})(typeof globalThis !== "undefined" ? globalThis : self);
