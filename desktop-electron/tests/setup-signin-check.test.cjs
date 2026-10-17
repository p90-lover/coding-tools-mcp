const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8").replace(/\r\n/g, "\n");

test("Setup checks the ChatGPT sign-in by itself while it shows Sign in", () => {
  const preload = read("electron/preload.cjs");
  const main = read("electron/main.cjs");
  const app = read("src/App.tsx");
  assert.match(preload, /checkSignIn: \(\) => ipcRenderer\.invoke\("launcher:browser-check-auth"\)/);
  const handler = main.slice(main.indexOf('handle("launcher:browser-check-auth"'), main.indexOf('handle("launcher:browser-passkey-login"'));
  assert.ok(handler.length > 0, "main registers the check");
  // It never runs under a login, smoke test or turn, nor in manual mode or once signed in.
  assert.match(handler, /browserInteractionMode === "manual"/);
  assert.match(handler, /authenticated === true/);
  assert.match(handler, /currentOperation\?\.\(\) \|\| browserHost\.activeTraceId/);
  // The first look asks /api/auth/session without navigating; only a signed-in session is refreshed.
  const readiness = handler.indexOf("authenticationReadiness()");
  const refresh = handler.indexOf("refreshBrowserAuthentication(");
  assert.ok(readiness > 0 && refresh > readiness, "readiness is checked before any refresh");
  assert.match(handler, /readiness\?\.authenticated !== true\) return browserHost\.snapshot\(\)/);
  // The Setup page polls only while not signed in, and tolerates an older preload.
  assert.match(app, /typeof api\?\.checkSignIn === "function"/);
  assert.match(app, /if \(!canCheckSignIn \|\| signedIn\) return;/);
  assert.match(app, /window\.setInterval\(check, 10_000\)/);
});
