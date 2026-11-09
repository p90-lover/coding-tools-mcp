"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { isCloudflareCheckPage, loadPastCloudflareCheck, matchBrowserUserAgent, SETUP_CHECK_MESSAGE } = require("../electron/chatgpt-cloudflare-check.cjs");

// A hidden setup window: loadURL answers with `status`, and `isCheck` is what the page says when
// asked whether it is Cloudflare's check.
function setupWindow({ status = 200, isCheck = false, afterLoad } = {}) {
  const contents = new EventEmitter();
  const scripts = [];
  contents.executeJavaScript = async script => { scripts.push(script); await afterLoad?.(contents); return isCheck; };
  const window = {
    webContents: contents,
    loadURL: async url => {
      contents.emit("did-navigate", {}, url, status);
      contents.emit("did-finish-load");
    },
  };
  return { window, contents, scripts };
}
const reload = (contents, status) => {
  contents.emit("did-navigate", {}, "https://chatgpt.com/plugins?view=personal", status);
  contents.emit("did-finish-load");
};
const listeners = contents => ["did-navigate", "did-finish-load", "destroyed"].reduce((sum, name) => sum + contents.listenerCount(name), 0);

test("the Browser tab and the setup windows share one check-page test", () => {
  // browser-host.cjs needs Electron to load; its source shows it takes the shared test.
  const host = fs.readFileSync(path.join(__dirname, "../electron/browser-host.cjs"), "utf8");
  assert.match(host, /const \{ isCloudflareCheckPage \} = require\("\.\/chatgpt-cloudflare-check\.cjs"\);/);
  assert.doesNotMatch(host, /function isCloudflareCheckPage\(/);
  assert.equal(isCloudflareCheckPage(undefined, { _cf_chl_opt: {} }), true);
  assert.equal(isCloudflareCheckPage({ scripts: [{ src: "https://chatgpt.com/cdn-cgi/challenge-platform/scripts/jsd/main.js" }] }, {}), false);
});

test("a page with no check loads as before and asks the page nothing", async () => {
  const { window, contents, scripts } = setupWindow({ status: 200 });
  let checks = 0;
  assert.equal(await loadPastCloudflareCheck(window, "https://chatgpt.com/plugins?view=personal", { onCheck: () => checks++ }), false);
  assert.deepEqual(scripts, []);
  assert.equal(checks, 0);
  assert.equal(listeners(contents), 0);
});

test("a 403 that is not Cloudflare's check is ChatGPT's own answer, not a wait", async () => {
  const { window, scripts } = setupWindow({ status: 403, isCheck: false });
  assert.equal(await loadPastCloudflareCheck(window, "https://chatgpt.com/plugins"), false);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /^\(function isCloudflareCheckPage\(doc, win\)/);
});

test("the load waits through Cloudflare's check and its own reload, failed tries included", async () => {
  const { window, contents } = setupWindow({ status: 403, isCheck: true });
  let checks = 0;
  const loading = loadPastCloudflareCheck(window, "https://chatgpt.com/plugins?view=personal", { waitMs: 5_000, onCheck: () => checks++ });
  let settled = false;
  void loading.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 1, "the caller hears of the check, to give its deadline the time");
  assert.equal(settled, false);
  reload(contents, 403); // A failed try reloads the check page.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  contents.emit("did-navigate", {}, "https://chatgpt.com/plugins?view=personal", 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "the page counts once it has loaded, not as it starts");
  contents.emit("did-finish-load");
  assert.equal(await loading, true);
  assert.equal(listeners(contents), 0);
});

test("a check that passes while the page is asked about it is not missed", async () => {
  const { window, contents } = setupWindow({ status: 403, isCheck: true, afterLoad: contents => reload(contents, 200) });
  assert.equal(await loadPastCloudflareCheck(window, "https://chatgpt.com/plugins", { waitMs: 5_000 }), true);
  assert.equal(listeners(contents), 0);
});

test("a check that does not pass in time, or a window that closes, says what to do", async () => {
  const stuck = setupWindow({ status: 403, isCheck: true });
  await assert.rejects(loadPastCloudflareCheck(stuck.window, "https://chatgpt.com/plugins", { waitMs: 20 }), new Error(SETUP_CHECK_MESSAGE));
  assert.equal(listeners(stuck.contents), 0);
  const closed = setupWindow({ status: 403, isCheck: true });
  const loading = loadPastCloudflareCheck(closed.window, "https://chatgpt.com/plugins", { waitMs: 5_000 });
  await new Promise(resolve => setImmediate(resolve));
  closed.contents.emit("destroyed");
  await assert.rejects(loading, new Error(SETUP_CHECK_MESSAGE));
  assert.match(SETUP_CHECK_MESSAGE, /Browser tab/);
});

test("a setup window speaks with the Browser tab's user agent, which Cloudflare's clearance is tied to", () => {
  const electron = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) CodingTools/0.8.102 Chrome/156.0.8078.80 Electron/45.2.2 Safari/537.36";
  let agent = electron;
  const window = { webContents: { getUserAgent: () => agent, setUserAgent: value => { agent = value; } } };
  matchBrowserUserAgent(window);
  assert.equal(agent, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.80 Safari/537.36");
  matchBrowserUserAgent({ webContents: new EventEmitter() }); // Windows without these methods are left alone.
});
