"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAntigravityCli, loadManifest, platformAsset, shimBody, shimProxyEnvironment, manualAuthEnvironment } = require("../electron/antigravity-cli.cjs");
const { createAntigravityReauth, needsAuth } = require("../electron/cpa-antigravity-reauth.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

const fixtureRoot = path.resolve(__dirname, "../../aiTemp", `antigravity-auth-fixes-${process.pid}`);
fs.mkdirSync(fixtureRoot, { recursive: true });
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
const temp = () => fs.mkdtempSync(path.join(fixtureRoot, "agy-test-"));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test("the Antigravity CLI is pinned to a checksum-verified official GitHub release", () => {
  const manifest = loadManifest();
  assert.equal(manifest.repository, "google-antigravity/antigravity-cli");
  const asset = platformAsset(manifest, "win32", "x64");
  assert.equal(asset.url, `https://github.com/google-antigravity/antigravity-cli/releases/download/${manifest.version}/agy_cli_windows_x64.zip`);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => platformAsset(manifest, "freebsd", "x64"), /no pinned build/);
});

test("install refuses a download whose checksum or host does not match the pin", async () => {
  const root = temp();
  const manifestPath = path.join(root, "manifest.json");
  const bytes = Buffer.from("not the real archive");
  fs.writeFileSync(manifestPath, JSON.stringify({ id: "antigravity-cli", version: "1.0.0", command: "agy",
    repository: "google-antigravity/antigravity-cli", platforms: { win32: { x64: {
      fileName: "agy_cli_windows_x64.zip", size: bytes.length, sha256: "0".repeat(64) } } } }));
  const body = async function* () { yield bytes; };
  let hops = 0;
  const cli = createAntigravityCli({
    toolsRoot: path.join(root, "tools"), manifestPath, platform: "win32", arch: "x64", confirm: async () => true, getWorkspaces: async () => [],
    fetchImpl: async (url) => {
      hops += 1;
      if (String(url).startsWith("https://github.com/")) return { status: 302, headers: new Map([["location", "https://objects.githubusercontent.com/x"]]) };
      return { status: 200, ok: true, body: body() };
    },
  });
  await assert.rejects(cli.install(), /pinned checksum/);
  assert.equal(hops, 2);
  assert.equal(cli.status().installed, false);
  const evil = createAntigravityCli({
    toolsRoot: path.join(root, "tools2"), manifestPath, platform: "win32", arch: "x64", confirm: async () => true, getWorkspaces: async () => [],
    fetchImpl: async () => ({ status: 302, headers: new Map([["location", "https://example.com/agy.zip"]]) }),
  });
  await assert.rejects(evil.install(), /left the pinned GitHub release/);
  const declined = createAntigravityCli({
    toolsRoot: path.join(root, "tools3"), manifestPath, platform: "win32", arch: "x64", confirm: async () => false, getWorkspaces: async () => [],
    fetchImpl: async () => { throw new Error("must not download without consent"); },
  });
  assert.equal((await declined.install()).cancelled, true);
});

test("a verified archive installs a shim for Agent Orchestrator and retires older builds to Trash", async () => {
  const root = temp();
  const payload = path.join(root, "payload");
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, "antigravity.exe"), "binary");
  const archive = path.join(root, "agy.zip");
  require("node:child_process").execFileSync(require("../electron/antigravity-cli.cjs").tarBinary(), ["-a", "-cf", archive, "-C", payload, "antigravity.exe"]);
  const bytes = fs.readFileSync(archive);
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ id: "antigravity-cli", version: "2.0.0", command: "agy",
    repository: "google-antigravity/antigravity-cli", platforms: { win32: { x64: {
      fileName: "agy_cli_windows_x64.zip", size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") } } } }));
  const toolsRoot = path.join(root, "tools");
  fs.mkdirSync(path.join(toolsRoot, "antigravity-cli", "1.0.0"), { recursive: true });
  const cli = createAntigravityCli({
    toolsRoot, manifestPath, platform: "win32", arch: "x64", confirm: async () => true, getWorkspaces: async () => [],
    fetchImpl: async () => ({ status: 200, ok: true, body: (async function* () { yield bytes; })() }),
  });
  const status = await cli.install();
  assert.equal(status.installed, true);
  fs.writeFileSync(path.join(toolsRoot, "bin", "agy.cmd"), "outdated shim");
  assert.equal(cli.binDir(), path.join(toolsRoot, "bin"));
  assert.match(fs.readFileSync(path.join(toolsRoot, "bin", "agy.cmd"), "utf8"), /SSH_CLIENT/, "AO lookup must refresh an older installed shim");
  const shim = fs.readFileSync(path.join(toolsRoot, "bin", "agy.cmd"), "utf8");
  assert.match(shim, /2\.0\.0.*antigravity\.exe/s);
  assert.match(shim, /if not defined CODING_TOOLS_AGY_HTTPS_PROXY/);
  assert.equal(cli.executable(), path.join(toolsRoot, "antigravity-cli", "2.0.0", "antigravity.exe"));
  assert.equal(fs.existsSync(path.join(toolsRoot, "antigravity-cli", "1.0.0")), false);
  assert.equal(fs.readdirSync(path.join(toolsRoot, "Trash", "antigravity-cli")).length, 1);
});

function fakeCpa(files) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({ path: target.pathname, search: target.search, method: options.method || "GET", body: options.body });
    const reply = (status, value) => ({ ok: status < 400, status, json: async () => value });
    if (target.pathname === "/v0/management/auth-files") return reply(200, { files: files() });
    if (target.pathname === "/v0/management/auth-files/refresh") return reply(500, { error: "invalid_grant: token has been revoked" });
    if (target.pathname === "/v0/management/auth-files/status") return reply(200, { ok: true });
    return reply(404, {});
  };
  return { calls, fetchImpl };
}

test("CPA Antigravity re-auth refreshes first, then signs in once and disables the stale account", async () => {
  let files = [
    { name: "antigravity-old.json", provider: "antigravity", email: "me@example.com", status: "error", status_message: "invalid_grant" },
    { name: "codex.json", provider: "codex", email: "me@example.com", status: "error", status_message: "invalid_grant" },
  ];
  const { calls, fetchImpl } = fakeCpa(() => files);
  const notices = [];
  const logins = [];
  let clock = 1_000;
  const reauth = createAntigravityReauth({
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: "k".repeat(40) }),
    openExternal: async () => undefined, notify: notice => notices.push(notice), fetchImpl, now: () => clock,
    statePath: path.join(temp(), "state.json"), logger: {},
    login: async ({ adapterId, identity }) => {
      logins.push({ adapterId, identity });
      files = [...files, { name: "antigravity-new.json", provider: "antigravity", email: "me@example.com", status: "active" }];
      return { authFile: { name: "antigravity-new.json", identity: "me@example.com", provider: "antigravity", status: "connected", raw: {} } };
    },
  });
  const report = await reauth.sweep();
  assert.deepEqual(report.signIn, ["me@example.com"]);
  assert.deepEqual(logins, [{ adapterId: "cpa-antigravity", identity: "me@example.com" }]);
  assert.equal(notices.length, 1);
  assert.equal(calls.filter(call => call.path.endsWith("/refresh")).length, 1);
  const disabled = calls.find(call => call.path.endsWith("/status"));
  assert.deepEqual(JSON.parse(disabled.body), { name: "antigravity-old.json", disabled: true });
  assert.ok(!calls.some(call => call.method === "DELETE"));

  files = files.map(file => file.name === "antigravity-new.json" ? { ...file, status: "error", status_message: "token expired" } : file);
  clock += 60_000;
  const second = await reauth.sweep();
  assert.deepEqual(second.signIn, []);
  assert.equal(logins.length, 1, "no second browser prompt inside the rate limit");
  assert.equal(reauth.setAuto(false).auto, false);
  assert.equal((await reauth.status()).auto, false);
});

test("re-auth status exposes account health without token material", async () => {
  const { fetchImpl } = fakeCpa(() => [{ name: "a.json", provider: "antigravity", email: "me@example.com",
    status: "error", status_message: "refresh token failed Bearer ya29.secret-token" }]);
  const reauth = createAntigravityReauth({ cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: "k".repeat(40) }),
    openExternal: async () => undefined, fetchImpl, statePath: path.join(temp(), "s.json"), logger: {} });
  const status = await reauth.status();
  assert.equal(status.needsAttention, 1);
  assert.doesNotMatch(JSON.stringify(status), /ya29|secret-token|kkkk/);
  assert.equal(needsAuth({ disabled: true, status: "expired" }), false);
});

test("switching accounts cancels the old attempt and ignores its stale completion", async () => {
  const files = ["a", "b"].map(name => ({ name: `${name}.json`, provider: "antigravity", email: `${name}@example.com`, status: "error" }));
  const { calls, fetchImpl } = fakeCpa(() => files);
  const attempts = [];
  const reauth = createAntigravityReauth({
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: "key" }),
    openExternal: async () => {}, fetchImpl, statePath: path.join(temp(), "state.json"), logger: {},
    login: options => new Promise(resolve => attempts.push({ ...options, resolve })),
  });
  const a = reauth.signIn("a.json");
  await nextTurn();
  const b = reauth.signIn("b.json");
  await nextTurn();
  assert.equal(attempts.length, 2, "another account must not receive the first account's promise");
  assert.equal(attempts[0].signal.aborted, true);
  assert.equal((await reauth.status()).signInAccount.name, "b.json");
  attempts[0].resolve({ authFile: { name: "a-new.json", identity: "a@example.com", provider: "antigravity" } });
  assert.equal((await a).cancelled, true);
  assert.equal((await reauth.status()).signInAccount.name, "b.json");
  assert.equal(calls.some(call => call.path.endsWith("/status")), false, "a cancelled attempt must not disable accounts");
  attempts[1].resolve({ authFile: { name: "b-new.json", identity: "b@example.com", provider: "antigravity" } });
  assert.equal((await b).account.name, "b-new.json");
  assert.equal((await reauth.status()).signingIn, false);
});

test("cancel is account-scoped, and stopping re-auth aborts its active login", async () => {
  const { fetchImpl } = fakeCpa(() => [{ name: "a.json", provider: "antigravity", email: "a@example.com" }]);
  let signal;
  const reauth = createAntigravityReauth({
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: "key" }),
    openExternal: async () => {}, fetchImpl, statePath: path.join(temp(), "state.json"), logger: {},
    login: options => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const pending = reauth.signIn("a.json");
  await nextTurn();
  assert.equal(reauth.cancelSignIn("b.json").cancelled, false);
  assert.equal(signal.aborted, false);
  reauth.stop();
  assert.equal((await pending).cancelled, true);
  assert.equal((await reauth.status()).signingIn, false);
});

test("Google sign-in applies its selected proxy before navigation and owns browser cancellation", async () => {
  const { createAntigravityAuthBrowser } = require("../electron/antigravity-auth-browser.cjs");
  const { EventEmitter } = require("node:events");
  const events = [];
  let browser;
  let cancelled = 0;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); browser = this; this.options = options; events.push("window"); this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.popup = handler; };
    }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) { events.push(["load", url]); }
    show() { events.push("show"); }
    close() { this.destroyed = true; this.emit("closed"); }
  }
  const browserSession = {
    async setProxy(options) { events.push(["proxy", options]); },
    getUserAgent: () => "Chrome/130 Electron/33 coding-tools/1", setUserAgent() {},
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
  };
  const open = createAntigravityAuthBrowser({
    BrowserWindow: FakeWindow, sessionFor: () => browserSession, cleanUserAgent: require("../electron/gpt-browser.cjs").cleanUserAgent,
    proxyEnvironment: () => ({ HTTPS_PROXY: "http://user:p%40ss@127.0.0.1:7890", NO_PROXY: "localhost,127.0.0.1" }),
  });
  const handle = await open("https://accounts.google.com/o/oauth2/auth", { onCancel: () => { cancelled += 1; } });
  assert.equal(events[0][0], "proxy");
  assert.equal(events[0][1].proxyRules, "http://127.0.0.1:7890");
  assert.equal(events[1], "window");
  let credentials;
  browser.webContents.emit("login", { preventDefault() {} }, {}, { isProxy: true, host: "127.0.0.1", port: 7890 },
    (...values) => { credentials = values; });
  assert.deepEqual(credentials, ["user", "p@ss"]);
  handle.close();
  assert.equal(cancelled, 0, "programmatic completion is not cancellation");
  await open("https://accounts.google.com/o/oauth2/auth", { onCancel: () => { cancelled += 1; } });
  browser.close();
  assert.equal(cancelled, 1);
  const blocked = createAntigravityAuthBrowser({ BrowserWindow: FakeWindow, sessionFor: () => browserSession, proxyEnvironment: () => ({}) });
  await assert.rejects(blocked("https://accounts.google.com/o/oauth2/auth"), /proxy/i);
  let finishProxy;
  const pendingOpen = createAntigravityAuthBrowser({
    BrowserWindow: FakeWindow, cleanUserAgent: value => value,
    sessionFor: () => ({ ...browserSession, setProxy: () => new Promise(resolve => { finishProxy = resolve; }) }),
    proxyEnvironment: () => ({ HTTPS_PROXY: "http://127.0.0.1:7890" }),
  });
  const before = events.length;
  const pending = pendingOpen("https://accounts.google.com/o/oauth2/auth");
  const rejected = assert.rejects(pending, /cancelled/i);
  await nextTurn();
  pendingOpen.closeAll();
  finishProxy();
  await rejected;
  assert.equal(events.length, before, "disposed setup must not create a late browser");
});

test("the apps host routes Antigravity CLI operations to the main-process service", async () => {
  const seen = [];
  const host = createCodingToolsAppsHost({ services: { antigravityCli: async (operation, args) => { seen.push([operation, args]); return { ok: true, installed: false }; } } });
  const result = await host.call("antigravity-cli", "status", {});
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [["status", {}]]);
  await assert.rejects(host.call("antigravity-cli", "read_keyring", {}), /does not expose read_keyring/);
});

test("managed CLI auth suppresses the external browser without changing other harness environments", () => {
  const proxy = { HTTPS_PROXY: "http://127.0.0.1:7890" };
  const inherited = { PATH: "untouched" };
  assert.deepEqual(manualAuthEnvironment(proxy, inherited), { ...proxy, SSH_CLIENT: "coding-tools" });
  assert.deepEqual(manualAuthEnvironment(proxy, { SSH_CLIENT: "real ssh client" }), { ...proxy, SSH_CLIENT: "real ssh client" });
  assert.deepEqual(proxy, { HTTPS_PROXY: "http://127.0.0.1:7890" });
  assert.deepEqual(inherited, { PATH: "untouched" });
  assert.equal(shimProxyEnvironment(proxy).SSH_CLIENT, undefined, "the AO daemon and other harnesses must not inherit fake SSH");
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  assert.match(main, /executable: antigravityCli\.executable\(\), env: manualAuthEnvironment\(env\)/);
});

test("the agy shim applies only the Coding Tools proxy and refuses to run without it", () => {
  const windows = shimBody("C:/tools/antigravity.exe", "win32");
  assert.match(windows, /if not defined CODING_TOOLS_AGY_HTTPS_PROXY \(\r\n.*exit \/b 1/s);
  assert.match(windows, /if defined CODING_TOOLS_AGY_NO_PROXY set "NO_PROXY=%CODING_TOOLS_AGY_NO_PROXY%"/);
  assert.match(windows, /"C:\/tools\/antigravity\.exe" %\*/);
  assert.match(windows, /^@echo off\r\nsetlocal/);
  assert.match(windows, /if not defined SSH_CLIENT set "SSH_CLIENT=coding-tools"/);
  const posix = shimBody("/opt/agy/antigravity", "linux");
  assert.match(posix, /if \[ -z "\$CODING_TOOLS_AGY_HTTPS_PROXY" \]; then/);
  assert.match(posix, /exec "\/opt\/agy\/antigravity" "\$@"/);
  assert.ok(posix.includes('export SSH_CLIENT="${SSH_CLIENT:-coding-tools}"'));
  assert.deepEqual(shimProxyEnvironment({ HTTPS_PROXY: "http://127.0.0.1:7890", no_proxy: "localhost", PATH: "x" }),
    { CODING_TOOLS_AGY_HTTPS_PROXY: "http://127.0.0.1:7890", CODING_TOOLS_AGY_NO_PROXY: "localhost" });
});
