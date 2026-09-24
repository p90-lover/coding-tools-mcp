"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("every app under More hosts its original visual plus Coding Tools controls", () => {
  const app = read("src/App.tsx");
  const more = app.slice(app.indexOf('<details className="sidebar-more"'), app.indexOf("</details>"));
  for (const id of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(more, new RegExp(`badge=\\{launchBadge\\("${id}"\\)\\}`), `${id} shows live launch state`);
    assert.match(app, new RegExp(`<ModuleControlsPanel language=\\{language\\} moduleId="${id}" setError=\\{setError\\} />`), id);
  }
  for (const id of ["cpa", "codex-router", "paseo", "anneal"]) {
    assert.match(app, new RegExp(`<IntegratedModuleSurface[\\s\\S]*?toolId="${id}"`), `${id} uses the integrated surface`);
  }
  assert.match(app, /function moduleLaunchBadge/);
  assert.match(app, /api\.appsLaunchSnapshot\(\)/);
  assert.match(app, /onAppsLaunchChanged/);
  assert.doesNotMatch(app, /import \{ UpstreamToolSurface \}/);
  assert.doesNotMatch(app, /import \{ OriginalUiSurface \}/);
});

test("runtime sub-clauses stay in the sidebar alongside More", () => {
  const app = read("src/App.tsx");
  const i18n = read("src/i18n.ts");
  for (const surface of ["runtime-orchestrator", "runtime-oauth", "runtime-api", "runtime-tasks", "runtime-tools"]) {
    assert.match(app, new RegExp(`navigateSurface\\("${surface}"\\)`), surface);
    assert.match(app, new RegExp(`surface === "${surface}"`), surface);
  }
  for (const key of ["runtimeOrchestrator", "runtimeOauth", "runtimeApi", "runtimeTasks", "runtimeTools"]) {
    assert.match(i18n, new RegExp(`${key}: "`), key);
  }
});

test("module controls expose the handler API surface and launch config through IPC", () => {
  const panel = read("src/features/ModuleControlsPanel.tsx");
  assert.match(panel, /appsLaunchSnapshot\(\)/);
  assert.match(panel, /configureAppLaunch\(moduleId, \{ autoStart/);
  assert.match(panel, /runAppsLaunch\(\{ reason: "manual", moduleIds: \[moduleId\] \}\)/);
  assert.match(panel, /apps\.catalog\(\)/);
  assert.match(panel, /apps\.invoke\(\{ handle: moduleId, moduleId, operation, arguments: args \}\)/);
  assert.match(panel, /APIs exposed to Coding Tools/);
  assert.doesNotMatch(panel, /http:\/\/127\.0\.0\.1:\d+/, "no hardcoded loopback ports in the controls");
  const types = read("src/types.ts");
  assert.match(types, /appsLaunchSnapshot\(\): Promise<AppsLaunchSnapshot>/);
  assert.match(types, /onAppsLaunchChanged\(listener/);
});

test("Connections › Providers opens the SaaS console instead of the legacy account grid", () => {
  const integration = read("src/providers/ProviderHubIntegration.tsx");
  assert.match(integration, /import \{ ProviderCenterSurface \} from "\.\.\/features\/ProviderHubSaasSurface"/);
  assert.match(integration, /<ProviderCenterSurface\s+language=\{locale === "zh-TW" \? "zh-TW" : "en"\}/);
  assert.match(integration, /<Icon name="providers" \/>/, "sidebar entry uses the native icon set");
  assert.match(integration, /className="sidebar-item-badge"/);
  assert.match(integration, /type ManagerView = "console" \| "routing" \| "proxies"/);
  assert.doesNotMatch(integration, /submitAccount|defaultAccountDraft|confirmConnected\(/, "legacy account dialog removed");
  assert.match(integration, /provider-manager-summary/);
  const css = read("src/providers/provider-manager.css");
  assert.match(css, /\.provider-manager-body\.is-console/);
  assert.match(css, /\.provider-summary-pill\.is-success/);
});

test("provider Connection clause is a SaaS card with status, endpoint, credential and actions", () => {
  const hub = read("src/features/ProviderHubSaasSurface.tsx");
  const card = read("src/features/ProviderConnectionCard.tsx");
  const css = read("src/features/provider-hub-saas.css");
  assert.match(hub, /<ProviderConnectionCard/);
  assert.doesNotMatch(hub, /"Connection status", "連線狀態"/, "the bare status dropdown is gone");
  assert.doesNotMatch(hub, /"Provider \/ management endpoint"/, "endpoint moved into the connection card");
  assert.match(card, /provider-connection-pill/);
  assert.match(card, /Test connection/);
  assert.match(card, /Stored \(encrypted\)/);
  assert.match(card, /Local loopback/);
  assert.match(card, /Managed inside Coding Tools; no separate server to run\./);
  assert.match(card, /data-status=\{effectiveStatus\}/);
  assert.match(css, /\.provider-connection-card\[data-status="connected"\]/);
});
