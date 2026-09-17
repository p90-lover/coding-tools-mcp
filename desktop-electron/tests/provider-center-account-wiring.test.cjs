"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const providerHubPath = path.join(root, "src/features/ProviderHubSaasSurface.tsx");
const surface = fs.existsSync(providerHubPath)
  ? fs.readFileSync(providerHubPath, "utf8")
  : "";
const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
const types = fs.readFileSync(path.join(root, "src/types.ts"), "utf8");

test("the active Provider Center uses the canonical SaaS Provider Hub component", () => {
  assert.match(
    app,
    /import \{ ProviderCenterSurface \} from "\.\/features\/ProviderHubSaasSurface"/,
  );
  assert.ok(surface.length > 0, "ProviderHubSaasSurface.tsx must exist");
  assert.doesNotMatch(app, /ProviderOrchestratorSurfaces/);
});

test("Provider Center is backed by the encrypted multi-account Provider Hub", () => {
  assert.match(surface, /providerSnapshot\(\)/);
  assert.match(surface, /onProviderNetworkChanged/);
  assert.match(surface, /saveProviderAccount\(/);
  assert.match(surface, /beginProviderLogin\(/);
  assert.match(surface, /setDefaultProviderAccount\(/);
  assert.match(surface, /setProviderAccountEnabled\(/);
  assert.match(surface, /archiveProviderAccount\(/);
  assert.match(surface, /data-provider-account-summary/);
  assert.match(surface, /providerAccountCounts/);
  assert.match(surface, /個帳戶/);

  assert.match(preload, /saveProviderAccount/);
  assert.match(preload, /beginProviderLogin/);
  assert.match(types, /saveProviderAccount\(input: ProviderAccountInput\)/);
  assert.match(types, /beginProviderLogin\(accountId: string\)/);
});

test("Paseo and Anneal execution dispatch names the selected Provider Hub account", () => {
  assert.match(surface, /providerAccountId:\s*selectedAccount\.id/);
  assert.match(surface, /allowProviderFallback/);
});

test("Provider secrets and model discovery do not bypass the Electron main-process boundary", () => {
  assert.doesNotMatch(surface, /PROVIDER_STORAGE_KEY/);
  assert.doesNotMatch(surface, /localStorage\.(?:getItem|setItem)/);
  assert.doesNotMatch(surface, /await\s+fetch\s*\(/);
  assert.doesNotMatch(surface, /authorization["']?\s*,\s*`Bearer \$\{credential/);
});
