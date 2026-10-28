"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
const { DEFAULT_REDACT_LIST, acceptableSecret, chatDescriptionRedacted, hiddenMarker, redactList } = require("../electron/chat-redaction.cjs");

// The renderer's own parser, so the rewritten description is checked the way the chat reads it.
const chat = (() => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ao-chat.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { exports, require: () => ({}) });
  return exports;
})();
const said = (description) => JSON.parse(JSON.stringify(chat.chatMessagesFromDescription(description)));

const KEY = "sk-proj-4fT9xQ2LmZ8vR1nB7cW3yH6k";
const PASSWORD = "Hunter2!Correct-Horse";
const description = [
  `deploy with ${KEY} please\n\n↳ Steer (2026-10-10 09:05 UTC): the db password is ${PASSWORD}`,
  `Follow-up (2026-10-10 10:00 UTC):\nalso try ${KEY} on staging`,
  "Follow-up (2026-10-10 11:00 UTC):\nthanks",
].join("\n\n");

test("every occurrence is hidden, in steers and follow-ups, and the chat keeps its messages", () => {
  const { description: after, hidden, refused } = chatDescriptionRedacted(description, [KEY, PASSWORD], "API key");
  assert.equal(hidden, 3);
  assert.equal(refused, 0);
  assert.doesNotMatch(after, /sk-proj|Hunter2/);
  const before = said(description), now = said(after);
  assert.equal(now.length, before.length, "no message is lost or merged");
  assert.deepEqual(now.map((message) => message.stamp), before.map((message) => message.stamp));
  assert.equal(now[0].text, "deploy with [hidden: API key] please");
  assert.equal(now[1].text, "also try [hidden: API key] on staging");
});

test("a secret inside another is hidden whole, and repeats count once", () => {
  const { description: after, hidden } = chatDescriptionRedacted(`token ${KEY}`, [KEY.slice(0, 20), KEY, KEY], "token");
  assert.equal(after, "token [hidden: token]");
  assert.equal(hidden, 1);
});

test("a private key block is hidden whole, whichever line endings it was saved with", () => {
  // Codex review of #653: private keys are on the default list, and they span lines.
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nAAAAAAABAAAAMwAAAAtzc2gtZWQy\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(acceptableSecret(pem), true);
  for (const saved of [pem, pem.replace(/\n/g, "\r\n")]) {
    const { description: after, hidden } = chatDescriptionRedacted(`my key:\n${saved}\nthanks`, [pem], "SSH key");
    assert.equal(after, "my key:\n[hidden: SSH key]\nthanks");
    assert.equal(hidden, 1);
  }
  // A block naming the chat's own markers is still refused.
  assert.equal(acceptableSecret("abc123\n\nFollow-up (2026-10-10 10:00 UTC):\nx"), false);
});

test("ordinary text and the chat's own markers are never hidden", () => {
  for (const word of ["", "the", "UTC", "Follow-up", "↳ Steer", "please", "[hidden: API key]", "   "]) {
    assert.equal(acceptableSecret(word), false, JSON.stringify(word));
  }
  assert.equal(acceptableSecret(KEY), true);
  assert.equal(acceptableSecret(PASSWORD), true);
  const { description: after, refused } = chatDescriptionRedacted(description, ["UTC", "Follow-up"], "x");
  assert.equal(after, description);
  assert.equal(refused, 2);
});

test("the label is one short line and the user's list is cleaned", () => {
  assert.equal(hiddenMarker("API]\nkey[ for prod"), "[hidden: API key for prod]");
  assert.equal(hiddenMarker(""), "[hidden: secret]");
  assert.deepEqual(redactList(undefined), [...DEFAULT_REDACT_LIST]);
  assert.deepEqual(redactList([" passwords ", "", "passwords", 3, "SSH keys"]), ["passwords", "SSH keys"]);
});

test("the chat draws each hidden mark as its label", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(chat.hiddenSecretParts("use [hidden: API key] and [hidden: password]."))),
    ["use ", { hidden: "API key" }, " and ", { hidden: "password" }, "."]);
  assert.deepEqual([...chat.hiddenSecretParts("nothing hidden")], ["nothing hidden"]);
});
