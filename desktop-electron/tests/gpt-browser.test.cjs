const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGptBrowserHost, browsableUrl, cleanUserAgent, partitionFor } = require("../electron/gpt-browser.cjs");

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

test("the address bar accepts any http(s) site and defaults bare addresses to https", () => {
  assert.equal(browsableUrl("https://chatgpt.com/accept-referral?referral_context=abc"), "https://chatgpt.com/accept-referral?referral_context=abc");
  assert.equal(browsableUrl("  example.com/docs?q=1  "), "https://example.com/docs?q=1");
  assert.equal(browsableUrl("http://localhost:5173/"), "http://localhost:5173/");
  assert.equal(browsableUrl("127.0.0.1:8080"), "https://127.0.0.1:8080/");
  assert.equal(browsableUrl("HTTPS://Chatgpt.COM"), "https://chatgpt.com/");
  for (const bad of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "data:text/html,x", "ftp://example.com/",
    "https://a:b@chatgpt.com/", "https://foo", "two words.com", "", null, `https://example.com/${"x".repeat(5000)}`]) {
    assert.equal(browsableUrl(bad), null, String(bad));
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

test("an address opens in the active account's session", async () => {
  const world = fakeWorld();
  const browser = host(world, tempRoot());
  await assert.rejects(browser.openUrl("https://chatgpt.com/accept-referral?x=1"), /Add a ChatGPT account first/);
  await browser.addAccount();
  await assert.rejects(browser.openUrl("javascript:alert(1)"), /Enter a web address/);
  await browser.openUrl("https://chatgpt.com/accept-referral?x=1");
  assert.equal(world.views.at(-1).webContents.loads.at(-1), "https://chatgpt.com/accept-referral?x=1");
  await browser.openUrl("example.com/docs");
  assert.equal(world.views.at(-1).webContents.loads.at(-1), "https://example.com/docs");
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

test("web pages stay in the account's session; only mailto leaves the app", async () => {
  const world = fakeWorld();
  const opened = [];
  const browser = host(world, tempRoot(), { openExternal: async (url) => { opened.push(url); } });
  await browser.addAccount();
  const contents = world.views.at(-1).webContents;
  const navigate = (url) => {
    let prevented = false;
    contents.emit("will-navigate", { preventDefault() { prevented = true; } }, url);
    return prevented;
  };
  assert.equal(navigate("https://example.com/docs"), false);
  assert.equal(navigate("https://accounts.google.com/o/oauth2"), false, "Google sign-in stays in the account's session");
  assert.equal(navigate("mailto:help@example.com"), true);
  assert.equal(navigate("ms-settings:privacy"), true, "a page cannot launch other protocol handlers");
  assert.equal(navigate("file:///C:/Windows/win.ini"), true);
  assert.deepEqual(contents.openHandler({ url: "https://example.com/x" }), { action: "deny" });
  assert.equal(contents.loads.at(-1), "https://example.com/x", "a new-window link loads in place");
  assert.deepEqual(contents.openHandler({ url: "steam://run/1" }), { action: "deny" });
  assert.deepEqual(opened, ["mailto:help@example.com"]);
});

test("the account email is only read from chatgpt.com itself", async () => {
  const world = fakeWorld();
  const browser = host(world, tempRoot());
  await browser.addAccount();
  const contents = world.views.at(-1).webContents;
  contents.executeJavaScript = async () => "someone@example.com";
  await browser.openUrl("https://evilchatgpt.com/");
  contents.emit("did-stop-loading");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.status().accounts[0].email, null);
  await browser.openUrl("https://chatgpt.com/");
  contents.emit("did-stop-loading");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.status().accounts[0].email, "someone@example.com");
});

test("overlapping surface activation creates one page and hiding detaches it", async () => {
  const root = tempRoot();
  const saved = host(fakeWorld(), root);
  await saved.addAccount();
  saved.dispose();

  const world = fakeWorld();
  const releases = [];
  const browser = host(world, root, {
    prepareSession: () => new Promise((resolve) => releases.push(resolve)),
  });
  const bounds = { x: 0, y: 40, width: 800, height: 600 };
  browser.setBounds(bounds);
  // The mounted pane activates before its slot ref triggers a second layout effect.
  const first = browser.setSurfaceActive(true);
  const second = browser.setSurfaceActive(true);
  releases[0]();
  await first;
  releases[1]?.();
  await second;
  assert.equal(world.attached.size, 1, "the visible pane has one attached page");

  await browser.setSurfaceActive(false);
  browser.setBounds(bounds); // A late measurement must not leave an orphan view on top.
  assert.equal(world.attached.size, 0, "all account views leave the window on navigation");
  assert.equal(world.views.length, 1, "concurrent activation reuses the in-flight page");
  browser.dispose();
});

test("a failed shared page preparation can be retried", async () => {
  const root = tempRoot();
  const saved = host(fakeWorld(), root);
  await saved.addAccount();
  saved.dispose();

  const world = fakeWorld();
  let preparations = 0;
  const browser = host(world, root, {
    prepareSession: async () => {
      preparations += 1;
      if (preparations === 1) throw new Error("routing failed");
    },
  });
  await assert.rejects(Promise.all([
    browser.setSurfaceActive(true),
    browser.setSurfaceActive(true),
  ]), /routing failed/);
  assert.equal(world.views.length, 0);
  assert.equal(preparations, 1, "concurrent requests share the failed preparation");

  await browser.setSurfaceActive(true);
  browser.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  assert.equal(preparations, 2);
  assert.equal(world.views.length, 1);
  assert.equal(world.attached.size, 1);
  browser.dispose();
});

test("removal and shutdown cancel pending page creation", async () => {
  for (const action of ["remove", "dispose"]) {
    const root = tempRoot();
    const saved = host(fakeWorld(), root);
    await saved.addAccount();
    saved.dispose();

    const world = fakeWorld();
    let release;
    const browser = host(world, root, {
      prepareSession: () => new Promise((resolve) => { release = resolve; }),
    });
    const showing = browser.setSurfaceActive(true);
    const cancelled = assert.rejects(showing, /page creation was cancelled/);
    if (action === "remove") await browser.remove(browser.status().activeId);
    else browser.dispose();
    release();
    await cancelled;
    assert.equal(world.views.length, 0, action);
    assert.equal(world.attached.size, 0, action);
  }
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
