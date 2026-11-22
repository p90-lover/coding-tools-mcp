const test = require("node:test");
const assert = require("node:assert/strict");

// Live 2026-11-17: accounts whose Connect MCP stopped at OpenAI Platform's sign-in had nowhere to sign in.
// Their Platform pages now open in the Browser tab, on the account, in a tab of the person's own.

function fakeApi({ refusals = 0, error = null } = {}) {
  const calls = [];
  return {
    calls,
    switchBrowserAccount: async (id) => { calls.push(`switch:${id}`); return { activeId: id }; },
    openBrowserUrl: async (url) => {
      calls.push(`open:${url}`);
      if (error) throw new Error(error);
      if (refusals-- > 0) throw new Error("Error invoking remote method 'launcher:browser-open-url': Error: Open the Browser tab before creating a tab");
      return { url };
    },
  };
}

test("a Platform page opens on its account once the Browser tab shows", async () => {
  const { openPlatformInBrowser, PLATFORM_SIGN_IN_URL } = await import("../src/features/platform-in-browser.ts");
  const api = fakeApi({ refusals: 2 });
  const waits = [];
  const result = await openPlatformInBrowser({ api, accountId: "acct-2", url: PLATFORM_SIGN_IN_URL,
    showBrowser: () => api.calls.push("show"), wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(result, { url: "https://platform.openai.com/login" });
  assert.deepEqual(api.calls, ["switch:acct-2", "show", ...Array(3).fill("open:https://platform.openai.com/login")]);
  assert.deepEqual(waits, [100, 100]);
});

test("showing the Browser tab finishes before the Platform page opens", async () => {
  const { openPlatformInBrowser, PLATFORM_SIGN_IN_URL } = await import("../src/features/platform-in-browser.ts");
  const api = fakeApi();
  let release;
  const shown = new Promise(resolve => { release = resolve; });
  const opening = openPlatformInBrowser({
    api, accountId: "acct-2", url: PLATFORM_SIGN_IN_URL,
    showBrowser: async () => { api.calls.push("show-start"); await shown; api.calls.push("show-done"); },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(api.calls, ["switch:acct-2", "show-start"]);
  release();
  await opening;
  assert.deepEqual(api.calls, ["switch:acct-2", "show-start", "show-done", "open:https://platform.openai.com/login"]);
});

test("only the Browser tab not showing yet is retried, and not forever", async () => {
  const { openPlatformInBrowser, PLATFORM_TUNNELS_URL } = await import("../src/features/platform-in-browser.ts");
  const busy = fakeApi({ error: "Browser tabs cannot open during MCP connector creation" });
  await assert.rejects(openPlatformInBrowser({ api: busy, accountId: "a", url: PLATFORM_TUNNELS_URL, wait: async () => {} }),
    /cannot open during MCP connector creation/);
  assert.equal(busy.calls.filter(call => call.startsWith("open:")).length, 1);
  const hidden = fakeApi({ refusals: 99 });
  await assert.rejects(openPlatformInBrowser({ api: hidden, accountId: "a", url: PLATFORM_TUNNELS_URL, wait: async () => {}, tries: 4 }),
    /Open the Browser tab before creating a tab/);
  assert.equal(hidden.calls.filter(call => call.startsWith("open:")).length, 4);
  const refused = { calls: [], switchBrowserAccount: async () => { throw new Error("Another account switch is in progress"); }, openBrowserUrl: async () => assert.fail("opened") };
  await assert.rejects(openPlatformInBrowser({ api: refused, accountId: "a", url: PLATFORM_TUNNELS_URL }), /Another account switch/);
});

test("Platform's sign-in goes through Chrome where it can, else opens in the Browser tab", async () => {
  const { signInToPlatform } = await import("../src/features/platform-in-browser.ts");
  const windows = { ...fakeApi(), openPlatformSignIn: async (id) => ({ inChrome: true, imported: 2, id }) };
  assert.equal(await signInToPlatform({ api: windows, accountId: "acct-2", showBrowser: () => assert.fail("no Browser tab") }), true);
  assert.deepEqual(windows.calls, [], "Chrome's sign-in neither switches here nor opens a tab");
  const other = { ...fakeApi(), openPlatformSignIn: async () => ({ inChrome: false }) };
  assert.equal(await signInToPlatform({ api: other, accountId: "acct-2", showBrowser: () => other.calls.push("show") }), false);
  assert.deepEqual(other.calls, ["switch:acct-2", "show", "open:https://platform.openai.com/login"]);
});

test("the card's Platform sign-in button follows the setup's own message", async () => {
  const { needsPlatformSignIn } = await import("../src/features/platform-in-browser.ts");
  const { PLATFORM_SIGN_IN_UNFINISHED, CHATGPT_SIGNED_OUT, WORKSPACE_OWNER_REQUIRED } = require("../electron/mcp-connector-setup.cjs");
  assert.equal(needsPlatformSignIn(`${PLATFORM_SIGN_IN_UNFINISHED} It stopped at platform.openai.com/login. · 3 min ago`), true);
  for (const other of [CHATGPT_SIGNED_OUT, WORKSPACE_OWNER_REQUIRED, "MCP ownership metadata is unavailable or exceeded its bound.", "", null, undefined]) {
    assert.equal(needsPlatformSignIn(other), false, String(other));
  }
});
