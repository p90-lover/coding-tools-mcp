"use strict";
// Headless native-session check: no windows, real accounts or installed app are used.
const { app, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { createRegisterCpaSync } = require("../../electron/register-host.cjs");
const root = path.resolve(__dirname, "../../../aiTemp/register-cpa-native");
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, "profile-"));
app.setPath("userData", profile);
app.setPath("temp", root);
app.disableHardwareAcceleration();
let server, sync, stage = "Electron readiness";
const deadline = setTimeout(() => { console.error("Native Register sync deadline exceeded at " + stage); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  let config = {}, reads = 0, writes = 0;
  server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url !== "/api/config") { response.writeHead(404); response.end("{}"); return; }
    if (!(request.headers.cookie || "").includes("_auth=fixture-login")) {
      reads++; response.writeHead(401); response.end("{}"); return;
    }
    if (request.method === "PUT") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { config = { ...config, ...JSON.parse(body).data }; writes++; response.end('{"ok":true}'); });
    } else { reads++; response.end(JSON.stringify(config)); }
  });
  stage = "loopback fixture startup";
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browserSession = session.fromPartition("register-cpa-native-fixture");
  stage = "native network session startup";
  await browserSession.setProxy({ mode: "direct" });
  const errors = [];
  sync = createRegisterCpaSync({ browserSession, origin,
    getConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: "fixture-managed-cpa" }),
    onError: message => errors.push(message),
  });
  stage = "unauthenticated settings request";
  await sync.sync();
  assert.equal(writes, 0, "login protection is not bypassed");
  stage = "HttpOnly login cookie";
  await browserSession.cookies.set({ url: origin + "/api", name: "_auth", value: "fixture-login", path: "/api", httpOnly: true, sameSite: "strict" });
  stage = "authenticated settings handoff";
  await sync.sync();
  assert.deepEqual(config, { cpa_api_url: "http://127.0.0.1:8317", cpa_api_key: "fixture-managed-cpa" });
  assert.equal(writes, 1, "auth cookie and explicit refresh coalesce into one settings write");
  const priorReads = reads;
  await sync.sync(); assert.equal(reads, priorReads, "ready polling does not reread settings");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, nativeSessionCookies: true, loginRespected: true, configWrites: writes, noWindows: true }));
  sync.dispose(); sync = null;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  clearTimeout(deadline); app.exit(0);
}).catch(error => {
  sync?.dispose(); server?.closeAllConnections(); server?.close();
  console.error(error.stack); clearTimeout(deadline); app.exit(1);
});
