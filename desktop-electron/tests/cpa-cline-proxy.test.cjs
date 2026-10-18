"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  http = require("node:http"),
  net = require("node:net"),
  os = require("node:os"),
  path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  createClineProxyRoute,
  runtimeConfiguration,
} = require("../electron/cpa-managed.cjs");

// Authenticated SOCKS5 fixture: resolves the API hostname itself and serves a completion.
// Packet fragments are buffered; no external service, DNS or credentials are required.
async function socksFixture(t) {
  const requests = [],
    sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0),
      stage = "greeting",
      target;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          assert.ok(buffer.subarray(2, 2 + buffer[1]).includes(2));
          buffer = buffer.subarray(2 + buffer[1]);
          socket.write(Buffer.from([5, 2]));
          stage = "auth";
        } else if (stage === "auth") {
          if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
          const ulen = buffer[1],
            plen = buffer[2 + ulen];
          if (buffer.length < 3 + ulen + plen) return;
          const user = buffer.subarray(2, 2 + ulen).toString(),
            pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString();
          buffer = buffer.subarray(3 + ulen + plen);
          if (user !== "fixture-user" || pass !== "p@ss:word") {
            socket.end(Buffer.from([1, 1]));
            return;
          }
          socket.write(Buffer.from([1, 0]));
          stage = "connect";
        } else if (stage === "connect") {
          if (buffer.length < 5) return;
          assert.equal(buffer[3], 3, "SOCKS resolves the upstream hostname");
          const length = buffer[4];
          if (buffer.length < 7 + length) return;
          target =
            buffer.subarray(5, 5 + length).toString() +
            ":" +
            buffer.readUInt16BE(5 + length);
          buffer = buffer.subarray(7 + length);
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          stage = "http";
        } else {
          if (!buffer.includes("\r\n\r\n")) return;
          requests.push({ target, request: buffer.toString() });
          const body = JSON.stringify({
            choices: [{ message: { content: "OK" } }],
          });
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
          return;
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  );
  return {
    url: `socks5://fixture-user:p%40ss%3Aword@127.0.0.1:${server.address().port}`,
    requests,
  };
}
function request(route, authenticated = true) {
  const proxy = new URL(route.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: proxy.hostname,
        port: proxy.port,
        path: "http://cline.fixture/v1/chat/completions",
        headers: authenticated
          ? {
              "Proxy-Authorization":
                "Basic " +
                Buffer.from(`${proxy.username}:${proxy.password}`).toString(
                  "base64",
                ),
            }
          : {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.setTimeout(3000, () =>
      req.destroy(new Error("fixture request timed out")),
    );
    req.on("error", reject);
    req.end();
  });
}

test("Cline gets an authenticated HTTP route through the selected SOCKS5 proxy", async (t) => {
  const upstream = await socksFixture(t),
    route = await createClineProxyRoute(upstream.url);
  t.after(() => route.stop());
  assert.match(route.url, /^http:\/\/ct:[a-f0-9]{64}@127\.0\.0\.1:\d+$/);
  assert.equal((await request(route, false)).status, 407);
  const response = await request(route);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).choices[0].message.content, "OK");
  assert.equal(upstream.requests[0].target, "cline.fixture:80");
  assert.doesNotMatch(
    upstream.requests[0].request,
    /fixture-user|p@ss:word|Proxy-Authorization/i,
  );
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-cline-route-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const config = runtimeConfiguration(
    state,
    "m".repeat(36),
    "k".repeat(36),
    upstream.url,
    route.url,
  );
  assert.ok(
    config.includes(`\nproxy-url: ${JSON.stringify(upstream.url)}\n`),
    "CPA keeps its native SOCKS5 route",
  );
  assert.ok(
    config.includes(`      proxy-url: ${JSON.stringify(route.url)}\n`),
    "only Cline uses the adapter",
  );
  await route.stop();
  await assert.rejects(
    request(route),
    /ECONNREFUSED|ECONNRESET|socket hang up/,
  );
});
test("HTTP(S) and unset Cline routes preserve the selected route", async () => {
  for (const url of [
    "",
    "http://user:pass@proxy.fixture:8080",
    "https://proxy.fixture:443",
  ]) {
    const route = await createClineProxyRoute(url);
    assert.equal(route.url, url);
    await route.stop();
  }
  await assert.rejects(
    createClineProxyRoute("socks4://proxy.fixture:1080"),
    /HTTP, HTTPS or SOCKS5/,
  );
  await assert.rejects(
    createClineProxyRoute("not a URL"),
    /Invalid CPA outbound proxy URL/,
  );
});
test("a rejected SOCKS password fails closed without contacting the API", async (t) => {
  const upstream = await socksFixture(t),
    route = await createClineProxyRoute(
      upstream.url.replace("p%40ss%3Aword", "wrong-password"),
    );
  t.after(() => route.stop());
  const response = await request(route);
  assert.equal(response.status, 502);
  assert.equal(upstream.requests.length, 0);
  assert.doesNotMatch(response.body, /wrong-password|fixture-user/);
});
test("the managed wrapper stops its Cline relay on CPA exit and spawn failure", async (t) => {
  const upstream = await socksFixture(t);
  for (const failsToSpawn of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-cline-lifecycle-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, "home"),
      state = path.join(root, "state"),
      runtime = path.join(home, "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.mkdirSync(state);
    const executable = process.platform === "win32" ? "fixture.exe" : "fixture";
    if (!failsToSpawn)
      fs.copyFileSync(process.execPath, path.join(runtime, executable));
    else
      fs.writeFileSync(
        path.join(runtime, executable),
        process.platform === "win32"
          ? "invalid executable"
          : "#!/nonexistent-cline-fixture-runtime\n",
      );
    fs.chmodSync(path.join(runtime, executable), 0o755);
    fs.writeFileSync(
      path.join(runtime, "CPA_RUNTIME.json"),
      JSON.stringify({ schemaVersion: 1, executable }),
    );
    // Node stands in for CPA and exits on the unsupported --config option.
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "../electron/cpa-managed.cjs"), "run", home, state],
      {
        env: {
          ...process.env,
          CODING_TOOLS_CPA_MANAGEMENT_KEY: "m".repeat(36),
          CODING_TOOLS_CPA_PROXY_API_KEY: "k".repeat(36),
          CODING_TOOLS_CPA_OUTBOUND_PROXY_URL: upstream.url,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => child.kill());
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("CPA wrapper retained a listening relay"));
      }, 5000);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.notEqual(code, 0);
    assert.doesNotMatch(output, /p%40ss|fixture-user/);
    assert.ok(fs.existsSync(path.join(state, "config.yaml")), output);
    const config = fs.readFileSync(path.join(state, "config.yaml"), "utf8"),
      url = JSON.parse(config.match(/^      proxy-url: (.+)$/m)[1]);
    await assert.rejects(
      request({ url }),
      /ECONNREFUSED|ECONNRESET|socket hang up/,
    );
  }
});

test("the managed Cline fetch wrapper completes through its SOCKS5 adapter", async (t) => {
  const runtime = process.env.CLINE_TEST_RUNTIME || process.execPath;
  if (
    !process.env.CLINE_TEST_RUNTIME &&
    Number(process.versions.node.split(".")[0]) < 24
  ) {
    t.skip(
      "Set CLINE_TEST_RUNTIME to Bun or a Node runtime supporting NODE_USE_ENV_PROXY",
    );
    return;
  }
  const upstream = await socksFixture(t),
    route = await createClineProxyRoute(upstream.url);
  t.after(() => route.stop());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cline-fetch-wrapper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = fs.readFileSync(
    path.join(__dirname, "../vendor/cpa-plugins/cline-pass-switcher/plugin.go"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "managed.mjs"),
    plugin.match(/const runtimeWrapper = `([\s\S]*?)`\nconst consoleBridge/)[1],
  );
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(root, "server.js"),
    `try {
    const response = await fetch('http://cline.fixture/v1/chat/completions'); const body = await response.json();
    if (response.status !== 200 || body.choices[0].message.content !== 'OK') process.exit(2);
    console.log('COMPLETION_OK'); process.exit(0);
  } catch { console.error('fetch failed'); process.exit(3); }`,
  );
  const child = spawn(runtime, [path.join(root, "managed.mjs")], {
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: route.url,
      HTTPS_PROXY: route.url,
      ALL_PROXY: route.url,
      http_proxy: route.url,
      https_proxy: route.url,
      all_proxy: route.url,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Cline fetch did not complete"));
    }, 5000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  assert.equal(code, 0, output);
  assert.match(output, /COMPLETION_OK/);
  assert.equal(upstream.requests[0].target, "cline.fixture:80");
});
