"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");

const {
  createEmailHost,
  normalizeOrigin,
  normalizeMessageListRow,
  positiveId,
  pageSize,
} = require("../electron/email-host.cjs");
const { parseMessage, sanitizeHtml, stripDangerous } = require("../electron/email-mime.cjs");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "email-host-"));
}

// A safeStorage stub with encryption unavailable, forcing the AES fallback path.
const noStorage = { isEncryptionAvailable: () => false };

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
    message: "x".repeat(1000), password: "secret", jwt: "token",
  });
  assert.equal(row.id, 7);
  assert.equal(row.preview.length, 240);
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

