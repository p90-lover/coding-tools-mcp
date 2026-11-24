const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLinkPreviewService, isPrivateHost, parseHead, previewTarget, MAX_IMAGE_BYTES,
} = require("../electron/link-preview.cjs");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** A response whose body arrives in chunks; `pulled()` counts the chunks read. */
function streamed(chunks, init) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(Buffer.from(chunks[index++]));
      else controller.close();
    },
  });
  const response = new Response(body, init);
  response.pulled = () => index;
  return response;
}

function html(head, { type = "text/html; charset=utf-8", status = 200 } = {}) {
  return new Response(`<!doctype html><html><head>${head}</head><body>body</body></html>`, { status, headers: { "content-type": type } });
}

function site(routes) {
  const calls = [];
  const fetchPage = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
    return typeof route === "function" ? route(init) : route.clone();
  };
  return { calls, fetchPage };
}

test("loopback, private-network, link-local and intranet hosts are never previewed", () => {
  for (const address of [
    "http://localhost:8317/", "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0.0.0.0/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fe80::1]/", "http://[fd12::1]/", "http://10.1.2.3/",
    "http://172.16.0.1/", "http://172.31.255.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/", "http://nas/", "http://printer.local/", "http://app.localhost/", "http://db.internal/",
    "http://router.home.arpa/",
  ]) {
    assert.equal(isPrivateHost(new URL(address).hostname), true, address);
    assert.equal(previewTarget(address).reason, "private", address);
  }
  for (const address of ["https://github.com/p90-lover", "http://8.8.8.8/", "http://172.32.0.1/", "https://[2606:4700:4700::1111]/", "https://example.co.uk/"]) {
    assert.equal(isPrivateHost(new URL(address).hostname), false, address);
  }
  assert.equal(previewTarget("file:///C:/x.md").reason, "unsupported");
  assert.equal(previewTarget("mailto:a@example.test").reason, "unsupported");
  assert.equal(previewTarget("https://user:pass@example.test/").reason, "credentials");
  assert.equal(previewTarget("not a url").reason, "invalid");
  assert.equal(previewTarget("https://example.test/a#section").url.href, "https://example.test/a");
});

test("the head's Open Graph tags win, with entities decoded and direction overrides removed", () => {
  const head = parseHead(`
    <meta charset="utf-8"><title>Fallback &amp; title</title>
    <meta name="description" content="Plain description">
    <meta property="og:title" content="fix: brace capture groups &#8212; \u202eevil by p90-lover · Pull Request #1326">
    <meta property='og:description' content='Line one
      line   two &quot;quoted&quot; &hellip;'>
    <meta property="og:site_name" content="GitHub">
    <meta property="og:image" content="/social/1326.png">
    <link rel="apple-touch-icon" href="/apple.png">
    <link rel="icon" sizes="16x16" href="/16.png"><link rel="icon" type="image/svg+xml" href="/icon.svg">
  `, "https://github.com/p90-lover/coding-tools-mcp/pull/1326");
  assert.equal(head.title, "fix: brace capture groups — evil by p90-lover · Pull Request #1326");
  assert.equal(head.description, "Line one line two \"quoted\" …");
  assert.equal(head.siteName, "GitHub");
  assert.equal(head.imageUrl, "https://github.com/social/1326.png");
  assert.equal(head.iconUrl, "https://github.com/icon.svg", "an SVG icon beats a 16 px one and Apple's large icon");

  const bare = parseHead("<title>\n  Only a title\n</title>", "https://example.test/a/b");
  assert.deepEqual(bare, { title: "Only a title", description: "", siteName: "", imageUrl: null, iconUrl: "https://example.test/favicon.ico" });
  const local = parseHead('<meta property="og:image" content="http://127.0.0.1/x.png"><link rel=icon href="http://192.168.1.1/i.png">', "https://example.test/");
  assert.equal(local.imageUrl, null, "a share image on a private host is never fetched");
  assert.equal(local.iconUrl, "https://example.test/favicon.ico");
  assert.equal(parseHead(`<title>${"x".repeat(400)}</title>`, "https://e.test/").title.length, 300);
  assert.equal(parseHead("<head></head><body><title>in body</title></body>", "https://e.test/").title, "", "only the head is read");
});

test("a page's preview carries its text, icon and share image, fetched without cookies or redirects", async () => {
  const { calls, fetchPage } = site({
    "https://example.test/post": html('<meta property="og:title" content="A post"><meta property="og:description" content="About it"><meta property="og:image" content="https://cdn.example.test/share.png"><link rel="icon" href="/favicon.png">'),
    "https://example.test/favicon.png": new Response(PNG, { headers: { "content-type": "image/png" } }),
    "https://cdn.example.test/share.png": new Response(PNG, { headers: { "content-type": "image/png; charset=binary" } }),
  });
  const service = createLinkPreviewService({ fetchPage });
  const result = await service.preview("https://example.test/post#comments");
  assert.deepEqual(result, {
    ok: true, kind: "page", url: "https://example.test/post", host: "example.test",
    title: "A post", description: "About it", siteName: "",
    icon: `data:image/png;base64,${PNG.toString("base64")}`,
    image: `data:image/png;base64,${PNG.toString("base64")}`,
  });
  assert.deepEqual(calls.map((call) => call.url).sort(), ["https://cdn.example.test/share.png", "https://example.test/favicon.png", "https://example.test/post"]);
  for (const call of calls) {
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.method, "GET");
    assert.ok(call.init.signal, "every request can be timed out");
    assert.equal(Object.keys(call.init.headers).some((name) => /cookie|authorization/i.test(name)), false);
  }
});

test("each redirect hop is checked: a hop to a private host is refused before it is asked", async () => {
  const { calls, fetchPage } = site({
    "https://short.test/a": new Response(null, { status: 302, headers: { location: "https://example.test/landing" } }),
    "https://example.test/landing": html("<title>Landing</title>"),
    "https://short.test/local": new Response(null, { status: 301, headers: { location: "http://127.0.0.1:8317/v0/management" } }),
    "https://short.test/loop": new Response(null, { status: 302, headers: { location: "https://short.test/loop" } }),
  });
  const service = createLinkPreviewService({ fetchPage });
  const followed = await service.preview("https://short.test/a");
  assert.equal(followed.title, "Landing");
  assert.equal(followed.url, "https://example.test/landing");
  const refused = await service.preview("https://short.test/local");
  assert.deepEqual(refused, { ok: false, url: "https://short.test/local", host: "short.test", reason: "private" });
  assert.equal(calls.some((call) => call.url.includes("127.0.0.1")), false);
  assert.equal((await service.preview("https://short.test/loop")).reason, "network");
  assert.equal(calls.filter((call) => call.url === "https://short.test/loop").length, 6, "at most five redirects");
  const before = calls.length;
  assert.equal((await service.preview("http://localhost:3000/")).reason, "private");
  assert.equal(calls.length, before, "a private link is refused without a request");
});

test("errors, files and oversized or mislabelled images", async () => {
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  const { fetchPage } = site({
    "https://example.test/gone": html("<title>Not Found</title>", { status: 404 }),
    "https://example.test/paper.pdf": new Response("%PDF", { headers: { "content-type": "application/pdf", "content-length": "1258291" } }),
    "https://example.test/page": html('<meta property="og:image" content="https://example.test/big.png"><link rel=icon href="/i.png">'),
    "https://example.test/big.png": new Response(big, { headers: { "content-type": "image/png" } }),
    "https://example.test/i.png": new Response("<html>not an image</html>", { headers: { "content-type": "text/html" } }),
  });
  const service = createLinkPreviewService({ fetchPage });
  assert.deepEqual(await service.preview("https://example.test/gone"), { ok: false, url: "https://example.test/gone", host: "example.test", reason: "http-404" });
  assert.deepEqual(await service.preview("https://example.test/paper.pdf"), { ok: true, kind: "file", url: "https://example.test/paper.pdf", host: "example.test", contentType: "application/pdf", size: 1258291 });
  const page = await service.preview("https://example.test/page");
  assert.equal(page.image, null, "an image past the limit is dropped, not cut");
  assert.equal(page.icon, null, "an icon that is not an image is dropped");
  const failing = createLinkPreviewService({ fetchPage: async () => { throw new Error("ECONNRESET"); } });
  assert.deepEqual(await failing.preview("https://example.test/x"), { ok: false, url: "https://example.test/x", host: "example.test", reason: "network" });
});

test("only the head is read, in the page's own charset", async () => {
  const page = streamed(["<html><head><title>Caf", Buffer.from([0xe9]), "</title></head><body>", ..."x".repeat(50).split("")], {
    headers: { "content-type": "text/html; charset=windows-1252" },
  });
  const service = createLinkPreviewService({ fetchPage: async () => page });
  const result = await service.preview("https://example.test/");
  assert.equal(result.title, "Café");
  assert.ok(page.pulled() <= 4, `stopped after the head (read ${page.pulled()} chunks)`);
});

test("a fetch that never hears its signal (the network still starting) still times out, and a late answer is let go", async () => {
  let late;
  const service = createLinkPreviewService({
    fetchPage: () => new Promise((resolve) => { late = resolve; }),
    pageTimeoutMs: 20,
  });
  const started = Date.now();
  assert.equal((await service.preview("https://starting.test/")).reason, "timeout");
  assert.ok(Date.now() - started < 5_000);
  let cancelled = false;
  late({ status: 200, headers: new Headers(), body: { cancel: async () => { cancelled = true; } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true, "the late response's body is cancelled");
});

test("a stalled page times out; answers are cached and failures asked again later", async () => {
  let clock = 0;
  let stalls = true;
  let asked = 0;
  const fetchPage = (url, init) => {
    if (url !== "https://slow.test/") return Promise.resolve(new Response("", { status: 404 }));
    asked += 1;
    if (stalls) return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    return Promise.resolve(html("<title>Back</title>"));
  };
  const service = createLinkPreviewService({ fetchPage, now: () => clock, pageTimeoutMs: 20 });
  assert.equal((await service.preview("https://slow.test/")).reason, "timeout");
  stalls = false;
  assert.equal((await service.preview("https://slow.test/")).reason, "timeout", "a failure is kept for a while");
  assert.equal(asked, 1);
  clock += 2 * 60_000 + 1;
  assert.equal((await service.preview("https://slow.test/")).title, "Back");
  clock += 29 * 60_000;
  const [a, b] = await Promise.all([service.preview("https://slow.test/"), service.preview("https://slow.test/")]);
  assert.equal(a, b);
  assert.equal(asked, 2, "a page's answer is reused for half an hour, and hovers in flight share one request");
});

test("addresses that are local in other spellings are never previewed", () => {
  // Bug hunt 2026-11-24 C5: [::7f00:1] (IPv4-compatible ::127.0.0.1) read as public, and so did
  // public names that spell out a local address for wildcard DNS (127.0.0.1.nip.io).
  for (const address of [
    "http://[::127.0.0.1]/", "http://[::7f00:1]/", "http://[::ffff:0:7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::a00:1]/",
    "http://[2002:7f00:1::]/", "http://[2002:c0a8:101::1]/", "http://[0:0:0:0:0:0:0:1]/",
    "http://127.0.0.1.nip.io:8080/admin", "http://app.10.0.0.5.sslip.io/", "http://192-168-1-1.sslip.io/", "http://localtest.me/",
    "http://api.lvh.me/", "http://localhost.example.com/",
  ]) {
    assert.equal(isPrivateHost(new URL(address).hostname), true, address);
  }
  for (const address of ["https://[2001:4860:4860::8888]/", "http://8.8.8.8.nip.io/", "https://v1.2.3.example.com/", "https://[2002:808:808::1]/"]) {
    assert.equal(isPrivateHost(new URL(address).hostname), false, address);
  }
});
