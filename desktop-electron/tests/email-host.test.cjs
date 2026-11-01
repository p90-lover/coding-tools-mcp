"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

const {
  createEmailHost,
  normalizeOrigin,
  normalizeMessageListRow,
  positiveId,
  pageSize,
} = require("../electron/email-host.cjs");
const { parseMessage, bodyPreview, sanitizeHtml, stripDangerous } = require("../electron/email-mime.cjs");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "email-host-"));
}

// A safeStorage stub with encryption unavailable, forcing the AES fallback path.
const noStorage = { isEncryptionAvailable: () => false };

function credentialOptions() {
  const dir = tmp();
  return { logger: null, filePath: path.join(dir, "e.json"), keyPath: path.join(dir, "e.key"), safeStorage: noStorage,
    fetchNative: async url => new Response(JSON.stringify(url.endsWith("/open_api/settings") ? { domains: ["example.test"] } : {}), { status: 200 }),
    parseMessage, sanitizeHtml };
}

test("unreadable Email keys and connection files stay intact and recover on a fresh open", async t => {
  for (const kind of ["key", "connection"]) await t.test(kind, async () => {
    const options = credentialOptions(), original = { origin: "https://mail.example.test", adminAuth: "fixture-original" };
    await createEmailHost(options).connect(original);
    const files = [options.filePath, `${options.filePath}.bak`, options.keyPath, `${options.keyPath}.bak`];
    const before = files.map(file => fs.readFileSync(file));
    const failed = new Set(kind === "key" ? files.slice(2) : files.slice(0, 2)), readFile = fs.readFileSync;
    let unavailable, reads = 0;
    fs.readFileSync = function (file, ...args) {
      if (failed.has(String(file))) { reads += 1; throw Object.assign(new Error("fixture read unavailable"), { code: "EIO" }); }
      return readFile.call(this, file, ...args);
    };
    try {
      unavailable = createEmailHost(options);
      assert.equal(unavailable.status().configured, false);
      assert.equal((await unavailable.currentStatus()).configured, false, "status remains usable without a credential");
      if (kind === "key") await assert.rejects(() => unavailable.connect({ origin: "https://replacement.example.test", adminAuth: "fixture-replacement" }), error => {
        assert.match(error.message, /key|credential/i); assert.ok(error.message.length <= 300); return true;
      });
    } finally { fs.readFileSync = readFile; }
    assert.ok(reads >= 2, "the primary file and its backup were both unavailable");
    files.forEach((file, index) => assert.ok(fs.readFileSync(file).equals(before[index]), `${path.basename(file)} stays unchanged`));
    assert.equal(fs.readdirSync(path.dirname(options.filePath)).some(file => file.includes(".corrupt-")), false);
    let authenticated = false;
    const reopened = createEmailHost({ ...options, fetchNative: (url, request) => {
      authenticated = request.headers["x-admin-auth"] === original.adminAuth;
      return options.fetchNative(url, request);
    } });
    assert.equal(reopened.status().configured, true);
    assert.equal(reopened.status().origin, original.origin);
    await reopened.listMessages({});
    assert.ok(authenticated, "the recovered connection uses the original credential");
    files.forEach((file, index) => assert.ok(fs.readFileSync(file).equals(before[index]), "reopening does not rotate the saved key or credential"));
  });
});

test("decrypting Email with missing or torn key copies never generates a replacement key", async t => {
  for (const damage of ["missing", "torn"]) await t.test(damage, async () => {
    const options = credentialOptions();
    await createEmailHost(options).connect({ origin: "https://mail.example.test", adminAuth: "fixture" });
    const credential = fs.readFileSync(options.filePath), backup = fs.readFileSync(`${options.filePath}.bak`), key = fs.readFileSync(options.keyPath);
    for (const file of [options.keyPath, `${options.keyPath}.bak`]) {
      if (damage === "missing") fs.rmSync(file);
      else fs.writeFileSync(file, "torn");
    }
    assert.equal(createEmailHost(options).status().configured, false);
    assert.ok(fs.readFileSync(options.filePath).equals(credential));
    assert.ok(fs.readFileSync(`${options.filePath}.bak`).equals(backup));
    for (const file of [options.keyPath, `${options.keyPath}.bak`]) {
      if (damage === "missing") assert.equal(fs.existsSync(file), false, "a read cannot create a key");
      else assert.ok(fs.readFileSync(file).equals(Buffer.from("torn")), "damaged bytes stay available for recovery");
      fs.writeFileSync(file, key);
    }
    assert.equal(createEmailHost(options).status().configured, true);
  });
});

test("a failed first Email key save is retried before any credential uses that key", async () => {
  const options = credentialOptions(), host = createEmailHost(options), rename = fs.renameSync;
  let injected = false;
  fs.renameSync = function (source, destination) {
    if (String(destination) === options.keyPath) { injected = true; throw Object.assign(new Error("fixture key persistence failed"), { code: "EIO" }); }
    return rename.call(this, source, destination);
  };
  try { await assert.rejects(() => host.connect({ origin: "https://mail.example.test", adminAuth: "fixture" }), /persistence failed/); }
  finally { fs.renameSync = rename; }
  assert.ok(injected);
  assert.equal(host.status().configured, false); assert.equal(fs.existsSync(options.filePath), false); assert.equal(fs.existsSync(options.keyPath), false);
  await host.connect({ origin: "https://mail.example.test", adminAuth: "fixture" });
  assert.equal(fs.existsSync(options.keyPath), true);
  assert.equal(createEmailHost(options).status().configured, true, "the credential uses a durably saved first-start key");
});

test("a complete Email replacement and explicit disconnect do not require the old plaintext", async () => {
  const options = credentialOptions();
  await createEmailHost(options).connect({ origin: "https://old.example.test", adminAuth: "fixture-old" });
  const key = fs.readFileSync(options.keyPath), stored = JSON.parse(fs.readFileSync(options.filePath, "utf8"));
  stored.credential.data = Buffer.from("unreadable fixture ciphertext").toString("base64");
  for (const file of [options.filePath, `${options.filePath}.bak`]) fs.writeFileSync(file, JSON.stringify(stored));
  const host = createEmailHost(options);
  assert.equal(host.status().configured, false);
  await host.connect({ origin: "https://replacement.example.test", adminAuth: "fixture-new" });
  assert.equal(createEmailHost(options).status().origin, "https://replacement.example.test");
  assert.ok(fs.readFileSync(options.keyPath).equals(key), "complete replacement can reuse the existing valid key");
  assert.equal(host.disconnect().configured, false);
  assert.equal(fs.existsSync(options.filePath), false); assert.equal(fs.existsSync(`${options.filePath}.bak`), false);
  assert.equal(createEmailHost(options).status().configured, false);
});

test("normalizeOrigin rejects non-https, paths, and query strings", () => {
  assert.equal(normalizeOrigin("https://mail.example.com"), "https://mail.example.com");
  assert.throws(() => normalizeOrigin("http://mail.example.com"), /https/);
  assert.throws(() => normalizeOrigin("https://mail.example.com/admin"), /path/);
  assert.throws(() => normalizeOrigin("https://mail.example.com/?x=1"), /path|query/);
  assert.throws(() => normalizeOrigin("not a url"), /valid/);
});

test("positiveId and pageSize enforce bounds", () => {
  assert.equal(positiveId(42), 42);
  assert.throws(() => positiveId(0));
  assert.throws(() => positiveId(-1));
  assert.throws(() => positiveId(1.5));
  assert.equal(pageSize(50), 50); // the maximum is accepted
  assert.equal(pageSize(9999), 20); // out of range -> safe default, not a silent clamp
  assert.equal(pageSize(0), 20);
  assert.equal(pageSize(15), 15);
});

test("normalizeMessageListRow drops raw MIME and bounds the preview", () => {
  const row = normalizeMessageListRow({
    id: 7, address: "a@b.com", source: "s@x.com", subject: "Hi",
    message: `Subject: Hi\r\nContent-Type: text/plain\r\n\r\n${"x".repeat(1000)}`, password: "secret", jwt: "token",
  });
  assert.equal(row.id, 7);
  assert.equal(row.preview.length, 240);
  assert.match(row.preview, /^x+$/, "the preview is the body, never the raw headers");
  assert.equal(Object.prototype.hasOwnProperty.call(row, "password"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "jwt"), false);
});

test("stripDangerous removes scripts, handlers, and javascript: urls", () => {
  const dirty = `<p onclick="steal()">hi</p><script>evil()</script><a href="javascript:evil()">x</a>`;
  const clean = stripDangerous(dirty);
  assert.equal(/<script/i.test(clean), false);
  assert.equal(/onclick/i.test(clean), false);
  assert.equal(/javascript:/i.test(clean), false);
});

test("parseMessage decodes a multipart/alternative body", async () => {
  const raw = [
    "From: a@b.com", "To: c@d.com", "Subject: Test",
    'Content-Type: multipart/alternative; boundary="B"', "", "--B",
    "Content-Type: text/plain", "", "hello plain", "--B",
    "Content-Type: text/html", "", "<b>hello html</b>", "--B--",
  ].join("\r\n");
  const parsed = await parseMessage(raw);
  assert.equal(parsed.subject, "Test");
  assert.equal(parsed.text.trim(), "hello plain");
  assert.match(parsed.html, /hello html/);
});

function mimeHost(raw) {
  const vm = require("node:vm"), ts = require("typescript"), source = fs.readFileSync(path.join(__dirname, "../electron/email-host.cjs"), "utf8");
  const tree = ts.createSourceFile("email-host.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), methods = [];
  const visit = node => { if (ts.isMethodDeclaration(node) && ["listMessages", "getMessage"].includes(node.name.getText(tree))) methods.push(node); ts.forEachChild(node, visit); };
  visit(tree); assert.equal(methods.length, 2);
  const loaded = { exports: {} }, mime = require("../electron/email-mime.cjs"), row = { id: 1, raw };
  // Execute the actual normalized list/detail methods without constructing a credential-bearing host.
  vm.runInNewContext(source + "\nlet lastRefresh = null;\n" + methods.map(node => `module.exports.${node.name.getText(tree)} = async (input) => ${node.body.getText(tree)};`).join("\n"), {
    module: loaded, exports: loaded.exports, Buffer, URL, URLSearchParams, parseMessage, sanitizeHtml,
    call: async url => url.startsWith("/admin/mails?") ? { results: [row], count: 1 } : row,
    require: name => name === "./email-mime.cjs" ? mime : {},
  });
  return loaded.exports;
}

test("mail list and reader separate explicit text attachments from the body", async t => {
  const alternative = (boundary, plain, html) => [
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8", "", plain, `--${boundary}`,
    "Content-Type: text/html; charset=utf-8", "", html, `--${boundary}--`,
  ].join("\r\n");
  const body = alternative("body", "REAL BODY TEXT", "<p>REAL BODY HTML</p>");
  const attachment = (type, disposition = "attachment") => [
    `Content-Type: text/${type}; charset=utf-8`, `Content-Disposition: ${disposition}; filename="notes.${type === "plain" ? "txt" : "html"}"`,
    "Content-Transfer-Encoding: base64", "", Buffer.from(type === "plain" ? "ATTACHED TEXT" : "<p>ATTACHED HTML</p><script>blocked()</script>").toString("base64"),
  ].join("\r\n");
  const cases = [
    ...["plain", "html"].flatMap(type => [true, false].map(first => ({ name: type + (first ? " first" : " after body"),
      parts: first ? [attachment(type), body] : [body, attachment(type)], filename: `notes.${type === "plain" ? "txt" : "html"}` }))),
    { name: "case-insensitive attachment token", parts: [attachment("plain", "AtTaChMeNt"), body], filename: "notes.txt" },
    { name: "attached multipart", parts: [alternative("attached", "ATTACHED TEXT", "<p>ATTACHED HTML</p>")
      .replace("\r\n\r\n", '\r\nContent-Disposition: attachment; filename="bundle.mime"\r\n\r\n'), body], filename: "bundle.mime" },
    { name: "inline filename containing attachment stays body", parts: ['Content-Type: text/plain\r\nContent-Disposition: inline; filename="attachment.txt"\r\n\r\nREAL BODY TEXT', body], filename: null },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const raw = ["MIME-Version: 1.0", "From: sender@example.test", "Subject: MIME test", 'Content-Type: multipart/mixed; boundary="mixed"', "",
      "--mixed", item.parts.join("\r\n--mixed\r\n"), "--mixed--"].join("\r\n");
    const host = mimeHost(raw), list = await host.listMessages({}), { message } = await host.getMessage({ id: 1 });
    assert.equal(list.messages[0].preview, "REAL BODY TEXT"); assert.equal(message.text.trim(), "REAL BODY TEXT");
    assert.match(message.html, /REAL BODY HTML/); assert.equal(message.html.includes("ATTACHED"), false);
    assert.equal(message.attachments.length, item.filename ? 1 : 0);
    if (item.filename) { assert.equal(message.attachments[0].filename, item.filename); assert.ok(message.attachments[0].size > 0); }
  });
});

test("parseMessage decodes transfer encodings as bytes in the part's charset", async () => {
  const raw = [
    "From: =?UTF-8?Q?Caf=C3=A9_Bot?= <bot@x.com>",
    "Subject: =?UTF-8?B?5L2g5aW9?= =?UTF-8?Q?_w=C3=B6rld?=",
    'Content-Type: multipart/alternative; boundary="B"', "", "--B",
    "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
    "<p>OpenAI =C2=A9 2015=E2=80=932026 soft=", "wrap</p>", "--B",
    "Content-Type: text/plain; charset=big5", "Content-Transfer-Encoding: base64", "",
    Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]).toString("base64"), "--B--",
  ].join("\r\n");
  const parsed = await parseMessage(raw);
  assert.equal(parsed.subject, "你好 wörld");
  assert.equal(parsed.from, "Café Bot <bot@x.com>");
  assert.match(parsed.html, /OpenAI © 2015–2026 softwrap/);
  assert.equal(parsed.html.includes("Â"), false);
  assert.equal(parsed.text.trim(), "中文");
});

test("list rows take subject and sender from the message headers, not the bounce envelope", () => {
  const row = normalizeMessageListRow({
    id: 9, address: "me@x.com", source: "bounces+123-me=x.com@em7877.tm.example",
    raw: "From: ChatGPT <noreply@codex.chatgpt.com>\r\nSubject: =?UTF-8?Q?You=E2=80=99re_invited?=\r\n\r\nbody",
  });
  assert.equal(row.subject, "You’re invited");
  assert.equal(row.from, "ChatGPT <noreply@codex.chatgpt.com>");
  const bare = normalizeMessageListRow({ id: 10, source: "s@x.com", subject: "Hi" });
  assert.equal(bare.from, "s@x.com");
  assert.equal(bare.subject, "Hi");
});

test("a subject a sender broke over lines reads as one line", () => {
  const row = normalizeMessageListRow({
    id: 11, raw: "Subject: =?UTF-8?Q?OpenAI_-_Access_Deactivated=0A=0A[C-QN5]?=\r\n\r\nbody",
  });
  assert.equal(row.subject, "OpenAI - Access Deactivated [C-QN5]");
});

test("an HTML-only message previews its text, without markup or styles", () => {
  const raw = [
    "Subject: Code", 'Content-Type: multipart/alternative; boundary="b"', "", "--b",
    "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
    "<html><head><style>p{color:red}</style></head><body><p>Your code is <b>482913</b>&nbsp;=E2=80=94 thanks</p></body></html>",
    "--b--", "",
  ].join("\r\n");
  assert.equal(normalizeMessageListRow({ id: 12, raw }).preview, "Your code is 482913 — thanks");
});

test("after an app restart the Worker's domains are read again, so an address can be created", async () => {
  const dir = tmp();
  const calls = [];
  const fetchNative = async (url, options) => {
    calls.push([options.method, new URL(url).pathname]);
    if (url.endsWith("/admin/statistics")) return new Response("{}", { status: 200 });
    if (url.endsWith("/open_api/settings")) return new Response(JSON.stringify({ version: "v1", domains: ["example.com"] }), { status: 200 });
    if (url.endsWith("/admin/new_address")) return new Response(JSON.stringify({ address: "otp@example.com" }), { status: 200 });
    return new Response("null", { status: 200 });
  };
  const options = { logger: null, filePath: path.join(dir, "e.json"), keyPath: path.join(dir, "e.key"), safeStorage: noStorage, fetchNative, parseMessage, sanitizeHtml };
  await createEmailHost(options).connect({ origin: "https://mail.example.com", adminAuth: "k" });

  const restarted = createEmailHost(options);
  assert.equal(restarted.status().capabilities, null, "a new host knows only the saved credential");
  assert.deepEqual((await restarted.currentStatus()).capabilities.domains, ["example.com"]);
  const fresh = createEmailHost(options);
  assert.deepEqual(await fresh.createAddress({ name: "otp", domain: "example.com" }), { address: "otp@example.com" },
    "creating works even before the page asked for the status");
});

test("connect verifies read-only before persisting and never returns the credential", async () => {
  const dir = tmp();
  const requests = [];
  const fetchNative = async (url, options) => {
    requests.push({ url, headers: options.headers });
    if (url.endsWith("/admin/statistics")) return new Response("{}", { status: 200 });
    if (url.endsWith("/open_api/settings")) {
      return new Response(JSON.stringify({ version: "1.0", domains: ["example.com"] }), { status: 200 });
    }
    return new Response("null", { status: 200 });
  };
  const host = createEmailHost({
    logger: null,
    filePath: path.join(dir, "e.json"),
    keyPath: path.join(dir, "e.key"),
    safeStorage: noStorage,
    fetchNative,
    parseMessage,
    sanitizeHtml,
  });
  const status = await host.connect({ origin: "https://mail.example.com", adminAuth: "top-secret" });
  assert.equal(status.configured, true);
  assert.equal(status.origin, "https://mail.example.com");
  // The status the renderer sees carries no credential field.
  assert.equal(JSON.stringify(status).includes("top-secret"), false);
  // /admin/statistics was called (read-only verification) and carried the admin header.
  const stat = requests.find((r) => r.url.endsWith("/admin/statistics"));
  assert.equal(stat.headers["x-admin-auth"], "top-secret");
  // The persisted file is encrypted, not plaintext.
  const onDisk = fs.readFileSync(path.join(dir, "e.json"), "utf8");
  assert.equal(onDisk.includes("top-secret"), false);
});

test("connect rolls back and does not persist when verification fails", async () => {
  const dir = tmp();
  const host = createEmailHost({
    logger: null,
    filePath: path.join(dir, "e.json"),
    keyPath: path.join(dir, "e.key"),
    safeStorage: noStorage,
    fetchNative: async () => new Response("nope", { status: 403 }),
    parseMessage,
    sanitizeHtml,
  });
  await assert.rejects(() => host.connect({ origin: "https://mail.example.com", adminAuth: "x" }), /rejected/);
  assert.equal(host.status().configured, false);
  assert.equal(fs.existsSync(path.join(dir, "e.json")), false);
});

test("a 3xx redirect from the mail API is treated as an error, not followed", async () => {
  const dir = tmp();
  const host = createEmailHost({
    logger: null,
    filePath: path.join(dir, "e.json"),
    keyPath: path.join(dir, "e.key"),
    safeStorage: noStorage,
    fetchNative: async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    parseMessage,
    sanitizeHtml,
  });
  await assert.rejects(() => host.connect({ origin: "https://mail.example.com", adminAuth: "x" }), /redirect/);
});

test("sanitizeHtml keeps email formatting and drops forms, svg and unknown attributes", () => {
  const html = sanitizeHtml('<table border="1" class="x"><tr><td style="color:red" id="c">Hi <b>there</b></td></tr></table>'
    + '<form action="https://evil.example"><input name="pw"></form><svg><circle r="1"/></svg>'
    + '<a href="https://example.com" onclick="steal()">link</a><img src="data:image/png;base64,AA" alt="logo">');
  assert.ok(html.includes('<table border="1"><tr><td style="color:red">Hi <b>there</b></td></tr></table>'), html);
  assert.ok(html.includes('<a href="https://example.com">link</a>'), html);
  assert.ok(html.includes('<img src="data:image/png;base64,AA" alt="logo">'), html);
  assert.doesNotMatch(html, /<form|<input|<svg|<circle|class=|id=|onclick/);
});

test("malformed HTML stays bounded in the actual inbox normalizer and sanitizer", async t => {
  for (const [name, preview, html, expected] of [
    ["preview block openers", true, "<style>".repeat(32_000), null],
    ["sanitizer block openers", false, "<style>".repeat(32_000), ""],
    ["unclosed comments", false, "<!--".repeat(65_536), ""],
    ["preview less-than signs", true, "<".repeat(65_536), "<".repeat(240)],
    ["unclosed allowed tags", false, "<a".repeat(16_384), ""],
    ["unassigned attribute", false, `<p ${"x".repeat(65_536)}>Visible</p>`, "<p>Visible</p>"],
  ]) await t.test(name, () => {
    const raw = preview ? `Content-Type: text/html\r\n\r\n${html}` : html;
    const value = vm.runInNewContext(preview ? "normalizeMessageListRow({ id: 1, raw }).preview" : "sanitizeHtml(raw)",
      { normalizeMessageListRow, sanitizeHtml, raw }, { timeout: 1_000 });
    assert.equal(value, expected);
  });
});

test("metadata void tags keep the following body, including a head without an explicit close", () => {
  const metadata = '<meta charset="utf-8"><link rel="stylesheet" href="https://example.test/style"><base href="https://example.test/"><embed src="https://example.test/x">';
  assert.equal(sanitizeHtml(`${metadata}<p>Body</p>`), "<p>Body</p>");
  assert.equal(bodyPreview(`Content-Type: text/html\r\n\r\n<head>${metadata}<body><p>Body</p>`), "Body");
});

test("quoted greater-than signs and multiline attributes retain formatting and stay out of previews", () => {
  const html = `<table border=1><tr><td title="left > right" style='color:red;\nwhite-space:pre-wrap' colspan="2">First<br />Second</td></tr></table>`;
  const cleaned = sanitizeHtml(html);
  assert.ok(cleaned.includes('<table border=1>'));
  assert.ok(cleaned.includes('title="left > right"'));
  assert.ok(cleaned.includes("style='color:red;\nwhite-space:pre-wrap'"));
  assert.ok(cleaned.includes('colspan="2"'));
  assert.equal(bodyPreview(`Content-Type: text/html\r\n\r\n${html}`), "First Second");
});

test("raw script and style bodies end at their first closing tag regardless of quotes inside", () => {
  const html = `<script>const x = "<a title='unfinished";</ScRiPt><p>After script</p><style>.x{content:"<a title='unfinished"}</STYLE><p>After style</p>`;
  assert.equal(sanitizeHtml(html), "<p>After script</p><p>After style</p>");
  assert.equal(bodyPreview(`Content-Type: text/html\r\n\r\n${html}`), "After script After style");
});

test("nested blocked containers retain first-close behavior and unmatched openers keep following content", () => {
  assert.equal(sanitizeHtml('<object>outer<object>inner</object><p>After first</p></object><p>After all</p>'), '<p>After first</p><p>After all</p>');
  assert.equal(sanitizeHtml('<script>unclosed<p>Following content</p>'), 'unclosed<p>Following content</p>');
  assert.equal(sanitizeHtml('<p>Before</p><!-- unclosed <p>Hidden comment</p>'), '<p>Before</p>');
  assert.equal(sanitizeHtml('<p>Before</p><a title="unclosed'), '<p>Before</p>');
});

test("the HTML safety floor still removes handlers and unsafe URLs while keeping data images", () => {
  const html = sanitizeHtml('<p ONCLICK="go()">Hello</p><a href=" javascript:go()">Bad link</a>'
    + '<img src="data:text/html,bad"><img src="data:image/png;base64,AA" alt="image">');
  assert.doesNotMatch(html, /onclick|javascript:|data:text\/html/i);
  assert.ok(html.includes('src="data:image/png;base64,AA"'));
  assert.ok(html.includes('<p>Hello</p>'));
});
