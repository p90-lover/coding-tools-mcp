"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(desktopRoot, relative), "utf8");

function providerBlock(source, providerId) {
  const start = source.indexOf(`id: "${providerId}"`);
  assert.ok(start >= 0, `missing provider ${providerId}`);
  const next = source.indexOf("\n  {\n    id:", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test("provider catalog declares explicit expandable login adapters", () => {
  const source = read("src/providers/provider-types.ts");
  assert.match(source, /ProviderLoginAdapterKind/);
  assert.match(source, /ProviderLoginAdapterDefinition/);
  assert.match(source, /loginAdapters\?: ProviderLoginAdapterDefinition\[\]/);

  const codex = providerBlock(source, "codex-oauth");
  assert.match(codex, /id: "cpa-codex"/);
  assert.match(codex, /kind: "cpa_oauth"/);
  assert.match(codex, /route: "codex-auth-url"/);
  assert.match(codex, /id: "native-browser"/);

  const claude = providerBlock(source, "claude-oauth");
  assert.match(claude, /id: "cpa-claude"/);
  assert.match(claude, /route: "anthropic-auth-url"/);

  const antigravity = providerBlock(source, "cliproxyapi-antigravity");
  assert.match(antigravity, /id: "cpa-antigravity"/);
  assert.match(antigravity, /route: "antigravity-auth-url"/);

  const gemini = providerBlock(source, "gemini-oauth");
  assert.match(gemini, /id: "cpa-gemini"/);
  assert.match(gemini, /kind: "cpa_auth_file"/);
  assert.doesNotMatch(gemini, /gemini-auth-url/);
});

test("Provider Center renders login controls from adapter capability, not broad auth type", () => {
  const source = read("src/features/ProviderHubSaasSurface.tsx");
  assert.doesNotMatch(
    source,
    /return provider\.auth === "oauth"[\s\S]{0,200}provider\.auth === "browser_session"/,
  );
  assert.match(source, /selectedLoginAdapter/);
  assert.match(source, /loginAdapters/);
  assert.match(source, /beginProviderLogin\(saved\.id,\s*(?:selectedLoginAdapter|adapter)\.id\)/);
  assert.match(source, /Login source/);
  assert.match(source, /登入來源/);
  assert.match(source, /Import CPA account/);
  assert.match(source, /匯入 CPA 帳戶/);
});

test("Gemini OAuth is routable as a first-class managed provider", () => {
  const router = read("electron/provider-execution-router.cjs");
  assert.match(router, /id: "gemini-oauth"[\s\S]{0,220}protocol: "gemini_native"/);
});
