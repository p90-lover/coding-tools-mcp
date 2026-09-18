"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const appPath = path.join(desktopRoot, "src", "App.tsx");
const typesPath = path.join(desktopRoot, "src", "types.ts");
const tabsPath = path.join(desktopRoot, "src", "features", "ManagedAppsSurface.tsx");
const externalServicesPath = path.join(desktopRoot, "src", "features", "ExternalServicesSurface.tsx");

const app = fs.readFileSync(appPath, "utf8");
const types = fs.readFileSync(typesPath, "utf8");
const tabs = fs.readFileSync(tabsPath, "utf8");
const externalServices = fs.readFileSync(externalServicesPath, "utf8");

test("the main renderer exposes one Managed Apps surface", () => {
  assert.match(types, /export type Surface\s*=\s*[^;]*"apps"/s);
  assert.match(app, /ManagedAppsSurface/);
  assert.match(app, /surface === "apps"/);
  assert.match(app, /setManagedAppTab/);
  assert.match(app, /Managed Apps|應用程式/);
});

test("the managed workspace has five fixed engine tabs", () => {
  for (const id of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(tabs, new RegExp(`id:\\s*"${id}"`));
  }
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tab"/);
  assert.match(tabs, /role="tabpanel"/);
  assert.match(tabs, /aria-selected=/);
});

test("managed apps are rendered inside the Coding Tools window", () => {
  assert.doesNotMatch(tabs, /new\s+BrowserWindow|child_process|spawn\s*\(/);
  assert.match(tabs, /ProviderCenterSurface/);
  assert.match(tabs, /ExternalServicesSurface/);
  assert.match(tabs, /UpstreamToolSurface/);
});

test("Codex Router and CommandCode tabs focus their own service controls", () => {
  assert.match(tabs, /preferredServiceId="codex-router"/);
  assert.match(tabs, /preferredServiceId="commandcode-proxy"/);
  assert.match(externalServices, /preferredServiceId\??:\s*ExternalServiceId/);
  assert.match(externalServices, /setSelectedId\(preferredServiceId\)/);
});

test("the tab bar exposes redacted health without secrets", () => {
  assert.match(tabs, /onExternalServicesChanged/);
  assert.match(tabs, /managedInstall\.state/);
  assert.doesNotMatch(tabs, /callerKey|proxyApiKey|managementKey|oauthToken|accessToken/);
});
