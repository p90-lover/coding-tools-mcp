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
