const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  chooseSyncDirection,
  desktopAuthFromCpa,
  fromCpa,
  fromDesktop,
  jwtEmail,
  parseRefreshTime,
  syncAccountPair,
} = require("../electron/chatgpt-desktop-sync.cjs");
const { cpaSlotId, planFromFileName } = require("../electron/chatgpt-desktop.cjs");

function fakeJwt(claims) {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function cpaFile({ refresh = "rt-cpa", access = fakeJwt({ exp: 2_000_000_000 }), lastRefresh, accountId = "acct-1" } = {}) {
  return {
    type: "codex",
    email: "person@example.com",
    account_id: accountId,
    id_token: fakeJwt({ email: "person@example.com" }),
    access_token: access,
    refresh_token: refresh,
    last_refresh: lastRefresh,
    expired: "2030-01-01T00:00:00Z",
    disabled: false,
  };
}

function tempPair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgd-sync-"));
  return { root, cpaPath: path.join(root, "codex-person.json"), desktopPath: path.join(root, "auth.json") };
}

const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("a CPA Codex account becomes a ChatGPT desktop auth.json", () => {
  const auth = desktopAuthFromCpa(cpaFile({ lastRefresh: "2026-09-01T00:00:00Z" }));
  assert.equal(auth.auth_mode, "chatgpt");
  assert.equal(auth.OPENAI_API_KEY, null);
  assert.deepEqual(Object.keys(auth.tokens).sort(), ["access_token", "account_id", "id_token", "refresh_token"]);
  assert.equal(auth.tokens.refresh_token, "rt-cpa");
  assert.equal(jwtEmail(auth.tokens.id_token), "person@example.com");
});

test("refresh times with nanosecond precision parse", () => {
  assert.equal(parseRefreshTime("2026-09-20T10:11:12.123456789Z"), Date.parse("2026-09-20T10:11:12.123Z"));
  assert.equal(parseRefreshTime("not a date"), null);
  assert.equal(parseRefreshTime(undefined), null);
});

test("identical credentials never sync", () => {
  const cpa = fromCpa(cpaFile({ lastRefresh: "2026-09-01T00:00:00Z" }));
  const desktop = fromDesktop(desktopAuthFromCpa(cpaFile({ lastRefresh: "2026-09-01T00:00:00Z" })));
  assert.equal(chooseSyncDirection(desktop, cpa), null);
});

test("the side refreshed most recently wins", () => {
  const older = "2026-09-01T00:00:00Z";
  const newer = "2026-09-10T00:00:00Z";
  const cpaOld = fromCpa(cpaFile({ refresh: "rt-old", lastRefresh: older }));
  const desktopNew = fromDesktop(desktopAuthFromCpa(cpaFile({ refresh: "rt-new", lastRefresh: newer })));
  assert.equal(chooseSyncDirection(desktopNew, cpaOld), "to-cpa");

  const cpaNew = fromCpa(cpaFile({ refresh: "rt-new", lastRefresh: newer }));
  const desktopOld = fromDesktop(desktopAuthFromCpa(cpaFile({ refresh: "rt-old", lastRefresh: older })));
  assert.equal(chooseSyncDirection(desktopOld, cpaNew), "to-desktop");
});

test("rotated desktop tokens are written back into CPA's file format", () => {
  const { cpaPath, desktopPath } = tempPair();
  write(cpaPath, cpaFile({ refresh: "rt-old", lastRefresh: "2026-09-01T00:00:00Z" }));
  write(desktopPath, desktopAuthFromCpa(cpaFile({ refresh: "rt-new", lastRefresh: "2026-09-10T00:00:00Z" })));

  assert.equal(syncAccountPair({ cpaPath, desktopPath }), "to-cpa");
  const cpa = read(cpaPath);
  assert.equal(cpa.refresh_token, "rt-new");
  assert.equal(cpa.type, "codex");
  assert.equal(cpa.email, "person@example.com");
  assert.equal(cpa.expired, new Date(2_000_000_000 * 1000).toISOString());
});

test("credentials are never copied between different ChatGPT accounts", () => {
  const { cpaPath, desktopPath } = tempPair();
  write(cpaPath, cpaFile({ refresh: "rt-a", accountId: "acct-a", lastRefresh: "2026-09-01T00:00:00Z" }));
  write(desktopPath, desktopAuthFromCpa(cpaFile({ refresh: "rt-b", accountId: "acct-b", lastRefresh: "2026-09-10T00:00:00Z" })));

  assert.equal(syncAccountPair({ cpaPath, desktopPath }), null);
  assert.equal(read(cpaPath).refresh_token, "rt-a");
  assert.equal(read(desktopPath).tokens.refresh_token, "rt-b");
});

test("a signed-out desktop slot leaves CPA alone", () => {
  const { cpaPath, desktopPath } = tempPair();
  write(cpaPath, cpaFile({ lastRefresh: "2026-09-01T00:00:00Z" }));
  assert.equal(syncAccountPair({ cpaPath, desktopPath }), null);
});

test("account slots are stable per ChatGPT account and file names yield the plan", () => {
  assert.equal(cpaSlotId("acct-1", "Person@Example.com"), cpaSlotId("acct-1", "person@example.com"));
  assert.notEqual(cpaSlotId("acct-1", "a@example.com"), cpaSlotId("acct-2", "a@example.com"));
  assert.match(cpaSlotId("acct-1", "a@example.com"), /^cpa-[a-f0-9]{16}$/);
  assert.equal(planFromFileName("codex-person@example.com-pro.json", "person@example.com"), "pro");
  assert.equal(planFromFileName("codex-person@example.com.json", "person@example.com"), null);
});

test("CPA Codex accounts are found by type, with or without the codex- file prefix", () => {
  const { createChatGptDesktopHost } = require("../electron/chatgpt-desktop.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-accounts-"));
  const authDir = path.join(root, "auth");
  fs.mkdirSync(authDir);
  const write = (name, body) => fs.writeFileSync(path.join(authDir, name), JSON.stringify(body));
  write("codex-a@x.com-pro.json", { type: "codex", email: "a@x.com", account_id: "1", refresh_token: "r" });
  write("b@x.com.json", { type: "codex", email: "b@x.com", account_id: "2", refresh_token: "r" });
  write("antigravity-c@x.com.json", { type: "antigravity", email: "c@x.com", refresh_token: "r" });
  try {
    const host = createChatGptDesktopHost({
      dataRoot: path.join(root, "data"),
      resolveCpaAuthDir: () => authDir,
      helper: { call: async () => null },
      platform: "linux",
    });
    const accounts = host.status().accounts;
    assert.deepEqual(accounts.map((a) => [a.email, a.plan, a.source]), [
      ["a@x.com", "pro", "cpa"],
      ["b@x.com", null, "cpa"],
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the proxy route is read from the environment and never carries credentials", () => {
  const { proxyRouteFromEnvironment } = require("../electron/chatgpt-desktop.cjs");
  assert.deepEqual(
    proxyRouteFromEnvironment({ HTTPS_PROXY: "http://127.0.0.1:17891", NO_PROXY: "localhost, 127.0.0.1,,::1" }),
    { url: "http://127.0.0.1:17891", bypass: ["localhost", "127.0.0.1", "::1"] },
  );
  assert.equal(proxyRouteFromEnvironment({}), null);
  assert.equal(proxyRouteFromEnvironment({ HTTPS_PROXY: "http://user:pw@proxy:8080" }), null);
});

test("a launched ChatGPT instance inherits Coding Tools' proxy route", async () => {
  const { createChatGptDesktopHost } = require("../electron/chatgpt-desktop.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-proxy-"));
  const location = path.join(root, "pkg");
  fs.mkdirSync(path.join(location, "app"), { recursive: true });
  fs.writeFileSync(path.join(location, "app", "ChatGPT.exe"), "");
  const calls = [];
  const helper = {
    dispose() {},
    call: async (op, input) => {
      calls.push({ op, input });
      if (op === "package") return { location, family: "OpenAI.Codex_test", version: "1" };
      if (op === "find") return calls.some((c) => c.op === "launch") ? { pid: 42, hwnd: 7 } : null;
      return null;
    },
  };
  try {
    const host = createChatGptDesktopHost({
      dataRoot: path.join(root, "data"),
      resolveCpaAuthDir: () => path.join(root, "no-cpa"),
      helper,
      platform: "win32",
      getProxyRoute: () => ({ url: "http://127.0.0.1:17891", bypass: ["localhost", "::1"] }),
    });
    await host.initialize();
    await host.newSignIn();
    const launch = calls.find((c) => c.op === "launch").input.arguments;
    assert.match(launch, /set "HTTPS_PROXY=http:\/\/127\.0\.0\.1:17891"&& /);
    assert.match(launch, /set "NO_PROXY=localhost,::1"&& /);
    assert.match(launch, /ChatGPT\.exe" --proxy-server="http:\/\/127\.0\.0\.1:17891" --proxy-bypass-list="localhost;::1"$/);
    await host.shutdown?.();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an account added in CPA reaches the picker without a restart", async () => {
  const { createChatGptDesktopHost } = require("../electron/chatgpt-desktop.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-watch-"));
  const authDir = path.join(root, "auth");
  fs.mkdirSync(authDir);
  const write = (name, body) => fs.writeFileSync(path.join(authDir, name), JSON.stringify(body));
  write("a@x.com.json", { type: "codex", email: "a@x.com", account_id: "1", refresh_token: "r" });
  const seen = [];
  const host = createChatGptDesktopHost({
    dataRoot: path.join(root, "data"),
    resolveCpaAuthDir: () => authDir,
    helper: { call: async () => null, dispose() {} },
    platform: "linux",
    onChange: (status) => seen.push(status.accounts.map((a) => a.email)),
  });
  try {
    await host.initialize();
    const before = seen.length;
    write("b@x.com.json", { type: "codex", email: "b@x.com", account_id: "2", refresh_token: "r" });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !seen.slice(before).some((emails) => emails.includes("b@x.com"))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(seen.at(-1), ["a@x.com", "b@x.com"]);
    // An unrelated rewrite with the same accounts does not re-emit.
    const settled = seen.length;
    write("b@x.com.json", { type: "codex", email: "b@x.com", account_id: "2", refresh_token: "r2" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(seen.length, settled);
  } finally {
    await host.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A fake of the win32 helper: launched processes get a window, keyed by the slot's APPDATA.
function fakeDesktopWorld(root) {
  const location = path.join(root, "pkg");
  fs.mkdirSync(path.join(location, "app"), { recursive: true });
  fs.writeFileSync(path.join(location, "app", "ChatGPT.exe"), "");
  const windows = new Map(); // hwnd -> { pid, marker, visible }
  const log = [];
  let next = 100;
  const helper = {
    dispose() {},
    call: async (op, input = {}) => {
      log.push(op);
      switch (op) {
        case "package": return { location, family: "OpenAI.Codex_test", version: "1" };
        case "launch": {
          const marker = /set "APPDATA=([^"]+)"/.exec(input.arguments)[1];
          const hwnd = next++;
          windows.set(hwnd, { pid: hwnd + 1000, marker, visible: true });
          return null;
        }
        case "find": {
          for (const [hwnd, w] of windows) if (w.marker === input.marker) return { pid: w.pid, hwnd };
          return null;
        }
        case "alive": return windows.has(input.hwnd);
        case "hide": if (windows.has(input.hwnd)) windows.get(input.hwnd).visible = false; return null;
        case "place": if (windows.has(input.hwnd)) windows.get(input.hwnd).visible = true; return null;
        case "close": windows.delete(input.hwnd); return null;
        case "running": return [...windows.values()].some((w) => w.pid === input.pid);
        case "kill-tree": for (const [hwnd, w] of windows) if (w.pid === input.pid) windows.delete(hwnd); return null;
        default: return null;
      }
    },
  };
  const visibleMarkers = () => [...windows.values()].filter((w) => w.visible).map((w) => w.marker);
  return { helper, windows, log, launches: () => log.filter((op) => op === "launch").length, visibleMarkers };
}

function cpaFolder(root, accounts) {
  const authDir = path.join(root, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  for (const [email, id] of accounts) {
    fs.writeFileSync(path.join(authDir, `${email}.json`),
      JSON.stringify({ type: "codex", email, account_id: id, refresh_token: "r" }));
  }
  return authDir;
}

async function until(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("a new account's profile skips the sandbox prompt and onboarding, keeping earlier choices", async () => {
  const { createChatGptDesktopHost, cpaSlotId } = require("../electron/chatgpt-desktop.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-seed-"));
  const world = fakeDesktopWorld(root);
  const authDir = cpaFolder(root, [["a@x.com", "acct-a"], ["b@x.com", "acct-b"]]);
  const dataRoot = path.join(root, "data");
  // b@x.com already chose a sandbox mode; that choice must survive.
  const bHome = path.join(dataRoot, "slots", cpaSlotId("acct-b", "b@x.com"), "codex-home");
  fs.mkdirSync(bHome, { recursive: true });
  fs.writeFileSync(path.join(bHome, "config.toml"), 'model = "x"\n\n[windows]\nsandbox = "elevated"\n');
  const host = createChatGptDesktopHost({
    dataRoot, resolveCpaAuthDir: () => authDir, helper: world.helper, platform: "win32",
    getProxyRoute: () => null, homeDir: path.join(root, "home"), autoStart: false,
  });
  try {
    await host.initialize();
    for (const [email, id] of [["a@x.com", "acct-a"], ["b@x.com", "acct-b"]]) await host.open(cpaSlotId(id, email));
    const aHome = path.join(dataRoot, "slots", cpaSlotId("acct-a", "a@x.com"), "codex-home");
    assert.match(fs.readFileSync(path.join(aHome, "config.toml"), "utf8"), /\[windows\]\nsandbox = "unelevated"/);
    assert.match(fs.readFileSync(path.join(bHome, "config.toml"), "utf8"), /sandbox = "elevated"/);
    assert.doesNotMatch(fs.readFileSync(path.join(bHome, "config.toml"), "utf8"), /unelevated/);
    const atoms = JSON.parse(fs.readFileSync(path.join(aHome, ".codex-global-state.json"), "utf8"))["electron-persisted-atom-state"];
    assert.equal(atoms["electron:onboarding-welcome-v2-role-state"].completedConversationalOnboarding, true);
    assert.deepEqual(atoms["electron:onboarding-conversational-completed-by-account-id"], { "acct-a": true });
    assert.equal(typeof atoms.last_completed_onboarding, "number");
  } finally {
    await host.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only the shown account starts by itself; switching starts each account once", async () => {
  const { createChatGptDesktopHost, cpaSlotId, slotPaths } = require("../electron/chatgpt-desktop.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-switch-"));
  const world = fakeDesktopWorld(root);
  const authDir = cpaFolder(root, [["a@x.com", "acct-a"], ["b@x.com", "acct-b"]]);
  const dataRoot = path.join(root, "data");
  const host = createChatGptDesktopHost({
    dataRoot, resolveCpaAuthDir: () => authDir, helper: world.helper, platform: "win32",
    getProxyRoute: () => null, homeDir: path.join(root, "home"),
  });
  const a = cpaSlotId("acct-a", "a@x.com");
  const b = cpaSlotId("acct-b", "b@x.com");
  try {
    await host.initialize();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(world.launches(), 0, "no account is shown yet, so nothing starts in the background");
    host.setOwner(1);
    host.setSurfaceActive(true);
    host.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    await host.open(a);
    await host.open(b);
    await host.open(a);
    assert.equal(world.launches(), 2, "each account starts once; switching back does not relaunch");
    assert.ok(await until(() => world.visibleMarkers().length === 1));
    assert.deepEqual(world.visibleMarkers(), [slotPaths(dataRoot, a).roaming]);
  } finally {
    await host.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a background account nobody uses is closed when idle; the shown one stays", async () => {
  const { createChatGptDesktopHost, cpaSlotId } = require("../electron/chatgpt-desktop.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-idle-"));
  const world = fakeDesktopWorld(root);
  const authDir = cpaFolder(root, [["a@x.com", "acct-a"], ["b@x.com", "acct-b"]]);
  const host = createChatGptDesktopHost({
    dataRoot: path.join(root, "data"), resolveCpaAuthDir: () => authDir, helper: world.helper,
    platform: "win32", getProxyRoute: () => null, homeDir: path.join(root, "home"), idleCloseMs: 200,
  });
  const a = cpaSlotId("acct-a", "a@x.com");
  const b = cpaSlotId("acct-b", "b@x.com");
  try {
    await host.initialize();
    await host.open(b);
    await host.open(a);
    assert.equal(host.status().runningSlotIds.length, 2);
    assert.ok(await until(() => host.status().runningSlotIds.length === 1, 8_000), "idle background account closed");
    assert.deepEqual(host.status().runningSlotIds, [a]);
    assert.equal(host.status().running, true);
  } finally {
    await host.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unclear cases leave both sides alone; a missing refresh time falls back to access-token expiry", () => {
  const same = "2026-09-05T00:00:00Z";
  // Same refresh time but different tokens: no safe winner.
  assert.equal(chooseSyncDirection(
    fromDesktop(desktopAuthFromCpa(cpaFile({ refresh: "rt-a", lastRefresh: same }))),
    fromCpa(cpaFile({ refresh: "rt-b", lastRefresh: same })),
  ), null);
  // One refresh time missing: the access token that expires later was issued later.
  const later = fromDesktop(desktopAuthFromCpa(cpaFile({ refresh: "rt-new", access: fakeJwt({ exp: 2_000_000_500 }), lastRefresh: same })));
  const earlierNoTime = fromCpa(cpaFile({ refresh: "rt-old", access: fakeJwt({ exp: 2_000_000_000 }) }));
  assert.equal(earlierNoTime.lastRefresh, null);
  assert.equal(chooseSyncDirection(later, earlierNoTime), "to-cpa");
  assert.equal(chooseSyncDirection(fromDesktop(desktopAuthFromCpa(cpaFile({ refresh: "rt-old", access: fakeJwt({ exp: 2_000_000_000 }), lastRefresh: same }))),
    fromCpa(cpaFile({ refresh: "rt-new", access: fakeJwt({ exp: 2_000_000_500 }) }))), "to-desktop");
  // No readable expiry: a side with a refresh time wins over one without; neither moves nothing.
  assert.equal(chooseSyncDirection(
    fromDesktop(desktopAuthFromCpa(cpaFile({ refresh: "rt-a", access: "opaque", lastRefresh: same }))),
    fromCpa(cpaFile({ refresh: "rt-b", access: "opaque" })),
  ), "to-cpa");
  const noTime = (refresh) => { const side = fromCpa(cpaFile({ refresh, access: "opaque" })); assert.equal(side.lastRefresh, null); return side; };
  assert.equal(chooseSyncDirection(noTime("rt-a"), noTime("rt-b")), null);
});

// An instance that starts but has not shown its window yet: the helper finds its process
// (pid) but no window (hwnd 0) until reveal() is called.
function slowDesktopWorld(root) {
  const world = fakeDesktopWorld(root);
  const pending = new Map(); // marker -> pid
  const call = world.helper.call;
  world.helper.call = async (op, input = {}) => {
    if (op === "launch") {
      world.log.push(op);
      const marker = /set "APPDATA=([^"]+)"/.exec(input.arguments)[1];
      pending.set(marker, 5000 + pending.size);
      return null;
    }
    if (op === "find" && pending.has(input.marker)) return { pid: pending.get(input.marker), hwnd: 0 };
    return call(op, input);
  };
  return { ...world, pendingCount: () => pending.size };
}

test("a slot whose instance is still starting is not launched a second time", async () => {
  const { createChatGptDesktopHost, cpaSlotId } = require("../electron/chatgpt-desktop.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-slow-"));
  const world = slowDesktopWorld(root);
  const authDir = cpaFolder(root, [["a@x.com", "acct-a"]]);
  const host = createChatGptDesktopHost({
    dataRoot: path.join(root, "data"), resolveCpaAuthDir: () => authDir, helper: world.helper, platform: "win32",
    getProxyRoute: () => null, homeDir: path.join(root, "home"), autoStart: false, windowWaitMs: 200,
  });
  try {
    await host.initialize();
    const slotId = cpaSlotId("acct-a", "a@x.com");
    await assert.rejects(host.open(slotId), /did not open a window/);
    await assert.rejects(host.open(slotId), /did not open a window/);
    assert.equal(world.launches(), 1, "the second open must wait for the running instance, not start another");
  } finally {
    await host.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an account whose auto-start failed is not retried on every account change", async () => {
  const { createChatGptDesktopHost, cpaSlotId } = require("../electron/chatgpt-desktop.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-backoff-"));
  const world = slowDesktopWorld(root);
  const authDir = cpaFolder(root, [["a@x.com", "acct-a"]]);
  const dataRoot = path.join(root, "data");
  // a@x.com was the shown account when Coding Tools last closed, so it starts by itself.
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify({ active: cpaSlotId("acct-a", "a@x.com"), local: [] }));
  const host = createChatGptDesktopHost({
    dataRoot, resolveCpaAuthDir: () => authDir, helper: world.helper, platform: "win32",
    getProxyRoute: () => null, homeDir: path.join(root, "home"), windowWaitMs: 200, autoStartRetryMs: 60_000,
  });
  try {
    await host.initialize();
    const waitFor = async (predicate) => {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await waitFor(() => world.launches() >= 1);
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // let a@x.com's background wait time out
    // A CPA token refresh rewrites auth files; adding b@x.com changes the account list the same way.
    cpaFolder(root, [["b@x.com", "acct-b"]]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(world.launches(), 1, "a@x.com failed recently and b@x.com is not shown, so nothing starts");
  } finally {
    await host.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("copies left running by an earlier Coding Tools are closed on start, except the shown one", async () => {
  const { createChatGptDesktopHost, cpaSlotId, slotPaths } = require("../electron/chatgpt-desktop.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-orphans-"));
  const world = fakeDesktopWorld(root);
  const authDir = cpaFolder(root, [["a@x.com", "acct-a"], ["b@x.com", "acct-b"]]);
  const dataRoot = path.join(root, "data");
  const a = cpaSlotId("acct-a", "a@x.com");
  const b = cpaSlotId("acct-b", "b@x.com");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify({ active: a, local: [] }));
  // Both accounts still have a copy from before the restart.
  world.windows.set(900, { pid: 1900, marker: slotPaths(dataRoot, a).roaming, visible: false });
  world.windows.set(901, { pid: 1901, marker: slotPaths(dataRoot, b).roaming, visible: false });
  const host = createChatGptDesktopHost({
    dataRoot, resolveCpaAuthDir: () => authDir, helper: world.helper, platform: "win32",
    getProxyRoute: () => null, homeDir: path.join(root, "home"),
  });
  try {
    await host.initialize();
    assert.deepEqual(host.status().runningSlotIds, [a], "the shown account's copy is kept");
    assert.ok(!world.windows.has(901), "the other account's leftover copy is closed");
    assert.equal(world.launches(), 0, "nothing new is started");
  } finally {
    await host.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
