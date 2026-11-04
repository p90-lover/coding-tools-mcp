const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");

// A WebContentsView stand-in: records visibility, bounds and background throttling.
function fakeView() {
  const contents = Object.assign(new EventEmitter(), {
    destroyed: false,
    throttling: true,
    isDestroyed() { return this.destroyed; },
    setBackgroundThrottling(allowed) { this.throttling = allowed; },
  });
  return { webContents: contents, visible: true, bounds: null, setVisible(v) { this.visible = v; }, setBounds(b) { this.bounds = b; } };
}

function host() {
  const logs = [];
  const h = Object.assign(Object.create(BrowserHost.prototype), {
    logger: { info: (event) => logs.push(event), warn() {}, error() {} },
    window: { getContentSize: () => [1200, 800], isVisible: () => true, isMinimized: () => false },
    parkedHomes: new Map(),
    turnTabs: new Map(),
    userTabs: new Map(),
    synced: 0,
  });
  h.syncViewVisibility = () => { h.synced += 1; };
  return { h, logs };
}

test("a parked account's page renders off-screen and unthrottled while it shows Cloudflare's check", () => {
  const { h, logs } = host();
  const parked = fakeView();
  h.parkedHomes.set("persist:other", { view: parked, userTabs: new Map() });
  h.watchCloudflareCheck(parked, true);
  h.hideView(parked);
  assert.equal(parked.visible, false, "a parked page is hidden");

  parked.webContents.emit("did-navigate", {}, "https://chatgpt.com/", 403);
  assert.equal(parked.visible, true, "the check's page renders");
  assert.equal(parked.webContents.throttling, false);
  assert.deepEqual(parked.bounds, h.hiddenTurnBounds(), "off-screen, never over the app");
  assert.ok(logs.includes("browser.cloudflare_check_rendering"));

  // The check passed: Cloudflare reloads the page and ChatGPT answers.
  parked.webContents.emit("did-navigate", {}, "https://chatgpt.com/", 200);
  assert.equal(parked.visible, false, "hidden again");
  assert.equal(parked.webContents.throttling, true, "throttled again");
  assert.ok(logs.includes("browser.cloudflare_check_cleared"));
  assert.equal(h.checkRendering.size, 0);
});

test("a check that never passes stops rendering after its tries, until it clears", () => {
  const { h } = host();
  const view = fakeView();
  h.watchCloudflareCheck(view, true);
  for (let i = 0; i < 3; i++) {
    view.webContents.emit("did-navigate", {}, "https://chatgpt.com/", 403);
    assert.equal(h.checkRendering.has(view), true, `try ${i + 1} renders`);
    h.endCheckRendering(view); // the time limit
    assert.equal(view.webContents.throttling, true);
  }
  view.webContents.emit("did-navigate", {}, "https://chatgpt.com/", 403);
  assert.equal(h.checkRendering.has(view), false, "a fourth failed check is left hidden");
  // Shown and passed once: the count starts over.
  view.webContents.emit("did-navigate", {}, "https://chatgpt.com/", 200);
  view.webContents.emit("did-navigate", {}, "https://chatgpt.com/", 403);
  assert.equal(h.checkRendering.has(view), true);
  h.endCheckRendering(view, { destroyed: true });
});

test("a turn tab keeps its own throttling setting after its check", () => {
  const { h } = host();
  const view = fakeView();
  view.webContents.throttling = false;
  h.watchCloudflareCheck(view, false);
  view.webContents.emit("did-navigate", {}, "https://chatgpt.com/", 403);
  view.webContents.emit("did-navigate", {}, "https://chatgpt.com/c/abc", 200);
  assert.equal(view.webContents.throttling, false);
});

test("leaving ChatGPT ends the check's rendering, and a closed page is let go", () => {
  const { h } = host();
  const view = fakeView();
  h.watchCloudflareCheck(view, true);
  view.webContents.emit("did-navigate", {}, "https://chatgpt.com/", 403);
  view.webContents.emit("did-navigate", {}, "https://auth.openai.com/log-in", 200);
  assert.equal(h.checkRendering.has(view), false);
  view.webContents.emit("did-navigate", {}, "https://chatgpt.com/", 403);
  view.webContents.destroyed = true;
  view.webContents.emit("destroyed");
  assert.equal(h.checkRendering.has(view), false);
});

test("the auth probes skip their session request on Cloudflare's check page", () => {
  const source = require("node:fs").readFileSync(require.resolve("../electron/browser-host.cjs"), "utf8");
  assert.match(source, /const checkShown = \(\$\{isCloudflareCheckPage\.toString\(\)\}\)\(document, window\);/);
  assert.match(source, /if \(\(\$\{isCloudflareCheckPage\.toString\(\)\}\)\(document, window\)\) return \{ status: 0 \};/);
});
