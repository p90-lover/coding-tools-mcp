"use strict";

// The AO gateway and the SSH terminal capability token (milestone 2 of SSH hosts). AO lets a
// terminal websocket that brought the token attach to an SSH terminal, and its SSH route and an SSH
// terminal's close need it. The AO page reaches AO only through this gateway, so the gateway puts
// the token on the page's terminal websocket (/mux) alone, in place of anything the page sent, and
// takes it off every other request it passes on. Both ends here are loopback servers of this test.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { createAgentOrchestratorGateway } = require("../electron/agent-orchestrator-gateway.cjs");

const TOKEN = "0123456789abcdef".repeat(4);
const PAGE_SENT = "fedcba9876543210".repeat(4);
const fixtureRoot = path.resolve(__dirname, "../../aiTemp/ao-gateway-ssh-tests");
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

/** A stand-in AO daemon: it records what reaches it and accepts a websocket on any /mux path. */
async function fakeDaemon() {
  const seen = [];
  const daemon = http.createServer((request, response) => {
    seen.push({ kind: "http", method: request.method, url: request.url, headers: { ...request.headers } });
    request.resume();
    request.on("end", () => { response.setHeader("content-type", "application/json"); response.end("{}"); });
  });
  // An upgraded socket leaves the server's own connection list, so the test ends each one itself.
  const upgraded = new Set();
  daemon.on("upgrade", (request, socket) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.resume();
    seen.push({ kind: "upgrade", url: request.url, headers: { ...request.headers }, raw: [...request.rawHeaders] });
    if (request.url.startsWith("/mux")) socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n");
    else socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
  });
  await new Promise((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    for (const socket of upgraded) socket.destroy();
    daemon.closeAllConnections();
    await new Promise((resolve) => daemon.close(resolve));
  };
  return { daemon, seen, port: daemon.address().port, close };
}

/** A websocket upgrade from the page, as the browser sends it: the cookie, the page's origin. */
function upgrade(origin, target, headers = {}) {
  const url = new URL(origin);
  return new Promise((resolve) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path: target,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
    request.on("upgrade", (response, socket) => { socket.destroy(); resolve({ upgraded: true, headers: response.headers }); });
    request.on("response", (response) => { response.resume(); resolve({ upgraded: false, status: response.statusCode }); });
    request.on("error", () => resolve({ upgraded: false, refused: true }));
    request.end();
  });
}

async function withGateway(options, work) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "index.html"), "<h1>AO renderer fixture</h1>");
  const ao = await fakeDaemon();
  const gateway = createAgentOrchestratorGateway({
    rendererRoot: fixtureRoot, daemonPort: ao.port, getStatus: () => ({ state: "ready" }), desktopRequest: async () => null, ...options,
  });
  try {
    const { origin, openUrl } = await gateway.listen();
    const bootstrap = await fetch(openUrl, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
    await work({ origin, cookie, seen: ao.seen });
  } finally {
    await gateway.close();
    await ao.close();
  }
}

const tokenHeaders = (headers) => Object.entries(headers).filter(([name]) => /^x[-_]ao[-_]ssh[-_]terminal[-_]token$/i.test(name));

test("the page's /mux upgrade carries the token, in place of one the page sent", { timeout: 10_000 }, async () => {
  await withGateway({ sshTerminalToken: TOKEN }, async ({ origin, cookie, seen }) => {
    for (const [target, sent] of [
      ["/mux", {}],
      ["/mux", { "x-ao-ssh-terminal-token": PAGE_SENT }],
      ["/mux", { "X-AO-SSH-Terminal-Token": PAGE_SENT }],
      ["/mux", { x_ao_ssh_terminal_token: PAGE_SENT }],
      ["/mux?client=1", { "x-ao-ssh-terminal-token": PAGE_SENT }],
    ]) {
      seen.length = 0;
      const answer = await upgrade(origin, target, { cookie, origin, ...sent });
      assert.equal(answer.upgraded, true, `${target} ${JSON.stringify(sent)}`);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, target);
      assert.deepEqual(tokenHeaders(seen[0].headers), [["x-ao-ssh-terminal-token", TOKEN]], "the upstream's token, once, and nothing the page sent");
      const raw = seen[0].raw.filter((_value, index) => index % 2 === 0).filter((name) => /ssh/i.test(name));
      assert.deepEqual(raw, ["x-ao-ssh-terminal-token"], "one header of that name on the wire");
      assert.equal(JSON.stringify(seen[0]).includes(PAGE_SENT), false);
      assert.equal(JSON.stringify(answer.headers).includes(TOKEN), false, "the page is never handed it");
    }
  });
});

test("no other request the gateway passes on carries the token, whatever the page sent", { timeout: 10_000 }, async () => {
  await withGateway({ sshTerminalToken: TOKEN }, async ({ origin, cookie, seen }) => {
    const spellings = [{ "x-ao-ssh-terminal-token": PAGE_SENT }, { "X-Ao-Ssh-Terminal-Token": TOKEN }, { x_ao_ssh_terminal_token: PAGE_SENT }];
    for (const sent of spellings) {
      for (const [method, target, body] of [
        ["GET", "/api/v1/shell-terminals"],
        ["POST", "/api/v1/shell-terminals/ssh", { host: "build.example.com", port: 22, user: "deploy", title: "Build server" }],
        ["PATCH", "/api/v1/shell-terminals/shellterm-ssh-1", { title: "x" }],
        ["DELETE", "/api/v1/shell-terminals/shellterm-ssh-1"],
        ["GET", "/api/v1/projects?mux=1"],
      ]) {
        seen.length = 0;
        const response = await fetch(`${origin}${target}`, {
          method, headers: { cookie, origin, ...(body ? { "content-type": "application/json" } : {}), ...sent }, ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(response.status, 200, `${method} ${target}`);
        assert.equal(seen.length, 1, `${method} ${target}`);
        assert.deepEqual(tokenHeaders(seen[0].headers), [], `${method} ${target} ${JSON.stringify(sent)}`);
        assert.equal(JSON.stringify(seen[0]).includes(TOKEN) || JSON.stringify(seen[0]).includes(PAGE_SENT), false);
      }
    }
    // A plain GET of /mux is a page asset, never passed on.
    seen.length = 0;
    assert.equal((await fetch(`${origin}/mux`, { headers: { cookie } })).status, 200);
    assert.deepEqual(seen, []);
    // The status the page reads does not have it either.
    assert.equal((await (await fetch(`${origin}/integration/status`, { headers: { cookie } })).text()).includes(TOKEN), false);
  });
});

test("an upgrade on any other path never gets the token, and odd spellings of /mux are not passed on", { timeout: 10_000 }, async () => {
  await withGateway({ sshTerminalToken: TOKEN }, async ({ origin, cookie, seen }) => {
    // Paths under /mux were passed on before; they still are, without the token.
    for (const target of ["/mux/", "/mux/x", "/mux/?client=1", "/mux/../api/v1/shell-terminals"]) {
      seen.length = 0;
      await upgrade(origin, target, { cookie, origin, "x-ao-ssh-terminal-token": PAGE_SENT });
      assert.equal(seen.length, 1, target);
      assert.deepEqual(tokenHeaders(seen[0].headers), [], target);
    }
    // Anything else is refused at the gateway, as before: AO never sees it.
    for (const target of ["//mux", "/MUX", "/Mux", "/%6Dux", "/%2Fmux", "/muxx", "/api/v1/shell-terminals", "/mux%3F"]) {
      seen.length = 0;
      const answer = await upgrade(origin, target, { cookie, origin, "x-ao-ssh-terminal-token": PAGE_SENT });
      assert.equal(answer.upgraded, false, target);
      assert.deepEqual(seen, [], target);
    }
    // Without the page's cookie, or from another origin, nothing is passed on at all.
    for (const headers of [{ origin }, { cookie, origin: "https://hostile.example" }, { cookie, origin, "sec-fetch-site": "cross-site" }]) {
      seen.length = 0;
      assert.equal((await upgrade(origin, "/mux", headers)).upgraded, false);
      assert.deepEqual(seen, []);
    }
  });
});

test("without a token (the SSH route off, or one the upstream did not make) /mux gets none and a page-sent one is dropped", { timeout: 10_000 }, async () => {
  for (const sshTerminalToken of [undefined, null, "", "short", TOKEN.toUpperCase(), `${TOKEN}0`, 42]) {
    await withGateway(sshTerminalToken === undefined ? {} : { sshTerminalToken }, async ({ origin, cookie, seen }) => {
      const answer = await upgrade(origin, "/mux", { cookie, origin, "x-ao-ssh-terminal-token": PAGE_SENT });
      assert.equal(answer.upgraded, true);
      assert.deepEqual(tokenHeaders(seen[0].headers), [], String(sshTerminalToken));
    });
  }
});
