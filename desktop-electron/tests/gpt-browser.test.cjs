require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
const { createGptBrowserHost, browsableUrl, cleanUserAgent, partitionFor, readGptBrowserState } = require("../electron/gpt-browser.cjs");

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

// Every root is removed when the file's tests end: left behind, each run added folders to the
// system temp directory (on the SSD), 614 of them by 2026-10-21.
const tempRoots = [];
const tempRoot = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-browser-")); tempRoots.push(root); return root; };
test.after(() => { for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true }); });

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
  // Saved off the main thread: the restart reads what reached the disk.
  await first.saved();

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

function removalSurface() {
  const slots = [], timers = new Map(), removed = []; let cursor = 0, nextTimer = 0, listener, activeId = "a", pending = [], dirty = false;
  const status = () => ({ activeId, accounts: [{ id: "a", label: "Account A" }, { id: "b", label: "Account B" }], page: null });
  const effect = (fn, deps) => { const at = cursor++, old = slots[at]; if (!old || deps?.some((value, i) => value !== old.deps?.[i])) {
    const slot = slots[at] = { deps, cleanup: old?.cleanup }; pending.push(() => { slot.cleanup?.(); slot.cleanup = fn(); });
  } };
  const react = {
    useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === "function" ? initial() : initial;
      return [slots[at], value => { const next = typeof value === "function" ? value(slots[at]) : value; dirty ||= next !== slots[at]; slots[at] = next; }]; },
    useRef(initial) { const at = cursor++; return slots[at] ?? (slots[at] = { current: initial }); },
    useEffect: effect, useLayoutEffect() { cursor++; }, useCallback: fn => fn,
  };
  const api = { gptBrowserStatus: async () => status(), onGptBrowserChanged: fn => { listener = fn; return () => { listener = null; }; },
    setGptBrowserSurfaceActive: async () => status(), switchGptBrowserAccount: async id => { activeId = id; return status(); },
    removeGptBrowserAccount: async id => { removed.push(id); return status(); } };
  const window = { setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id) };
  const jsx = (type, props) => ({ type, props }), exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/GptBrowserSurface.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : {}, window });
  const props = { api, active: false, setError() {} };
  const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
  const render = (runEffects = true) => { let view; do { cursor = 0; pending = []; dirty = false; view = exports.GptBrowserSurface(props); if (runEffects) for (const run of pending) run(); } while (runEffects && dirty); return view; };
  const button = (runEffects = true) => walk(render(runEffects)).find(item => item.props?.title === "Sign out and erase browser data");
  return { timers, removed, render, button, click: () => button().props.onClick(),
    select: id => walk(render()).find(item => item.type === "select").props.onChange({ target: { value: id } }),
    push(id) { activeId = id; listener(status()); }, expire(id) { const timer = timers.get(id); timers.delete(id); timer.fn(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

test("removal confirmation belongs to the account selected by the picker or status event", async t => {
  for (const via of ["picker", "status event"]) await t.test(via, async () => {
    const ui = removalSurface(); ui.render(); await new Promise(setImmediate); ui.click();
    if (via === "picker") ui.select("b"); else ui.push("b"); await new Promise(setImmediate);
    assert.equal(ui.button().props.children, "Remove account"); assert.equal(ui.button().props.className, "button-secondary");
    ui.click(); assert.deepEqual(ui.removed, []); assert.equal(ui.button().props.children, "Click again to remove");
    assert.equal(ui.timers.size, 1); ui.click(); await new Promise(setImmediate); assert.deepEqual(ui.removed, ["b"]); ui.unmount();
  });
});

test("switching away and back requires fresh removal confirmation", async () => {
  const ui = removalSurface(); ui.render(); await new Promise(setImmediate); ui.click(); ui.push("b"); ui.render(); ui.push("a");
  assert.equal(ui.button().props.children, "Remove account"); ui.click(); assert.deepEqual(ui.removed, []); ui.unmount();
});

test("account-owned confirmation protects the action before the account-change effect runs", async () => {
  const ui = removalSurface(); ui.render(); await new Promise(setImmediate); ui.click(); ui.push("b");
  const button = ui.button(false); assert.equal(button.props.children, "Remove account"); button.props.onClick();
  assert.deepEqual(ui.removed, []); assert.equal(ui.timers.size, 1); ui.unmount();
});

test("same-account removal retains its four-second expiry and clears timers on removal or unmount", async () => {
  const ui = removalSurface(); ui.render(); await new Promise(setImmediate); ui.click();
  const [id, timer] = [...ui.timers][0]; assert.equal(timer.delay, 4000); ui.expire(id);
  assert.equal(ui.button().props.children, "Remove account"); ui.click(); assert.deepEqual(ui.removed, []);
  ui.push("a"); assert.equal(ui.button().props.children, "Click again to remove"); ui.click(); await new Promise(setImmediate);
  assert.deepEqual(ui.removed, ["a"]); assert.equal(ui.timers.size, 0); ui.click(); assert.equal(ui.timers.size, 1);
  ui.unmount(); assert.equal(ui.timers.size, 0);
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
  await saved.saved();
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
  await saved.saved();
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
    await saved.saved();
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

test("saved accounts are read off the main thread and handed to the host", async () => {
  const root = tempRoot();
  const first = host(fakeWorld(), root);
  const id = (await first.addAccount()).activeId;
  await first.saved();
  first.dispose();

  const readSync = fs.readFileSync;
  let syncReads = 0;
  fs.readFileSync = (...args) => { syncReads += 1; return readSync(...args); };
  try {
    const text = await readGptBrowserState(root);
    const browser = host(fakeWorld(), root, { savedText: text });
    assert.deepEqual(browser.status().accounts.map((entry) => entry.id), [id]);
    assert.equal(syncReads, 0, "the host does not read the file again");
    browser.dispose();
    // None saved yet: an empty browser, with nothing logged.
    const warnings = [];
    const empty = await readGptBrowserState(tempRoot(), { warn: (...args) => warnings.push(args) });
    assert.equal(empty, null);
    assert.deepEqual(host(fakeWorld(), root, { savedText: empty }).status().accounts, []);
    assert.deepEqual(warnings, []);
  } finally {
    fs.readFileSync = readSync;
  }
});

function gptBrowserRecoveryFixture(content = JSON.stringify({
  activeId: "abcdefghijkl", accounts: [{ id: "abcdefghijkl", label: "Existing" }],
})) {
  const vm = require("node:vm");
  const captureRoot = path.resolve(__dirname, "../../aiTemp/gpt-browser-capture-only");
  const file = path.join(captureRoot, "gpt-browser", "accounts.json");
  const bytes = new Map([[file, content], [`${file}.bak`, content]]);
  const writes = [], warnings = [], reads = [];
  let fault = null;
  const read = (target, mode) => {
    assert.equal(target, file);
    reads.push(mode);
    if (fault) throw Object.assign(new Error("fixture accounts read failed"), { code: fault });
    return bytes.get(file);
  };
  const durable = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/durable-state.cjs"), "utf8"), {
    module: durable, require: name => name === "node:fs" ? {} : name === "./atomic-file.cjs" ? {
      writePrivateFileAtomicAsync: async (target, text) => {
        assert.ok(target === file || target === `${file}.bak`);
        writes.push(target); bytes.set(target, text);
      },
    } : require(name),
  });
  const world = fakeWorld(), loaded = { exports: {} };
  const context = vm.createContext({
    module: loaded, URL,
    require: name => name === "node:fs" ? {
      readFileSync: target => read(target, "sync"),
      promises: { readFile: async target => read(target, "async") },
    } : name === "./durable-state.cjs" ? durable.exports : require(name),
    gptBrowser: null, CORE_HOME: captureRoot, session: { fromPartition: world.sessionFor },
    WebContentsView: function (options) { return world.createView(options.webPreferences.partition); },
    mainWindow: null, routeGptBrowserSession: async () => {}, send() {},
    shell: { openExternal: async () => {} }, openWebUrl: async () => {},
  });
  const source = fs.readFileSync(path.join(__dirname, "../electron/gpt-browser.cjs"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const getHost = main.match(/function getGptBrowser\([^]*?\n}/)?.[0];
  assert.ok(getHost, "exercise the current main-process load and failed-promise reset");
  vm.runInContext(`${source}\n${getHost}`, context);
  const logger = { warn: event => warnings.push(event) };
  return {
    writes, warnings, reads, world,
    bytes: () => bytes.get(file), backup: () => bytes.get(`${file}.bak`),
    fault: code => { fault = code; },
    get: () => context.getGptBrowser(logger),
    open: () => loaded.exports.createGptBrowserHost({ logger, dataRoot: path.dirname(file), ...world }),
  };
}

test("an unreadable GPT Browser startup preserves both copies and retries a healthy async read", async t => {
  for (const code of ["EIO", "EACCES"]) await t.test(code, async () => {
    const f = gptBrowserRecoveryFixture(), original = f.bytes();
    f.fault(code);
    let browser, failure;
    try {
      browser = await f.get(); f.fault(null);
      await browser.addAccount(); await browser.saved();
    } catch (error) { failure = error; } finally { browser?.dispose(); }
    assert.equal(f.writes.length, 0, "Add must not overwrite a fallback registry or its backup");
    assert.equal(f.bytes(), original); assert.equal(f.backup(), original);
    assert.equal(failure?.code, code);
    assert.ok(f.warnings.includes("gpt_browser.state_unreadable"));
    f.fault(null);
    const recovered = await f.get();
    try {
      assert.deepEqual(Array.from(recovered.status().accounts, entry => entry.id), ["abcdefghijkl"]);
      assert.equal(recovered.status().activeId, "abcdefghijkl");
      await recovered.switchTo("abcdefghijkl");
      assert.ok(f.world.sessions.has(partitionFor("abcdefghijkl")));
      recovered.rename("abcdefghijkl", "Recovered"); await recovered.saved();
      assert.equal(JSON.parse(f.bytes()).accounts[0].label, "Recovered");
      assert.equal(f.reads.includes("sync"), false, "main startup stays off the synchronous read path");
    } finally { recovered.dispose(); }
  });
});

test("unusable GPT Browser JSON, root shape and direct reads cannot become writable empty hosts", async t => {
  for (const content of ["{", "null", "{}", '{"accounts":"invalid"}']) await t.test(content, async () => {
    const f = gptBrowserRecoveryFixture(content);
    let browser, failure;
    try { browser = await f.get(); await browser.addAccount(); await browser.saved(); }
    catch (error) { failure = error; } finally { browser?.dispose(); }
    assert.equal(f.writes.length, 0);
    assert.equal(f.bytes(), content); assert.equal(f.backup(), content);
    assert.ok(failure, "invalid saved data must reject the load");
    assert.ok(f.warnings.includes("gpt_browser.state_unreadable"));
  });
  await t.test("direct EIO", async () => {
    const f = gptBrowserRecoveryFixture(), original = f.bytes(); f.fault("EIO");
    let browser, failure;
    try { browser = f.open(); f.fault(null); await browser.addAccount(); await browser.saved(); }
    catch (error) { failure = error; } finally { browser?.dispose(); }
    assert.equal(f.writes.length, 0); assert.equal(f.bytes(), original); assert.equal(f.backup(), original);
    assert.equal(failure?.code, "EIO");
  });
});

test("missing, valid empty and optional GPT Browser metadata retain their startup behavior", async () => {
  for (const content of [null, '{"accounts":[]}']) {
    const f = gptBrowserRecoveryFixture(content); if (content === null) f.fault("ENOENT");
    const browser = await f.get();
    try {
      assert.equal(browser.status().accounts.length, 0);
      await browser.addAccount(); await browser.saved();
      assert.equal(JSON.parse(f.bytes()).accounts.length, 1);
      assert.equal(f.backup(), f.bytes()); assert.equal(f.writes.length, 2);
      assert.deepEqual(f.warnings, []);
    } finally { browser.dispose(); }
  }
  const f = gptBrowserRecoveryFixture('{"activeId":"abcdefghijkl","accounts":[{"id":"abcdefghijkl"}]}');
  const browser = await f.get();
  try {
    assert.deepEqual(Array.from(browser.status().accounts, entry => ({ ...entry })),
      [{ id: "abcdefghijkl", label: "ChatGPT account", email: null }]);
    browser.rename("abcdefghijkl", "Kept"); await browser.saved();
    assert.equal(typeof JSON.parse(f.bytes()).accounts[0].createdAt, "string");
  } finally { browser.dispose(); }
});

// The surface with its layout effects run: the native page, its still, and the frames between.
function stillSurface() {
  const slots = [], timers = new Map(), frames = [], calls = []; let cursor = 0, nextTimer = 0, pending = [], dirty = false, shot = null;
  const effect = (fn, deps) => { const at = cursor++, old = slots[at]; if (!old || deps?.some((value, i) => value !== old.deps?.[i])) {
    const slot = slots[at] = { deps, cleanup: old?.cleanup }; pending.push(() => { slot.cleanup?.(); slot.cleanup = fn(); });
  } };
  const react = {
    useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === "function" ? initial() : initial;
      return [slots[at], value => { const next = typeof value === "function" ? value(slots[at]) : value; dirty ||= next !== slots[at]; slots[at] = next; }]; },
    useRef(initial) { const at = cursor++; return slots[at] ?? (slots[at] = { current: initial }); },
    useEffect: effect, useLayoutEffect: effect, useCallback: fn => fn,
  };
  const status = { activeId: "a", accounts: [{ id: "a", label: "Account A" }], page: null };
  const api = { gptBrowserStatus: async () => status, onGptBrowserChanged: () => () => {},
    setGptBrowserSurfaceActive: async (active) => { calls.push(active ? "show" : "hide"); return status; },
    setGptBrowserBounds: async () => true,
    gptBrowserSnapshot: () => { calls.push("snapshot"); return new Promise((resolve) => { shot = resolve; }); } };
  const window = { setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    addEventListener() {}, removeEventListener() {} };
  const globals = { window, requestAnimationFrame: fn => frames.push(fn), cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} } };
  const jsx = (type, props) => ({ type, props }), exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/GptBrowserSurface.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : {}, ...globals });
  const props = { api, active: true, covered: false, setError() {} };
  const walk = item => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
  const render = () => { let view; do { cursor = 0; pending = []; dirty = false; view = exports.GptBrowserSurface(props); for (const run of pending) run(); } while (dirty); return view; };
  const element = { getBoundingClientRect: () => ({ x: 52, y: 60, width: 900, height: 600 }) };
  return { props, calls, timers, render,
    still: () => walk(render()).find(item => item.props?.className === "gpb-still")?.props.src ?? null,
    mountSlot() { walk(render()).find(item => item.props?.className === "gpb-slot").props.ref(element); render(); },
    snapshot: (url) => shot(url), frame() { for (const run of frames.splice(0)) run(); },
    expire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } } };
}

test("the sidebar sliding over the GPT Browser shows a still of the page, not a black pane", async () => {
  const ui = stillSurface();
  ui.render(); await new Promise(setImmediate); ui.mountSlot();
  assert.equal(ui.calls.at(-1), "show");
  ui.props.covered = true; ui.render();
  assert.equal(ui.calls.at(-1), "snapshot", "the page is captured before it leaves the window");
  ui.snapshot("data:image/jpeg;base64,AAAA"); await new Promise(setImmediate);
  assert.equal(ui.still(), "data:image/jpeg;base64,AAAA", "the still takes the page's place");
  assert.notEqual(ui.calls.at(-1), "hide", "the page stays until the still has drawn");
  ui.frame();
  assert.equal(ui.calls.at(-1), "hide");
  ui.props.covered = false; ui.render();
  assert.equal(ui.calls.at(-1), "show");
  assert.equal(ui.still(), "data:image/jpeg;base64,AAAA", "the still stays until the page has drawn over it");
  ui.expire(250); ui.render();
  assert.equal(ui.still(), null);
});

test("a sidebar gone before the page was captured leaves the page in the window", async () => {
  const ui = stillSurface();
  ui.render(); await new Promise(setImmediate); ui.mountSlot();
  const shown = ui.calls.length;
  ui.props.covered = true; ui.render();
  ui.props.covered = false; ui.render();
  ui.snapshot("data:image/jpeg;base64,BBBB"); await new Promise(setImmediate); ui.frame();
  assert.ok(!ui.calls.slice(shown).includes("hide"), "nothing hides the page once it is uncovered");
  assert.equal(ui.still(), null);
});
