"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("the main shell keeps the original Coding Tools navigation order", () => {
  const app = read("src/App.tsx");
  const styles = read("src/styles.css");
  const i18n = read("src/i18n.ts");

  assert.match(app, /SidebarGroup label=\{copy\.workspace\}/);
  assert.match(app, /SidebarGroup label=\{copy\.configuration\}/);
  assert.match(app, /SidebarGroup label=\{copy\.runtime\}/);
  assert.match(app, /<details className="sidebar-more"/);
  const more = app.slice(app.indexOf('<details className="sidebar-more"'), app.indexOf("</details>", app.indexOf('<details className="sidebar-more"')));
  assert.doesNotMatch(more, /navigateSurface\("providers"\)/, "the retired Provider Hub is not a More navigation item");
  assert.match(read("src/providers/ProviderHubIntegration.tsx"), /provider-sidebar-item/, "Connections keeps its independent Providers entry");
  assert.match(app, /SidebarGroup label=\{copy\.connections\}>[\s\S]{0,160}<div className="sidebar-provider-slot" \/>/, "Providers is the first row of the shell's Connections group");
  assert.match(read("src/providers/ProviderHubIntegration.tsx"), /querySelector<HTMLElement>\("\.sidebar-provider-slot"\)/);
  // `.sidebar-item > span { flex: 1 }` is for the label; without this the icon span took half the row (seen live in 0.8.35).
  // A bare `.provider-nav-icon` loses to that rule on specificity, so it is scoped under `.sidebar-item >`.
  assert.match(read("src/providers/provider-manager.css"), /\.sidebar-item > \.provider-nav-icon,\s*\.provider-nav-icon\s*\{[^}]*flex:\s*none;/);
  assert.match(more, /<small>\{moreSurfaces\.length\}<\/small>/, "More shows how many rows it folds away");
  assert.match(read("src/tokens.css"), /select option,[\s\S]*select optgroup\s*\{[^}]*background-color:[^}]*color:/, "unhovered native menu items keep explicit contrast");
  assert.match(app, /copy\.networkProxy/);
  assert.match(app, /setSidebarState\(\{ open, width \}\)/);
  assert.match(app, /className="sidebar-resize"/);
  assert.match(app, /<WorkspacePanel/);

  assert.match(app, /label="MCP"/);
  assert.doesNotMatch(app, /FiveStackLoopbackPanel/);
  assert.match(styles, /\.content-scroll\.is-fit\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.sidebar-more\s*\{/);
  assert.match(i18n, /product: "Coding Tools"/);
});

test("the error toast says a runtime timeout in words and seconds", () => {
  // Seen live in 0.8.35: "Something went wrong · ao-web-model-catalog timed out after 20000ms".
  const ts = require("typescript");
  const app = read("src/App.tsx");
  const start = app.indexOf("function readableError(");
  const end = app.indexOf("\nfunction ErrorToast(", start);
  assert.ok(start >= 0 && end > start, "readableError sits just above ErrorToast");
  const js = ts.transpileModule(`${app.slice(start, end)}\nmodule.exports = readableError;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: null };
  new Function("module", js)(loaded);
  const readableError = loaded.exports;
  assert.equal(readableError("ao-web-model-catalog timed out after 20000ms"), "AO web model catalog didn't finish within 20 s");
  assert.equal(
    readableError("cpa-start timed out after 1500ms; the child process did not exit after forced termination"),
    "CPA start didn't finish within 2 s; the child process did not exit after forced termination",
  );
  assert.equal(readableError("PowerShell timed out after 5000 ms"), "PowerShell timed out after 5000 ms", "only operation ids are rewritten");
  assert.equal(readableError("Network unreachable"), "Network unreachable");
  assert.match(app, /<p title=\{message\}>\{readableError\(message\)\}<\/p>/, "the full message stays in the tooltip");
});

test("a chat's head sits under the window's drag strip and is not padded by the title bar again", () => {
  // Seen live in split view: the head's own titlebar-area-height padding (46 px) inside its 48 px
  // squeezed the title down onto the chat's first lines in every pane.
  assert.match(read("src/features/AgentOrchestratorSurface.tsx"), /<div className="ao-dragstrip"/);
  const head = /\.cx-thread-head\s*\{([^}]*)\}/.exec(read("src/features/codex-chat.css"));
  assert.ok(head, "the chat head keeps its rule");
  assert.doesNotMatch(head[1], /titlebar-area-height/);
  assert.match(head[1], /min-height:\s*48px/);
});

const mcpSnapshot = (state = {}, metadata = {}) => ({
  state: { language: "en", onboardingComplete: true, browserInteractionMode: "automatic", codexCatalogVerified: true,
    mcpGuideStep: 1, mcpRuntimeInstalled: false, ...state },
  mcpCredentialsConfigured: false, connectorName: "old-connector", connectorNames: { automatic: "Auto", manual: "Manual" },
  urls: { tunnels: "https://example.test/tunnels", keys: "https://example.test/keys", connectors: "https://example.test/connectors" },
  smokePassed: true, update: { status: "idle" }, platform: "win32", version: "test", ...metadata,
});

// Run the real App setters and setup/settings JSX with hook state kept per mounted component.
function mcpUi(initial = mcpSnapshot()) {
  const ts = require("typescript"), vm = require("node:vm");
  const file = ts.createSourceFile("App.tsx", read("src/App.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["App", "McpSurface", "SetupSurface", "SettingsSurface"];
  const functions = file.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  const hooks = Object.fromEntries(functions.map(node => [node.name.text,
    [...node.getText(file).matchAll(/const \[([A-Za-z_]+),[^\]]+\] = useState/g)].map(match => match[1])]));
  const states = { App: { snapshot: initial, browser: { live: true, authenticated: true, status: "ready" }, operation: { status: "completed", name: "live-operation" } } };
  let component, index, snapshotReads = 0, logsReplaced = 0;
  const calls = [], errors = [], configuredModes = [], setupInputs = [];
  const backend = { snapshot: mcpSnapshot({ ...initial.state, mcpRuntimeInstalled: true }, { mcpCredentialsConfigured: true, connectorName: "fresh-connector" }) };
  const api = {
    snapshot: async () => { snapshotReads++; return structuredClone(backend.snapshot); },
    setupMcp: async input => { calls.push("setupMcp"); setupInputs.push(input); backend.snapshot.state.browserInteractionMode = input.interactionMode; },
    setMcpStep: async next => { calls.push("setMcpStep"); backend.snapshot.state.mcpGuideStep = next; return structuredClone(backend.snapshot.state); },
    setupCore: async () => { calls.push("setupCore"); }, smokeTest: async () => { calls.push("smokeTest"); },
    createMcpConnector: async () => { calls.push("createMcpConnector"); return { created: true }; },
    verifyMcp: async () => { calls.push("verifyMcp"); return { ok: true, checks: [] }; },
    setBrowserInteractionMode: async mode => { calls.push("setBrowserInteractionMode"); backend.snapshot.state.browserInteractionMode = mode;
      return { state: structuredClone(backend.snapshot.state), credentialsRequired: false, targetMode: mode }; },
    setPreference: async (key, value) => { calls.push("setPreference"); return { ...states.App.snapshot.state, [key]: value }; },
  };
  const tags = ["LauncherShell", "Onboarding", "ErrorToast", "ContentSurface", "SectionHeading", "SettingRow", "Switch", "InteractionModePicker",
    "PrimaryButton", "SecondaryButton", "NoticeRow", "McpMark", "TutorialVideo", "DoctorSummary", "FieldRow", "McpTunnelsPanel", "Icon", "SetupRow", "BrandMark", "LanguageMenu"];
  const jsx = (type, props) => ({ type, props: props || {} }), exports = {}, copy = new Proxy({}, { get: (_target, name) => name });
  vm.runInNewContext(ts.transpileModule(functions.map(node => node.getText(file)).join("\n")
    + "\nexports.McpSurface = McpSurface; exports.SetupSurface = SetupSurface; exports.SettingsSurface = SettingsSurface;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, api, Error, ...Object.fromEntries(tags.map(name => [name, name])), AnimatePresence: "presence", motion: { section: "section" },
    MCP_GUIDE_MEDIA: ["video-1", "video-2", "video-3"], copyFor: () => copy, platformLabel: value => value, messageOf: cause => cause.message,
    replaceLogs: () => { logsReplaced++; }, useEffect() {}, useMemo: calculate => calculate(), useCallback: callback => callback,
    useRef: () => ({ current: null }), useState(initialValue) {
      const state = states[component] ??= {}, name = hooks[component][index++]; assert.ok(name);
      if (!(name in state)) state[name] = typeof initialValue === "function" ? initialValue() : initialValue;
      return [state[name], next => { state[name] = typeof next === "function" ? next(state[name]) : next; }];
    }, require: () => ({ jsx, jsxs: jsx }),
  });
  const nodes = tree => !tree || typeof tree !== "object" ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
  const render = (name, props) => { component = name; index = 0; return exports[name](props); };
  const current = () => nodes(render("App")).find(node => node.type === "LauncherShell").props;
  const common = () => ({ ...current(), copy, devProfile: false, language: "en", operation: null, setError: error => errors.push(error) });
  return { api, backend, states, calls, errors, configuredModes, setupInputs, current, nodes,
    reads: () => snapshotReads, logsReplaced: () => logsReplaced,
    wizard: mode => render("McpSurface", { ...common(), interactionMode: mode || current().snapshot.state.browserInteractionMode, onDone() {} }),
    setup: () => render("SetupSurface", { ...common(), activateBrowser: async () => {}, showMcp() {} }),
    settings: () => render("SettingsSurface", { ...common(), configureInteractionMode: mode => configuredModes.push(mode), openPlugins() {} }),
    remountWizard() { delete states.McpSurface; },
    autoConnect() { const row = nodes(this.settings()).find(node => node.type === "SettingRow" && node.props.label === "autoConnectExistingMcp");
      return nodes(row).find(node => node.type === "Switch"); },
  };
}

test("MCP setup refreshes root metadata, a reopened wizard and Settings without replacing live channels", async () => {
  const ui = mcpUi(); let wizard = ui.wizard();
  const controls = () => ui.nodes(wizard), connect = () => controls().find(node => node.type === "PrimaryButton");
  assert.equal(controls().find(node => node.props.className === "wizard-stepper").props.children.length, 3);
  assert.equal(connect().props.disabled, true);
  const inputs = controls().filter(node => node.type === "input"); assert.equal(inputs.length, 2); assert.equal(inputs[1].props.type, "password");
  inputs[0].props.onChange({ target: { value: "synthetic-tunnel" } }); inputs[1].props.onChange({ target: { value: "synthetic-key" } });
  wizard = ui.wizard(); assert.equal(connect().props.disabled, false); connect().props.onClick(); await new Promise(setImmediate);
  assert.equal(ui.current().snapshot.mcpCredentialsConfigured, true);
  assert.equal(ui.current().snapshot.connectorName, "fresh-connector"); assert.equal(ui.current().snapshot.state.mcpRuntimeInstalled, true);
  assert.equal(ui.reads(), 1); assert.equal(ui.setupInputs[0].interactionMode, "automatic"); assert.equal(ui.setupInputs[0].replace, true);
  assert.equal(ui.current().browser.live, true); assert.equal(ui.current().operation.name, "live-operation"); assert.equal(ui.logsReplaced(), 0);
  ui.remountWizard(); wizard = ui.wizard();
  ui.nodes(wizard).find(node => node.type === "button" && node.props.children === "previous").props.onClick(); await new Promise(setImmediate);
  assert.ok(ui.nodes(ui.wizard()).some(node => node.props.className === "saved-credentials"));
  assert.equal(ui.autoConnect().props.disabled, false);
  assert.match(read("src/App.tsx"), /function InstantMcpToolsSurface[\s\S]*?<WorkspacePanel/);
  assert.match(read("src/App.tsx"), /surface === "instant-mcp"/);
});

test("setup smoke/install and MCP connector/verification consume their existing full snapshot reads", async t => {
  for (const action of ["smokeTest", "setupCore", "createMcpConnector", "verifyMcp"]) await t.test(action, async () => {
    const ui = mcpUi(mcpSnapshot({ mcpGuideStep: 2 }, { mcpCredentialsConfigured: true }));
    let control;
    if (action === "smokeTest" || action === "setupCore") control = ui.nodes(ui.setup()).find(node => node.type === "SetupRow" && node.props.index === (action === "smokeTest" ? 2 : 3));
    else control = ui.nodes(ui.wizard()).find(node => node.type === (action === "createMcpConnector" ? "SecondaryButton" : "PrimaryButton") && node.props.children === (action === "createMcpConnector" ? "autoCreateConnector" : "verifyRuntime"));
    assert.ok(control); assert.equal(Boolean(control.props.disabled), false);
    (control.props.onAction || control.props.onClick)(); await new Promise(setImmediate);
    assert.ok(ui.calls.includes(action)); assert.equal(ui.reads(), 1); assert.equal(ui.current().snapshot.connectorName, "fresh-connector");
  });
});

test("successful mode commits refresh authoritative metadata while missing credentials and failed changes do not", async t => {
  for (const outcome of ["committed", "credentials-required", "failed"]) await t.test(outcome, async () => {
    const ui = mcpUi(mcpSnapshot({ browserInteractionMode: "manual", mcpRuntimeInstalled: true }));
    if (outcome === "credentials-required") ui.api.setBrowserInteractionMode = async mode => ({ state: ui.current().snapshot.state, credentialsRequired: true, targetMode: mode });
    if (outcome === "failed") ui.api.setBrowserInteractionMode = async () => { throw new Error("mode change failed"); };
    ui.nodes(ui.settings()).find(node => node.type === "InteractionModePicker").props.onChange("automatic"); await new Promise(setImmediate);
    assert.equal(ui.reads(), outcome === "committed" ? 1 : 0);
    assert.equal(ui.current().snapshot.mcpCredentialsConfigured, outcome === "committed");
    assert.equal(ui.current().snapshot.state.browserInteractionMode, outcome === "committed" ? "automatic" : "manual");
    if (outcome === "committed") assert.equal(ui.autoConnect().props.disabled, false);
    if (outcome === "credentials-required") assert.deepEqual(ui.configuredModes, ["automatic"]);
    if (outcome === "failed") assert.equal(ui.errors.at(-1), "mode change failed");
  });
});

test("failed setup and failed metadata reads preserve backend-derived flags", async t => {
  for (const failure of ["setup", "snapshot"]) await t.test(failure, async () => {
    const ui = mcpUi(); ui.states.McpSurface = { tunnelId: "synthetic-tunnel", runtimeKey: "synthetic-key" };
    if (failure === "setup") ui.api.setupMcp = async () => { throw new Error("setup failed"); };
    else ui.api.snapshot = async () => { throw new Error("snapshot failed"); };
    ui.nodes(ui.wizard()).find(node => node.type === "PrimaryButton").props.onClick(); await new Promise(setImmediate);
    assert.equal(ui.current().snapshot.mcpCredentialsConfigured, false); assert.equal(ui.current().snapshot.connectorName, "old-connector");
    assert.equal(ui.errors.at(-1), failure + " failed"); assert.equal(ui.autoConnect().props.disabled, true);
  });
});

test("state-only updates and preferences retain metadata without fetching or guessing credentials", async () => {
  const ui = mcpUi();
  ui.current().updateState({ ...ui.current().snapshot.state, mcpRuntimeInstalled: true, mcpSetupComplete: true });
  assert.equal(ui.current().snapshot.mcpCredentialsConfigured, false); assert.equal(ui.reads(), 0);
  assert.equal(ui.autoConnect().props.disabled, true);
  ui.nodes(ui.settings()).find(node => node.type === "SettingRow" && node.props.label === "keepRunningOnClose").props.children.props.onChange(true);
  await new Promise(setImmediate);
  assert.equal(ui.current().snapshot.state.keepRunningOnClose, true); assert.equal(ui.current().snapshot.connectorName, "old-connector"); assert.equal(ui.reads(), 0);
  const otherMode = mcpUi(mcpSnapshot({}, { mcpCredentialsConfigured: true }));
  assert.ok(otherMode.nodes(otherMode.wizard("manual")).some(node => node.type === "input"), "active-mode credentials do not imply inactive-mode credentials");
});

test("live MCP tool controls call the typed Coding Tools API", () => {
  const panel = read("src/features/McpLiveToolsPanel.tsx");
  const contracts = read("src/api/contracts.ts");
  const preload = read("electron/preload.cjs");
  const main = read("electron/main.cjs");
  const schema = read("electron/ipc-schema.cjs");

  assert.match(panel, /getCodingToolsClient\(\)/);
  assert.match(panel, /client\.workspaces\.list/);
  assert.match(panel, /client\.tools\.catalog/);
  assert.match(panel, /tools\.call/);
  const appsPanel = read("src/features/InProcessAppsPanel.tsx");
  assert.match(appsPanel, /client\.apps\.list/);
  assert.match(appsPanel, /client\.apps\.call/);
  assert.match(appsPanel, /client\.apps\.invoke/);
  assert.match(appsPanel, /apps_list/);
  assert.match(appsPanel, /apps_invoke/);
  assert.match(contracts, /readonly tools:/);
  assert.match(contracts, /readonly apps:/);
  assert.match(preload, /"tools.catalog"/);
  assert.match(preload, /"tools.call"/);
  assert.match(preload, /"apps.call"/);
  assert.match(main, /coding-tools:workspaces:list/);
  assert.match(main, /coding-tools:tools:catalog/);
  assert.match(main, /coding-tools:tools:call/);
  assert.match(main, /coding-tools:apps:call/);
  assert.match(main, /mergeAppsCatalog/);
  assert.match(main, /appsMcp\.hasTool/);
  assert.match(schema, /"tools.catalog"/);
  assert.match(schema, /"apps.call"/);
});

test("the shell bridge adapts headless workspaces into the typed page contract", () => {
  const {
    pageWorkspaces,
    toWorkspaceSummary,
  } = require("../electron/coding-tools-shell-bridge.cjs");

  assert.equal(toWorkspaceSummary({ id: "", name: "x", path: "/tmp" }), null);
  assert.deepEqual(toWorkspaceSummary({
    id: "ws-1",
    name: "Demo",
    path: "/tmp/demo",
    linked_projects: [{ alias: "side", name: "Side", path: "/tmp/side", mode: "read-only" }],
    mcp_state: "running",
    policy_revision: 4,
    permission_mode: "workspace-write",
    approval_mode: "on-request",
    tool_profile: "advanced",
    mcp_auth_type: "oauth",
    actions_auth_type: "api_key",
    mcp_local_port: 28766,
    actions_local_port: 8787,
    screen_capture_enabled: true,
    mcp_oauth_client_id: "client-1",
    mcp_oauth_redirect_uris: ["https://chatgpt.com/connector_platform/oauth/callback"],
    mcp_use_shared_secrets: false,
    actions_oauth_client_id: "actions-1",
    actions_oauth_redirect_uris: ["https://chatgpt.com/connector_platform/oauth/callback"],
    actions_oauth_scopes: "read",
    actions_use_shared_secrets: true,
  }), {
    id: "ws-1",
    name: "Demo",
    path: "/tmp/demo",
    linkedProjects: [{ alias: "side", name: "Side", path: "/tmp/side", mode: "read-only" }],
    mcpState: "running",
    policyRevision: 4,
    permissionMode: "workspace-write",
    approvalMode: "on-request",
    toolProfile: "advanced",
    mcpAuthType: "oauth",
    actionsAuthType: "api_key",
    mcpLocalPort: 28766,
    actionsLocalPort: 8787,
    screenCaptureEnabled: true,
    mcpOAuthClientId: "client-1",
    mcpOAuthRedirectUris: ["https://chatgpt.com/connector_platform/oauth/callback"],
    mcpUseSharedSecrets: false,
    actionsOAuthClientId: "actions-1",
    actionsOAuthRedirectUris: ["https://chatgpt.com/connector_platform/oauth/callback"],
    actionsOAuthScopes: "read",
    actionsUseSharedSecrets: true,
  });

  const page = pageWorkspaces([
    { id: "a", name: "A", path: "/a", mcpState: "stopped", policyRevision: 0 },
    { id: "b", name: "B", path: "/b", mcpState: "running", policyRevision: 1 },
  ], 1, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, "b");
  assert.equal(page.nextCursor, null);
});
