"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const surface = fs.readFileSync(
  path.join(root, "src/features/ProviderHubSaasSurface.tsx"),
  "utf8",
);
const catalog = fs.readFileSync(
  path.join(root, "src/providers/provider-types.ts"),
  "utf8",
);
const metadata = fs.readFileSync(
  path.join(root, "src/providers/provider-console-metadata.ts"),
  "utf8",
);
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");

test("Provider Hub exposes every requested OAuth and reverse-proxy provider", () => {
  for (const providerId of [
    "codex-oauth",
    "claude-oauth",
    "commandcode-proxy",
    "cliproxyapi-antigravity",
  ]) {
    assert.match(catalog, new RegExp(`id:\\s*["']${providerId}["']`));
    assert.match(metadata, new RegExp(`["']${providerId}["']`));
  }

  for (const providerName of [
    "Codex OAuth",
    "Claude OAuth",
    "CommandCode Proxy",
    "Gemini Antigravity Reverse Proxy",
  ]) {
    assert.match(surface, new RegExp(providerName));
    assert.match(metadata, new RegExp(providerName));
  }
  assert.match(surface, /PROVIDER_CATALOG\.map|PROVIDER_CATALOG\.filter/);
});

test("Provider Hub uses a compact searchable SaaS master-detail console", () => {
  assert.match(surface, /providerSearch/);
  assert.match(surface, /providerCategory/);
  assert.match(surface, /provider-directory-search/);
  assert.match(surface, /provider-filter-chip/);
  assert.match(surface, /provider-console-layout/);
  assert.match(surface, /provider-directory-row/);
  assert.match(surface, /provider-account-row/);
  assert.match(surface, /provider-detail-panel/);
  assert.doesNotMatch(surface, /No accounts configured/);
  assert.doesNotMatch(surface, /provider-card-grid/);
});

test("Provider Hub localizes the new management controls in Traditional Chinese", () => {
  for (const phrase of [
    "搜尋供應商或帳戶",
    "所有供應商",
    "反向代理",
    "登入帳戶",
    "新增帳戶",
    "帳戶與路由",
  ]) {
    assert.match(surface, new RegExp(phrase));
  }
});

test("The application exposes one active Provider destination and imports the SaaS surface", () => {
  const providerDestinations = app.match(/active=\{surface === "providers"\}/g) ?? [];
  const providerSurfaceMounts = app.match(/<ProviderCenterSurface\b/g) ?? [];
  assert.equal(providerDestinations.length, 1);
  // Providers page, Runtime → OAuth, Runtime → API models, and the CPA module's OAuth controls tab.
  assert.equal(providerSurfaceMounts.length, 4);
  assert.match(app, /focus="oauth"/);
  assert.match(app, /focus="api"/);
  assert.match(app, /ProviderHubSaasSurface/);
  assert.doesNotMatch(app, /from "\.\/features\/ProviderHubSurface"/);
});
