"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");

// The Provider Manager's "Fast mode for new chats" switch on Codex and Claude: the default a new
// chat on that provider's models starts with; the chat's effort menu turns it off or on per chat.
test("a provider's fast mode default is kept for Codex and Claude only, saved only when it changes", async (t) => {
  // The repo's own scratch folder (never the C: temp); other suites may have cleared it.
  fs.mkdirSync(path.join(__dirname, "../../aiTemp"), { recursive: true });
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/provider-fast-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "providers", "provider-network.json");
  const open = () => createProviderNetworkStore({ filePath, keyPath: path.join(root, "providers", "provider-network.key"),
    safeStorage: { isEncryptionAvailable: () => false } });
  const store = open();
  assert.deepEqual(store.snapshot().fastMode, {}, "off for every provider until switched on");

  assert.deepEqual(store.setProviderFastMode({ providerId: "codex-oauth", enabled: true }).fastMode, { "codex-oauth": true });
  assert.deepEqual(store.setProviderFastMode({ providerId: "claude-oauth", enabled: true }).fastMode, { "codex-oauth": true, "claude-oauth": true });
  await store.saved();
  const written = fs.statSync(filePath).mtimeMs;
  // An unchanged value writes nothing (the disk is shared with the running app).
  store.setProviderFastMode({ providerId: "codex-oauth", enabled: true });
  await store.saved();
  assert.equal(fs.statSync(filePath).mtimeMs, written);
  // Off is the absence of an entry, never a stored false.
  assert.deepEqual(store.setProviderFastMode({ providerId: "claude-oauth", enabled: false }).fastMode, { "codex-oauth": true });

  assert.throws(() => store.setProviderFastMode({ providerId: "gemini-oauth", enabled: true }), /no fast mode/);
  assert.throws(() => store.setProviderFastMode({ providerId: "codex-oauth", enabled: "yes" }), /on or off/);
  await store.saved();

  // It survives a restart; a hand-edited file keeps only true entries of known providers.
  assert.deepEqual(open().snapshot().fastMode, { "codex-oauth": true });
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  saved.fastMode = { "codex-oauth": "yes", "claude-oauth": true, "gemini-oauth": true };
  fs.writeFileSync(filePath, JSON.stringify(saved));
  assert.deepEqual(open().snapshot().fastMode, { "claude-oauth": true });
});
