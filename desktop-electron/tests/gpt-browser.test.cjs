const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGptBrowserHost, chatgptPageUrl, cleanUserAgent, partitionFor } = require("../electron/gpt-browser.cjs");

function fakeWorld() {
  const sessions = new Map();
  const attached = new Set();
  const views = [];
  const sessionFor = (partition) => {
    if (!sessions.has(partition)) {
      sessions.set(partition, {
        partition, ua: "Mozilla/5.0 Chrome/140.0 Electron/41.10.7 coding-tools-desktop/0.7.0 Safari/537.36",
        cleared: 0, proxied: 0,
        getUserAgent() { return this.ua; }, setUserAgent(value) { this.ua = value; },
        async clearStorageData() { this.cleared += 1; },
      });
    }
    return sessions.get(partition);
  };
  const createView = (partition) => {
    const handlers = {};
    let url = "";
    const history = [];
    const contents = {
      partition, destroyed: false, openHandler: null, loads: [],
      isDestroyed() { return this.destroyed; },
      close() { this.destroyed = true; },
      getURL: () => url, getTitle: () => "ChatGPT",
      async loadURL(next) { this.loads.push(next); history.push(next); url = next; },
      on(name, handler) { (handlers[name] ||= []).push(handler); },
      emit(name, ...args) { for (const handler of handlers[name] || []) handler(...args); },
      setWindowOpenHandler(handler) { this.openHandler = handler; },
      reload() {}, async executeJavaScript() { return null; },
      navigationHistory: { canGoBack: () => history.length > 1, canGoForward: () => false, goBack() {}, goForward() {} },
    };
    const view = { webContents: contents, bounds: null, setBounds(value) { this.bounds = value; } };
    views.push(view);
    return view;
  };
  return {
    sessions, attached, views, sessionFor, createView,
    attachView: (view) => attached.add(view), detachView: (view) => attached.delete(view),
  };
}

function host(world, dataRoot, extra = {}) {
  return createGptBrowserHost({
    dataRoot, createView: world.createView, sessionFor: world.sessionFor,
    attachView: world.attachView, detachView: world.detachView,
    prepareSession: async (ses) => { ses.proxied += 1; },
    ...extra,
  });
}

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "gpt-browser-"));

test("only https chatgpt.com links are accepted", () => {
  assert.equal(chatgptPageUrl("https://chatgpt.com/accept-referral?referral_context=abc"), "https://chatgpt.com/accept-referral?referral_context=abc");
  for (const bad of ["http://chatgpt.com/", "https://evil.com/chatgpt.com", "https://chatgpt.com.evil.com/", "https://a:b@chatgpt.com/", "javascript:alert(1)", "", null]) {
    assert.equal(chatgptPageUrl(bad), null, String(bad));
  }
});

test("the Electron and app tokens are removed from the sign-in user agent", () => {
  assert.equal(cleanUserAgent("Mozilla/5.0 Chrome/140.0 Electron/41.10.7 coding-tools-desktop/0.7.0 Safari/537.36"), "Mozilla/5.0 Chrome/140.0 Safari/537.36");
});

test("each account gets its own persistent partition and survives a restart", async () => {
  const root = tempRoot();
  const world = fakeWorld();
  const first = host(world, root);
  await first.setSurfaceActive(true);
  first.setBounds({ x: 0, y: 40, width: 800, height: 600 });
  const a = (await first.addAccount()).activeId;
  const b = (await first.addAccount()).activeId;
  assert.notEqual(a, b);
  assert.deepEqual([...world.sessions.keys()], [partitionFor(a), partitionFor(b)]);
  assert.ok([...world.sessions.values()].every((ses) => ses.proxied === 1 && !/Electron/.test(ses.ua)));
  assert.equal(world.attached.size, 1, "only the active account is in the window");
  assert.equal([...world.attached][0].webContents.partition, partitionFor(b));

  await first.switchTo(a);
  assert.equal([...world.attached][0].webContents.partition, partitionFor(a));

  const again = host(fakeWorld(), root);
  assert.deepEqual(again.status().accounts.map((entry) => entry.id), [a, b]);
  assert.equal(again.status().activeId, a);
  const saved = fs.readFileSync(path.join(root, "accounts.json"), "utf8");
  assert.doesNotMatch(saved, /token|cookie|password/i);
});

test("a referral link opens in the active account's session", async () => {
  const world = fakeWorld();
  const browser = host(world, tempRoot());
  await assert.rejects(browser.openUrl("https://chatgpt.com/accept-referral?x=1"), /Add a ChatGPT account first/);
  await browser.addAccount();
  await assert.rejects(browser.openUrl("https://example.com/"), /Only https:\/\/chatgpt.com links/);
  await browser.openUrl("https://chatgpt.com/accept-referral?x=1");
  assert.equal(world.views.at(-1).webContents.loads.at(-1), "https://chatgpt.com/accept-referral?x=1");
});

test("removing an account erases its session and falls back to another", async () => {
  const world = fakeWorld();
  const browser = host(world, tempRoot());
  const a = (await browser.addAccount()).activeId;
  const b = (await browser.addAccount()).activeId;
  const after = await browser.remove(b);
  assert.equal(world.sessions.get(partitionFor(b)).cleared, 1);
  assert.equal(after.activeId, a);
  assert.deepEqual(after.accounts.map((entry) => entry.id), [a]);
});

test("pages outside ChatGPT sign-in hosts open in the system browser", async () => {
  const world = fakeWorld();
  const opened = [];
  const browser = host(world, tempRoot(), { openExternal: async (url) => { opened.push(url); } });
  await browser.addAccount();
  const contents = world.views.at(-1).webContents;
  let prevented = false;
  contents.emit("will-navigate", { preventDefault() { prevented = true; } }, "https://example.com/docs");
  assert.equal(prevented, true);
  prevented = false;
  contents.emit("will-navigate", { preventDefault() { prevented = true; } }, "https://accounts.google.com/o/oauth2");
  assert.equal(prevented, false, "Google sign-in stays in the account's session");
  assert.deepEqual(contents.openHandler({ url: "https://example.com/x" }), { action: "deny" });
  assert.deepEqual(opened, ["https://example.com/docs", "https://example.com/x"]);
});

test("hiding the pane takes the page out of the window", async () => {
  const world = fakeWorld();
  const browser = host(world, tempRoot());
  await browser.setSurfaceActive(true);
  browser.setBounds({ x: 0, y: 0, width: 10, height: 10 });
  await browser.addAccount();
  assert.equal(world.attached.size, 1);
  await browser.setSurfaceActive(false);
  assert.equal(world.attached.size, 0);
});
