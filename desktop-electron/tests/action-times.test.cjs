const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  createActionTimes, watchPageTimes, timeIpcHandler, pageShape, partitionGroup, MAX_ENTRIES, MAX_SAMPLES,
} = require("../electron/action-times.cjs");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");

function fakePage(storagePath = "G:/AppData/Coding Tools/Partitions/coding-tools-chatgpt-e80j2nxxvag5") {
  const contents = new EventEmitter();
  contents.session = { storagePath };
  return contents;
}

test("a tab's first mount is kept apart from its later switches", () => {
  const times = createActionTimes();
  times.tabRendered({ tab: "agent-orchestrator", ms: 640, first: true });
  times.tabRendered({ tab: "agent-orchestrator", ms: 20, first: false });
  times.tabRendered({ tab: "agent-orchestrator", ms: 40, first: false });
  const [chat] = times.snapshot().tabs;
  assert.equal(chat.firstMs, 640);
  assert.deepEqual(chat.render, { count: 2, lastMs: 40, medianMs: 40, p95Ms: 40, maxMs: 40 });
  assert.equal(times.currentTab(), "agent-orchestrator");
});

test("tab reports are checked: a name the app does not use or an impossible time is refused", () => {
  const times = createActionTimes();
  assert.throws(() => times.tabRendered({ tab: "../etc", ms: 5 }), /Invalid tab timing/);
  assert.throws(() => times.tabRendered({ tab: "browser", ms: -1 }), /Invalid tab timing/);
  assert.throws(() => times.tabRendered({ tab: "browser", ms: Number.NaN }), /Invalid tab timing/);
  assert.equal(times.snapshot().tabs.length, 0);
});

test("a request is timed against the tab shown when it was made, even if it answers after a switch", async () => {
  const times = createActionTimes();
  let clock = 0;
  const appWindow = {};
  times.tabRendered({ tab: "agent-orchestrator", ms: 10 });
  let finish;
  const handler = timeIpcHandler(times, "launcher:ao-sessions", () => new Promise((resolve) => { finish = resolve; }), {
    isAppWindow: (sender) => sender === appWindow, clock: () => clock,
  });
  const answer = handler({ sender: appWindow }, "arg");
  times.tabRendered({ tab: "browser", ms: 10 });
  clock = 1_250;
  finish("done");
  assert.equal(await answer, "done");
  const byTab = Object.fromEntries(times.snapshot().tabs.map((item) => [item.tab, item]));
  assert.equal(byTab["agent-orchestrator"].response.count, 1);
  assert.equal(byTab["agent-orchestrator"].response.maxMs, 1_250);
  assert.deepEqual(byTab["agent-orchestrator"].slowest, { channel: "launcher:ao-sessions", ms: 1_250 });
  assert.equal(byTab.browser.response.count, 0);
});

test("a failed request is still timed; other pages' requests and the timing calls themselves are not", async () => {
  const times = createActionTimes();
  const appWindow = {};
  const options = { isAppWindow: (sender) => sender === appWindow, clock: () => 0 };
  times.tabRendered({ tab: "settings", ms: 5 });
  const failing = timeIpcHandler(times, "launcher:update-check", async () => { throw new Error("offline"); }, options);
  await assert.rejects(failing({ sender: appWindow }), /offline/);
  await timeIpcHandler(times, "launcher:status", async () => 1, options)({ sender: {} });
  const own = async () => 2;
  assert.equal(timeIpcHandler(times, "launcher:action-times", own, options), own);
  const [settings] = times.snapshot().tabs;
  assert.equal(settings.response.count, 1);
  assert.equal(settings.slowest.channel, "launcher:update-check");
});

test("a page's response is timed to the server's answer and its render to the finished load", () => {
  const times = createActionTimes();
  let clock = 0;
  const page = fakePage();
  watchPageTimes(page, { times, clock: () => clock, describe: () => ({ group: "Browser", account: "gr***@gmail.com" }) });
  page.emit("did-start-navigation", { url: "https://chatgpt.com/c/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b?model=x", isMainFrame: true, isSameDocument: false });
  clock = 420;
  page.emit("did-navigate", {}, "https://chatgpt.com/c/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b?model=x", 200);
  clock = 1_900;
  page.emit("did-finish-load");
  const [entry] = times.snapshot().pages;
  assert.equal(entry.page, "chatgpt.com/c/:id");
  assert.equal(entry.group, "Browser");
  assert.equal(entry.account, "gr***@gmail.com");
  assert.equal(entry.lastStatus, 200);
  assert.equal(entry.response.lastMs, 420);
  assert.equal(entry.render.lastMs, 1_900);
});

test("Cloudflare's check shows as a 403; in-page and subframe navigations and app files are not timed", () => {
  const times = createActionTimes();
  let clock = 0;
  const page = fakePage();
  watchPageTimes(page, { times, clock: () => clock });
  page.emit("did-start-navigation", { url: "https://chatgpt.com/", isMainFrame: true, isSameDocument: false });
  clock = 300;
  page.emit("did-navigate", {}, "https://chatgpt.com/", 403);
  clock = 900;
  page.emit("did-finish-load");
  page.emit("did-start-navigation", { url: "https://chatgpt.com/#settings", isMainFrame: true, isSameDocument: true });
  page.emit("did-start-navigation", { url: "https://challenges.cloudflare.com/turnstile", isMainFrame: false, isSameDocument: false });
  page.emit("did-start-navigation", { url: "file:///H:/Apps/Coding%20Tools/resources/app.asar/dist/index.html", isMainFrame: true, isSameDocument: false });
  page.emit("did-finish-load");
  const pages = times.snapshot().pages;
  assert.equal(pages.length, 1);
  assert.equal(pages[0].lastStatus, 403);
  assert.equal(pages[0].group, "Browser", "named from the partition when nothing describes it");
  assert.equal(pages[0].render.count, 1);
});

test("a failed load counts as a failure; an aborted or replaced one does not", () => {
  const times = createActionTimes();
  let clock = 0;
  const page = fakePage("G:/AppData/Coding Tools/Partitions/gpt-browser-pct5jnj6jxgg");
  watchPageTimes(page, { times, clock: () => clock });
  // Aborted before any answer, then replaced: nothing to record.
  page.emit("did-start-navigation", { url: "https://chatgpt.com/", isMainFrame: true, isSameDocument: false });
  page.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://chatgpt.com/", true);
  // Answered, then replaced before it loaded: its response time stays.
  page.emit("did-start-navigation", { url: "https://chatgpt.com/", isMainFrame: true, isSameDocument: false });
  clock = 250;
  page.emit("did-navigate", {}, "https://chatgpt.com/", 200);
  page.emit("did-start-navigation", { url: "https://chatgpt.com/", isMainFrame: true, isSameDocument: false });
  page.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://chatgpt.com/", true);
  const [entry] = times.snapshot().pages;
  assert.equal(entry.group, "GPT Browser");
  assert.equal(entry.failures, 1);
  assert.equal(entry.lastError, "ERR_NAME_NOT_RESOLVED");
  assert.equal(entry.response.count, 1);
  assert.equal(entry.response.lastMs, 250);
  assert.equal(entry.render.count, 0);
});

test("older Electron's did-start-navigation arguments are read too", () => {
  const times = createActionTimes();
  const page = fakePage();
  watchPageTimes(page, { times, clock: () => 0 });
  page.emit("did-start-navigation", {}, "https://auth.openai.com/log-in", false, true);
  page.emit("did-finish-load");
  assert.equal(times.snapshot().pages[0].page, "auth.openai.com/log-in");
});

test("page names drop the query and fragment and collapse ids", () => {
  assert.equal(pageShape("https://chatgpt.com/?temporary-chat=true#x"), "chatgpt.com/");
  assert.equal(pageShape("https://chatgpt.com/g/g-p-6812abcdef0123456789/c/0f1e2d3c-4b5a"), "chatgpt.com/g/:id");
  assert.equal(pageShape("https://chatgpt.com/backend-api/me"), "chatgpt.com/backend-api/me");
  assert.equal(pageShape("about:blank"), null);
  assert.equal(pageShape("not a url"), null);
  assert.equal(partitionGroup("persist:coding-tools-chatgpt"), "Browser");
  assert.equal(partitionGroup("persist:coding-tools-register"), "Register");
  assert.equal(partitionGroup(null), "App");
});

test("the record stays bounded: oldest entries go first and each keeps its recent samples", () => {
  const times = createActionTimes();
  for (let index = 0; index < MAX_ENTRIES + 5; index += 1) times.pageTimed({ group: "Browser", page: `example.com/p${index}`, renderMs: index });
  const pages = times.snapshot().pages;
  assert.equal(pages.length, MAX_ENTRIES);
  assert.equal(pages[0].page, `example.com/p${MAX_ENTRIES + 4}`, "newest first");
  assert.equal(pages.some((item) => item.page === "example.com/p0"), false);
  for (let index = 0; index < MAX_SAMPLES + 10; index += 1) times.tabRendered({ tab: "browser", ms: index });
  const [browser] = times.snapshot().tabs;
  assert.equal(browser.render.count, MAX_SAMPLES + 10);
  assert.equal(browser.render.maxMs, MAX_SAMPLES + 9);
  assert.equal(browser.render.medianMs, 30, "the median of the last 40 samples (10-49)");
  times.clear();
  assert.deepEqual([times.snapshot().tabs.length, times.snapshot().pages.length], [0, 0]);
});

test("main times every page and every app-window request, and serves the record to Activity", () => {
  const main = read("electron", "main.cjs");
  assert.match(main, /app\.on\("web-contents-created", \(_event, contents\) => watchPageTimes\(contents, \{ times: actionTimes, describe: describeTimedPartition \}\)\);/);
  assert.match(main, /registerLoggedIpc\(ipcMain, logger, channel, timeIpcHandler\(actionTimes, channel, handler, \{ isAppWindow \}\)\);/);
  for (const channel of ["launcher:action-times", "launcher:action-times-clear", "launcher:action-time-tab"]) {
    assert.match(main, new RegExp(`handle\\("${channel}"`));
  }
  const preload = read("electron", "preload.cjs");
  assert.match(preload, /actionTimes: \(\) => ipcRenderer\.invoke\("launcher:action-times"\)/);
  assert.match(preload, /reportTabRender: \(input\) => ipcRenderer\.invoke\("launcher:action-time-tab", input\)/);
});

test("every tab switch in the app goes through the timed showSurface", () => {
  const app = read("src", "App.tsx");
  const bare = app.match(/\bsetSurface\(/g) ?? [];
  assert.equal(bare.length, 1, "setSurface is called only inside showSurface");
  assert.match(app, /useTabRenderTiming\(api, surface, tabSwitchStartedAt\);/);
  assert.match(app, /<ActionTimesPanel api=\{api!\} copy=\{copy\} setError=\{setError\} \/>/);
});
