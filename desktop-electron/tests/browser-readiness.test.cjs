"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");

function fixture(payload, response = {}) {
  const calls = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "automatic",
    state: { authenticated: true, url: "data:text/html,#idle" },
    view: { webContents: {
      isDestroyed: () => false,
      getURL: () => "data:text/html,#idle",
      loadURL: () => { throw new Error("readiness must not navigate"); },
      session: { fetch: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, url, headers: { get: () => "application/json" },
          json: async () => payload, ...response };
      } },
    } },
  });
  return { host, calls };
}
test("browser readiness freshly checks idle session without navigation or cached authentication", async () => {
  const world = fixture({ user: { id: "test-user" }, expires: new Date(Date.now()+60_000).toISOString() });
  assert.equal((await world.host.authenticationReadiness()).authenticated, true);
  assert.equal(world.calls[0].url, "https://chatgpt.com/api/auth/session");
  assert.equal(world.calls[0].options.cache, "no-store");
  assert.equal(world.calls[0].options.redirect, "manual");
  assert.equal((await fixture({}).host.authenticationReadiness()).authenticated, false);
});
test("invalid or expired sessions never become authenticated", async () => {
  for (const payload of [{user:{}},{user:[]},{user:{id:"x"},error:"expired"},
    {user:{id:"x"},expires:"invalid"},{user:{id:"x"},expires:"2000-01-01T00:00:00Z"}]) {
    assert.equal((await fixture(payload).host.authenticationReadiness()).authenticated, false);
  }
});
test("unavailable, redirected or non-JSON readiness stays unknown", async () => {
  for (const response of [{ok:false,status:503},{url:"https://auth.openai.com/login"},
    {headers:{get:()=>"text/html"}}]) {
    const result=await fixture({user:{id:"x"}},response).host.authenticationReadiness();
    assert.equal(result.authenticated,null);
    assert.equal(result.ready,false);
  }
  const world=fixture({user:{id:"x"}});
  world.host.view.webContents.session.fetch=async()=>{throw new Error("Offline")};
  assert.equal((await world.host.authenticationReadiness()).authenticated,null);
});

test("a challenged main-process check falls back to the open ChatGPT page, which returns only the session's shape", async () => {
  const world = fixture({ user: { id: "x" } }, { ok: false, status: 403, headers: { get: () => "text/html" } });
  const contents = world.host.view.webContents;
  let script = "";
  contents.executeJavaScript = async (source) => { script = source; return { status: 200, user: true, error: false, expires: null }; };
  assert.equal((await world.host.authenticationReadiness()).ready, false, "the idle page is not asked");
  assert.equal(script, "");
  contents.getURL = () => "https://chatgpt.com/?temporary-chat=true";
  assert.deepEqual({ ...(await world.host.authenticationReadiness()) }, { authenticated: true, ready: true });
  assert.match(script, /fetch\("\/api\/auth\/session"/);
  assert.doesNotMatch(script, /accessToken|return body\b/, "tokens never leave the page");
  contents.executeJavaScript = async () => ({ status: 403 });
  assert.deepEqual({ ...(await world.host.authenticationReadiness()) }, { authenticated: null, ready: false });
  contents.executeJavaScript = async () => ({ status: 401 });
  assert.equal((await world.host.authenticationReadiness()).authenticated, false);
});
