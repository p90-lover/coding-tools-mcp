"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

if (process.versions.electron) {
  const fs = require("node:fs");
  const http = require("node:http");
  const { app, net, session } = require("electron");
  const { fetchNativeWithProxyAuth } = require("../electron/control-server.cjs");
  const profilePath = path.join(__dirname, "../../aiTemp/native-proxy-auth-profile");
  fs.mkdirSync(profilePath, { recursive: true });
  app.setPath("userData", profilePath);

  const expected = `Basic ${Buffer.from("probe-user:probe-pass").toString("base64")}`;
  const seen = [];
  const proxy = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const authorized = request.headers["proxy-authorization"] === expected;
    seen.push({ authorized, cookie: Boolean(request.headers.cookie),
      method: request.method, body: Buffer.concat(chunks).toString("utf8") });
    if (!authorized) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="local-test"' });
      response.end("authentication required");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: PROXY_OK\n\n");
    setTimeout(() => response.end("data: [DONE]\n\n"), 5);
  });

  (async () => {
    await app.whenReady();
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const rule = `http://127.0.0.1:${proxy.address().port}`;
    const baselineSession = session.fromPartition("native-proxy-auth-baseline");
    await baselineSession.setProxy({ mode: "fixed_servers", proxyRules: rule });
    const url = "http://native-proxy-auth-fixture.invalid/stream";
    const baseline = await baselineSession.fetch(url, { credentials: "omit" });
    await baseline.body?.cancel();

    const relaySession = session.fromPartition("native-proxy-auth-relay");
    await relaySession.setProxy({ mode: "fixed_servers", proxyRules: rule });
    await relaySession.cookies.set({ url, name: "should-not-leak", value: "cookie" });
    let loginEvents = 0;
    const getProxyCredentials = (authInfo) => {
      if (!authInfo.isProxy || authInfo.host !== "127.0.0.1"
        || authInfo.port !== proxy.address().port) return null;
      loginEvents += 1;
      return { username: "probe-user", password: "probe-pass" };
    };
    const fetchNative = fetchNativeWithProxyAuth ?? (({ browserSession, url: target, options }) => (
      browserSession.fetch(target, options)
    ));
    const relay = await fetchNative({
      electronNet: net, browserSession: relaySession, url,
      options: { method: "GET", headers: new Headers(), signal: AbortSignal.timeout(8_000), redirect: "manual" },
      getProxyCredentials,
    });
    const body = await relay.text();
    const postSession = session.fromPartition("native-proxy-auth-post");
    await postSession.setProxy({ mode: "fixed_servers", proxyRules: rule });
    await postSession.cookies.set({ url, name: "should-not-leak", value: "cookie" });
    const post = await fetchNative({
      electronNet: net, browserSession: postSession, url,
      options: { method: "POST", headers: new Headers({ "content-type": "text/plain" }),
        body: Buffer.from("native-post"), signal: AbortSignal.timeout(8_000), redirect: "manual" },
      getProxyCredentials,
    });
    const postBody = await post.text();
    console.log(JSON.stringify({ baselineStatus: baseline.status, relayStatus: relay.status,
      bodyMatched: body === "data: PROXY_OK\n\ndata: [DONE]\n\n",
      postStatus: post.status, postBodyMatched: postBody === "data: PROXY_OK\n\ndata: [DONE]\n\n",
      postRequestBodyMatched: seen.some((entry) => entry.authorized && entry.method === "POST" && entry.body === "native-post"),
      loginEvents,
      authorizedRequests: seen.filter((entry) => entry.authorized).length,
      cookieSent: seen.some((entry) => entry.cookie) }));
    proxy.close();
    app.quit();
  })().catch((error) => {
    console.log(JSON.stringify({ error: error.name }));
    proxy.close();
    app.exit(1);
  });
} else {
  const { spawn } = require("node:child_process");
  const test = require("node:test");

  test("native Codex relay authenticates the selected proxy without sending session cookies", async () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename,
      `--user-data-dir=${path.join(__dirname, "../../aiTemp/native-proxy-auth-profile")}`], {
      cwd: path.join(__dirname, ".."), env, windowsHide: true,
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    const exitCode = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, 0, errors.slice(0, 300));
    const result = JSON.parse(output.trim().split(/\r?\n/).findLast((line) => line.startsWith("{")));
    assert.deepEqual(result, { baselineStatus: 407, relayStatus: 200,
      bodyMatched: true, postStatus: 200, postBodyMatched: true, postRequestBodyMatched: true,
      loginEvents: 2, authorizedRequests: 2, cookieSent: false });
  });
}
