const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const typesSource = fs.readFileSync(path.join(launcherRoot, "src", "types.ts"), "utf8");
const i18nSource = fs.readFileSync(path.join(launcherRoot, "src", "i18n.ts"), "utf8");
const stylesSource = fs.readFileSync(path.join(launcherRoot, "src", "styles.css"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");
const aoSource = fs.readFileSync(path.join(launcherRoot, "src", "features", "AgentOrchestratorSurface.tsx"), "utf8");
const servicesSource = fs.readFileSync(path.join(launcherRoot, "src", "features", "ExternalServicesSurface.tsx"), "utf8");
const proxySource = fs.readFileSync(path.join(launcherRoot, "src", "features", "NetworkProxySurface.tsx"), "utf8");

test("a new chat's Team picker sits in the chat header, with no setting bar above the chat (Codex)", () => {
  assert.match(aoSource, /headerExtra=\{chatTaskId === "" && savedTeams\.length \? <label className="cx-head-team"/, "the picker is passed to the chat header");
  assert.match(aoSource, /aria-label="New chat team"/);
  assert.doesNotMatch(aoSource, /className="ao-new-chat-team"/, "the full-width Team row is gone");
  const css = fs.readFileSync(path.join(launcherRoot, "src/features/agent-orchestrator.css"), "utf8");
  const ordinaryStage = /\.ao-stage\s*\{([^}]+)\}/.exec(css)?.[1] || "";
  assert.doesNotMatch(ordinaryStage, /flex-direction:\s*column/, "overview stages must keep their existing layout");
});

// Since the Chat redesign (2574a6bd) the "Chat" entry mounts the Coding Tools AO surface; the
// original upstream AO UI keeps its own destination and links back to Chat.
test("Chat mounts the AO chat surface and the original AO UI links back to it", () => {
  assert.match(appSource, /keepAlive\("agent-orchestrator", \(\) => \(\s*<section className="gpb-chat"[\s\S]*?<AgentOrchestratorSurface language=\{language\} setError=\{setError\} \/>/);
  assert.match(appSource, /keepAlive\("agent-orchestrator-original", \(\) => \(\s*<AgentOrchestratorOriginalSurface openMissions=\{\(\) => navigateSurface\("agent-orchestrator"\)\}/);
  assert.match(appSource, /label="Chat" onClick=\{\(\) => navigateSurface\("agent-orchestrator"\)\}/);
});

test("Register keeps its Connections destination and native overlay visibility gate", () => {
  const connections = appSource.slice(appSource.indexOf("<SidebarGroup label={copy.connections}>"), appSource.indexOf('<details className="sidebar-more"'));
  assert.match(connections, /active=\{surface === "register"\}[\s\S]*?label=\{copy.register\}[\s\S]*?navigateSurface\("register"\)/);
  assert.ok(appSource.includes('{keepAlive("register"'));
  const gate = /<RegisterSurface[\s\S]*?active=\{([^}]+)\}/.exec(appSource)?.[1];
  assert.equal(gate, 'surface === "register" && !(compactSidebar && sidebarOpen) && !biggerContextRecommendationOpen && !sessionReminderDue && !refreshMenuOpen');
  assert.match(typesSource, /type Surface[^;]*"register"/);
  assert.equal((i18nSource.match(/register: /g) || []).length, 4);
});

test("Refresh menu reports every open and close path to the Register native gate", async () => {
  const vm = require("node:vm"), ts = require("typescript");
  const file = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = file.statements.filter(ts.isFunctionDeclaration);
  const parts = file.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => item.name.getText(file) === "REFRESH_PARTS"));
  const code = [parts.getText(file), ...["RefreshMenu", "TitleBar"].map((name) => functions.find((node) => node.name?.text === name).getText(file)),
    "exports.RefreshMenu = RefreshMenu; exports.TitleBar = TitleBar;"].join("\n");
  const states = [], effects = [], pending = [], listeners = new Map(), requests = [], errors = [];
  let stateIndex = 0, effectIndex = 0, reportedOpen = false;
  const effect = (work, deps) => {
    const index = effectIndex++, previous = effects[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) pending.push(() => {
      previous?.cleanup?.(); effects[index] = { deps, cleanup: work() };
    });
  };
  const jsx = (type, props) => ({ type, props }), exports = {};
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, Icon: "icon", IconButton: "icon-button", useEffect: effect, useLayoutEffect: effect,
    useRef: () => ({ current: { contains: (target) => target === "inside" } }),
    useState: (initial) => { const index = stateIndex++; if (!(index in states)) states[index] = initial;
      return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
    document: { addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); } },
    api: { refreshPart: async (part) => { requests.push(part); throw new Error("fixture refresh failed"); } },
    messageOf: (cause) => cause.message, require: () => ({ jsx, jsxs: jsx }),
  });
  const nodes = (node, type) => !node || typeof node !== "object" ? []
    : [...(node.type === type ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, type))];
  const notify = (open) => { reportedOpen = open; };
  const titlebar = exports.TitleBar({ copy: {}, devProfile: false, draggable: false, sidebarOpen: false,
    toggleSidebar() {}, setError: (value) => errors.push(value), onRefreshMenuOpenChange: notify });
  const menu = nodes(titlebar, exports.RefreshMenu)[0];
  assert.equal(menu.props.onOpenChange, notify, "TitleBar must forward the visibility callback");
  // A clicked sidebar toggle must not keep focus: a later Space or Enter would hide the sidebar.
  assert.equal(nodes(titlebar, "icon-button")[0].props.releaseFocus, true);
  assert.match(appSource, /onMouseDown=\{releaseFocus \? \(event\) => event\.preventDefault\(\) : undefined\}/);
  // A manual browser tab closes only the compact sidebar, never the docked one.
  assert.match(appSource, /setSurface\("browser"\);\s*\/\/[^\n]*\n\s*if \(window\.matchMedia\(COMPACT_SIDEBAR_QUERY\)\.matches\) setSidebarOpen\(false\);/);
  assert.match(appSource, /onRefreshMenuOpenChange=\{setRefreshMenuOpen\}/);
  const expression = /<RegisterSurface[\s\S]*?active=\{([^}]+)\}/.exec(appSource)[1];
  const gate = new Function("surface", "compactSidebar", "sidebarOpen", "biggerContextRecommendationOpen", "sessionReminderDue", "refreshMenuOpen", "return " + expression);
  const visible = () => gate("register", false, false, false, false, reportedOpen);
  const render = () => { stateIndex = 0; effectIndex = 0; const tree = exports.RefreshMenu(menu.props);
    for (const work of pending.splice(0)) work(); return tree; };
  let tree = render();
  const toggle = () => { nodes(tree, "button")[0].props.onClick(); tree = render(); };
  assert.equal(visible(), true);
  toggle(); assert.equal(reportedOpen, true); assert.equal(visible(), false);
  listeners.get("mousedown")({ target: "inside" }); tree = render(); assert.equal(reportedOpen, true);
  listeners.get("mousedown")({ target: "outside" }); tree = render(); assert.equal(reportedOpen, false); assert.equal(visible(), true);
  toggle(); toggle(); assert.equal(reportedOpen, false, "the toolbar button also closes its menu");
  toggle();
  nodes(tree, "button").find((node) => node.props.children === "UI only").props.onClick();
  tree = render(); assert.equal(reportedOpen, false); assert.equal(visible(), true);
  await new Promise(setImmediate); tree = render();
  assert.deepEqual(requests, ["ui"]); assert.equal(errors.at(-1), "fixture refresh failed"); assert.equal(reportedOpen, false);
  toggle(); assert.equal(reportedOpen, true);
  for (const entry of effects) entry?.cleanup?.();
  assert.equal(reportedOpen, false, "unmount releases the native visibility gate");
  assert.equal(visible(), true); assert.equal(listeners.size, 0);
});

test("Register IPC trusts only the launcher frame and permits hidden detach", async () => {
  const vm = require("node:vm"), ts = require("typescript");
  const file = ts.createSourceFile("main.cjs", electronMain, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = file.statements.filter(ts.isFunctionDeclaration);
  const registration = functions.find((node) => node.name?.text === "registerIpc");
  const guard = registration.body.statements.filter(ts.isVariableStatement)
    .flatMap((node) => Array.from(node.declarationList.declarations)).find((node) => node.name.getText(file) === "registerFor");
  assert.ok(guard, "Register controls need their own trusted-frame gate");
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "handle"
      && node.arguments[0]?.text?.startsWith("launcher:register-")) calls.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(registration);
  const handlers = new Map(), seen = [];
  let visible = true, focused = true;
  const mainFrame = {};
  const sender = { mainFrame, isFocused: () => focused, getZoomFactor: () => 2 };
  const mainWindow = { webContents: sender, isDestroyed: () => false,
    isVisible: () => visible, isMinimized: () => !visible, isFocused: () => focused };
  const host = Object.fromEntries(["status", "configure", "start", "stop", "reload", "setSurfaceActive", "setBounds"]
    .map((name) => [name, (...args) => { seen.push([name, ...args]); return { ready: true }; }]));
  vm.runInNewContext(functions.filter((node) => ["validateBounds", "assertFocusedMainWindow"].includes(node.name?.text))
    .map((node) => node.getText(file)).join("\n") + "\nconst registerFor = " + guard.initializer.getText(file) + ";\n" + calls.join(";\n"), {
    mainWindow, BrowserWindow: { fromWebContents: (value) => value === sender ? mainWindow : null },
    logger: {}, getRegisterHost: () => host, handle: (channel, handler) => handlers.set(channel, handler),
  });
  assert.equal(handlers.size, 7);
  const event = { sender, senderFrame: mainFrame };
  for (const handler of handlers.values()) assert.throws(() => handler({ sender, senderFrame: {} }), /main.*frame/i);
  assert.equal(seen.length, 0);
  focused = false;
  for (const suffix of ["configure", "start", "stop"]) assert.throws(() => handlers.get("launcher:register-" + suffix)(event, "C:\\fixture"), /focused/);
  await handlers.get("launcher:register-status")(event);
  assert.equal(seen.length, 1);
  visible = false;
  handlers.get("launcher:register-surface-active")(event, false);
  assert.deepEqual(seen.at(-1), ["setSurfaceActive", false]);
  assert.throws(() => handlers.get("launcher:register-surface-active")(event, true), /Open the Coding Tools/);
  visible = true;
  handlers.get("launcher:register-bounds")(event, { x: 2, y: 3, width: 100, height: 80 });
  assert.deepEqual(JSON.parse(JSON.stringify(seen.at(-1))), ["setBounds", { x: 4, y: 6, width: 200, height: 160 }]);
  assert.throws(() => handlers.get("launcher:register-bounds")(event, { x: NaN, y: 0, width: 1, height: 1 }), /finite/);
});

test("minimized AO status polls require the trusted main frame and preserve focused writes", () => {
  const vm = require("node:vm"), ts = require("typescript");
  const file = ts.createSourceFile("main.cjs", electronMain, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = file.statements.filter(ts.isFunctionDeclaration);
  const guard = functions.find(node => node.name?.text === "assertFocusedMainWindow");
  let registration;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "handle"
      && node.arguments[0]?.text === "coding-tools:apps:call") registration = node.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(functions.find(node => node.name?.text === "registerIpc"));
  assert.ok(registration);
  let visible = false, minimized = true, focused = false, destroyed = false;
  const mainFrame = {}, calls = [], handlers = new Map();
  const sender = { mainFrame, isFocused: () => focused, getZoomFactor: () => 1 };
  const mainWindow = { isDestroyed: () => destroyed, isVisible: () => visible,
    isMinimized: () => minimized, isFocused: () => focused };
  const appsHost = {
    isReadOnly: (_module, operation) => ["run_status", "subagents_runs", "models"].includes(operation),
    call: (module, operation) => { calls.push([module, operation]); return { ok: true }; },
  };
  vm.runInNewContext(guard.getText(file) + "\n" + registration, {
    mainWindow, BrowserWindow: { fromWebContents: value => value === sender ? mainWindow : {} },
    appsHost, handle: (channel, handler) => handlers.set(channel, handler),
  });
  const call = handlers.get("coding-tools:apps:call"), event = { sender, senderFrame: mainFrame };
  for (const operation of ["run_status", "subagents_runs"]) {
    assert.equal(call(event, { moduleId: "agent-orchestrator", operation }).ok, true);
    assert.throws(() => call({ sender, senderFrame: {} }, { moduleId: "agent-orchestrator", operation }));
    assert.throws(() => call({ sender: { mainFrame }, senderFrame: mainFrame }, { moduleId: "agent-orchestrator", operation }));
  }
  assert.equal(calls.length, 2);
  for (const operation of ["chat_send", "start_run", "subagents_stop", "models", "chat_preview_show"]) {
    assert.throws(() => call(event, { moduleId: "agent-orchestrator", operation }));
  }
  assert.throws(() => call(event, { moduleId: "other", operation: "run_status" }));
  destroyed = true;
  assert.throws(() => call(event, { moduleId: "agent-orchestrator", operation: "run_status" }));
  destroyed = false; visible = true; minimized = false;
  assert.throws(() => call(event, { moduleId: "agent-orchestrator", operation: "chat_send" }), /focused/);
  focused = true;
  assert.equal(call(event, { moduleId: "agent-orchestrator", operation: "chat_send" }).ok, true);
  assert.equal(calls.length, 3, "only accepted reads and the genuinely focused send reach the host");
});

test("Register native page detaches for launcher reload and crash without stopping its service", async () => {
  const vm = require("node:vm"), ts = require("typescript");
  const file = ts.createSourceFile("main.cjs", electronMain, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = file.statements.filter(ts.isFunctionDeclaration);
  const sourceOf = (name) => functions.find((node) => node.name?.text === name).getText(file);
  const callbacks = new Map(), calls = [], recovered = [];
  const collect = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "window.webContents.on"
      && ["did-start-navigation", "render-process-gone"].includes(node.arguments[0]?.text)) {
      callbacks.set(node.arguments[0].text, node.arguments[1].getText(file));
    }
    ts.forEachChild(node, collect);
  };
  collect(functions.find((node) => node.name?.text === "createWindow"));
  const window = { isDestroyed: () => false, loadURL: async () => calls.push("load") };
  const scope = { window, mainWindow: window, URL, isDev: true, process: { env: { VITE_DEV_SERVER_URL: "http://localhost:4318/" } },
    registerHost: { setSurfaceActive: (value) => calls.push(value), shutdown: () => assert.fail("Renderer reload must not stop Register") },
    logger: { warn() {} }, quitting: false, rendererCrashes: [], setTimeout() {},
    // The crash path and renderer-watchdog.cjs share one recovery (reload, or restart after three).
    recoverRenderer: (reason) => recovered.push(reason),
  };
  const load = vm.runInNewContext("(" + sourceOf("loadRenderer") + ")", scope);
  await load(window);
  assert.deepEqual(calls, [false, "load"], "UI refresh hides the native view before its document is replaced");
  calls.length = 0;
  scope.mainWindow = {};
  await load(window);
  assert.deepEqual(calls, ["load"], "a stale window cannot detach the current window's view");
  scope.mainWindow = window; calls.length = 0;
  assert.ok(callbacks.has("did-start-navigation"), "Cmd/Ctrl-R also needs a main-document navigation hook");
  vm.runInNewContext(sourceOf("rendererNavigationAllowed"), scope);
  const navigate = vm.runInNewContext("(" + callbacks.get("did-start-navigation") + ")", scope);
  navigate({}, "http://localhost:4318/#chat", true, true);
  navigate({}, "http://localhost:4318/", false, false);
  navigate({}, "https://example.invalid/", false, true);
  assert.deepEqual(calls, [], "SPA, subframe and blocked navigation preserve the current view");
  navigate({}, "http://localhost:4318/", false, true);
  assert.deepEqual(calls, [false]);
  calls.length = 0; scope.mainWindow = {};
  navigate({}, "http://localhost:4318/", false, true);
  assert.deepEqual(calls, []);
  scope.mainWindow = window;
  const crashed = vm.runInNewContext("(" + callbacks.get("render-process-gone") + ")", scope);
  crashed({}, { reason: "crashed", exitCode: 1 });
  assert.deepEqual(calls, [false], "a crashed React renderer cannot run its own detach cleanup");
  assert.deepEqual(recovered, ["gone"], "and the page is recovered");
  crashed({}, { reason: "clean-exit", exitCode: 0 });
  assert.deepEqual(recovered, ["gone"], "a renderer that closed cleanly is not reloaded");
});

test("In-Process Apps shows only CPA/AO and refuses a stale retired selection", async () => {
  const vm = require("node:vm");
  const ts = require(require.resolve("typescript", { paths: [launcherRoot] }));
  const source = fs.readFileSync(path.join(launcherRoot, "src", "features", "InProcessAppsPanel.tsx"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const calls = [];
  const state = [];
  let hook = 0;
  const jsx = (type, props) => ({ type, props });
  const client = { apps: {
    list: async () => ({ modules: [
      { id: "paseo", operations: ["inspect"] },
      { id: "cpa", operations: ["inspect"] },
      { id: "anneal", operations: ["inspect"] },
      { id: "agent-orchestrator", operations: ["inspect"] },
      { id: "codex-router", operations: ["inspect"] },
      { id: "commandcode-proxy", operations: ["inspect"] },
    ] }),
    call: async (args) => { calls.push(["call", args]); return {}; },
    invoke: async (args) => { calls.push(["invoke", args]); return {}; },
  } };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => name === "react"
      ? {
          useState: (initial) => {
            const index = hook++;
            if (!(index in state)) state[index] = initial;
            return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
          },
          useMemo: (compute) => compute(),
          useEffect: () => {},
        }
      : name === "react/jsx-runtime"
        ? { jsx, jsxs: jsx }
        : name === "../api/client"
          ? { getCodingToolsClient: () => client }
          : {},
  });
  const render = () => {
    hook = 0;
    return exports.InProcessAppsPanel({
      copy: { inProcessApps: "Apps", refreshTools: "Refresh", inProcessAppsCall: "Call", inProcessAppsInvoke: "Invoke" },
      language: "en",
      setError: () => {},
    });
  };
  const nodes = (tree, type) => {
    if (!tree || typeof tree !== "object") return [];
    const children = [tree.props?.children].flat(Infinity);
    return [...(tree.type === type ? [tree] : []), ...children.flatMap((child) => nodes(child, type))];
  };
  nodes(render(), "button")[0].props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const tree = render();
  assert.deepEqual(Array.from(nodes(tree, "li"), (item) => item.props.children[1].props.children), ["cpa", "agent-orchestrator"]);
  assert.deepEqual(Array.from(nodes(tree, "option"), (item) => item.props.value).slice(0, 2), ["cpa", "agent-orchestrator"]);

  state[1] = "paseo"; // A selection held by an event handler during an async catalog refresh.
  const stale = render();
  await nodes(stale, "button")[1].props.onClick();
  await nodes(stale, "button")[2].props.onClick();
  assert.equal(calls.length, 0);

  state[1] = "cpa";
  const current = render();
  await nodes(current, "button")[1].props.onClick();
  await nodes(current, "button")[2].props.onClick();
  assert.deepEqual(calls.map(([mode, args]) => [mode, args.moduleId ?? args.handle]), [["call", "cpa"], ["invoke", "cpa"]]);
});

test("AO is the sole Runtime orchestrator and lets workers pick an AO harness", () => {
  // The Runtime entry is named Chat and sits first in the sidebar, then its saved teams, its subagents and Native Codex.
  assert.match(appSource, /<nav className="sidebar-nav"[^>]*>\s*<SidebarGroup label=\{copy\.runtime\}>\s*<SidebarItem active=\{surface === "agent-orchestrator"\}/);
  assert.match(appSource, /label="Chat" onClick=\{\(\) => navigateSurface\("agent-orchestrator"\)\} \/>\s*<SidebarItem active=\{surface === "agent-orchestrator-teams"\}[^\n]*label="Orchestrator Team"[^\n]*\/>\s*<SidebarItem active=\{surface === "subagents"\}[^\n]*label="Subagents"[^\n]*\/>\s*<SidebarItem active=\{surface === "native-codex"\}/);
  assert.doesNotMatch(appSource, /label=\{copy\.structuredOrchestrator\}|surface === "orchestrator"|surface === "paseo"|navigateSurface\("paseo"\)/);
  assert.match(appSource, /setError\(`\$\{next\} is retired and unavailable\.`\)/);
  assert.match(aoSource, /moduleCall\("harnesses"\)/);
  assert.match(aoSource, /<HarnessPicker route=\{workerRouteDraft\}/);
});

test("retired standalone surfaces cannot navigate or start from Integrations", () => {
  assert.match(appSource, /\["paseo", "anneal", "codex-router", "commandcode-proxy"\]\.includes\(next\)/);
  assert.doesNotMatch(appSource, /<AnnealTasksSurface|toolId="anneal"|navigateSurface\("anneal"\)/);
  assert.match(servicesSource, /serviceRows = services\.services\.filter\(\(service\) => service\.id === "cpa"\)/);
  assert.doesNotMatch(servicesSource, /reconcileManagedBootstrap|openPaseo|openAnneal/);
  assert.match(appSource, /<McpSurface|<AgentOrchestratorSurface|toolId="cpa"/);
  assert.match(servicesSource, /CommandCode login is available in CPA Accounts/);
});

test("the Proxy page offers no retired standalone modules", () => {
  // Nova's proxies are used by every route; the page has no per-profile scope picker any more.
  assert.doesNotMatch(proxySource, /"paseo"|"anneal"/);
  assert.doesNotMatch(proxySource, /const SCOPES/);
});

test("embedded ChatGPT is measured only after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("native clicks reach browser tabs instead of the window drag region", () => {
  assert.match(appSource, /draggable=\{surface !== "browser"\}/);
  assert.match(appSource, /className=\{`app-titlebar\$\{draggable \? " draggable" : ""\}`\}/);
  assert.match(stylesSource, /\.browser-tab\s*\{[^}]*-webkit-app-region:\s*no-drag;/s);
  assert.match(appSource, /className="browser-tab-drag draggable"/);
});

test("renderer zoom scales the shell without moving or zooming the native ChatGPT surface", () => {
  assert.match(
    electronMain,
    /browserHost\?\.setBounds\(validateBounds\(bounds\), event\.sender\.getZoomFactor\(\)\)/,
  );
  assert.match(browserHostSource, /this\.bindShellZoomShortcuts\(this\.window\.webContents\)/);
  assert.match(browserHostSource, /contents\.setZoomLevel\(next\)/);
  assert.match(appSource, /api!\.zoomBrowser\(action\)/);
});

test("closing the launcher follows the persisted background-runtime preference", () => {
  assert.match(
    electronMain,
    /if \(stateStore\.read\(\)\.keepRunningOnClose && tray\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(appSource, /setPreference\("keepRunningOnClose", checked\)/);
});

test("a foreground launch request survives hidden startup until the launcher window is ready", () => {
  const showMainWindow = electronMain.slice(
    electronMain.indexOf("function showMainWindow()"),
    electronMain.indexOf("async function openWebUrl"),
  );
  assert.match(
    showMainWindow,
    /mainWindowShowRequested = true;[\s\S]*?!mainWindowReadyToShow[\s\S]*?mainWindowShowRequested = false;/,
  );

  const readyHandler = electronMain.slice(
    electronMain.indexOf('window.once("ready-to-show"'),
    electronMain.indexOf("trackWindowState(window", electronMain.indexOf('window.once("ready-to-show"')),
  );
  assert.match(
    readyHandler,
    /mainWindowReadyToShow = true;[\s\S]*?if \(mainWindowShowRequested\) showMainWindow\(\);/,
  );

  const secondInstance = electronMain.indexOf('app.on("second-instance",');
  const secondInstanceEnd = electronMain.indexOf("\n  });", secondInstance);
  const runtimeMaterialization = electronMain.indexOf("await waitForPackagedRuntimeSource", secondInstance);
  assert.ok(secondInstance >= 0, "the second-instance foreground request must be registered");
  assert.ok(secondInstanceEnd > secondInstance, "the second-instance handler must be complete");
  assert.match(electronMain.slice(secondInstance, secondInstanceEnd), /showMainWindow\(\);/);
  assert.ok(
    runtimeMaterialization > secondInstance,
    "the foreground request must be registered before packaged-runtime startup can block window creation",
  );
});

test("normal shutdown persists the ChatGPT session before closing browser views", () => {
  assert.match(
    electronMain,
    /runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/,
  );
  // The save is an awaited quit step with a generous deadline (a hung save must not keep the app
  // running forever), and the views close only after it.
  const persist = electronMain.indexOf('await step("browser-session", () => browserHost?.persistSession(), 30_000)');
  const destroy = electronMain.indexOf("browserHost?.destroy()", persist);
  assert.ok(persist >= 0, "shutdown must persist the ChatGPT session");
  assert.ok(destroy > persist, "browser views must close only after session persistence completes");
});

test("packaged runtime is verified before launcher browser surfaces can bind ports", () => {
  const start = electronMain.indexOf("async function start()");
  const runtimeValidation = electronMain.indexOf("installedRuntimeRoot = runtimeRootProvider();", start);
  const cdpPortAllocation = electronMain.indexOf("cdpPort = await findFreePort();", start);
  const windowCreation = electronMain.indexOf("mainWindow = createWindow({", start);
  const controlServerStart = electronMain.indexOf("browserControl = await new BrowserControlServer({", start);
  const browserReady = electronMain.indexOf("await browserHost.ready();", start);

  assert.ok(runtimeValidation > start, "startup must eagerly verify the packaged runtime");
  for (const [surface, position] of [
    ["CDP port allocation", cdpPortAllocation],
    ["launcher window", windowCreation],
    ["browser control server", controlServerStart],
    ["embedded browser", browserReady],
  ]) {
    assert.ok(position > runtimeValidation, `${surface} must start only after runtime verification`);
  }
});

test("DEV launcher exposes its profile and supervises only its Full-mode MCP runtime", () => {
  assert.match(electronMain, /profile:\s*LAUNCHER_PROFILE\.kind/);
  assert.match(electronMain, /if \(IS_DEV_PROFILE\) \{[\s\S]*?config\?\.mode === "full"[\s\S]*?runtimeSupervisor\.startIfConfigured\(\)[\s\S]*?\} else runtimeStartupInFlight = \(async \(\) => \{/);
  assert.match(electronMain, /await runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/);
  assert.match(electronMain, /packaged:\s*app\.isPackaged && !IS_DEV_PROFILE/);
  assert.match(electronMain, /IS_DEV_PROFILE && !stateStore\.read\(\)\.onboardingComplete/);
  assert.match(electronMain, /onboardingComplete:\s*true,[\s\S]*?autoStart:\s*false/);
  assert.match(appSource, /snapshot\.profile === "development"/);
  assert.match(appSource, /data-profile=\{snapshot\.profile\}/);
  assert.match(appSource, /manualBiggerContextUnavailable[\s\S]*?copy\.biggerContextBody/);
  assert.match(appSource, /api!\.setBiggerContext\(enabled\)/);
  assert.match(electronMain, /runtimeHost\.setBiggerContext\(enabled === true\)/);
  assert.doesNotMatch(electronMain, /IS_DEV_PROFILE && key === "experimentalBiggerContext"/);
});

test("Save chats in ChatGPT is one settings toggle wired through the runtime setup", () => {
  assert.match(appSource, /label=\{copy\.savedChats\}[\s\S]*?checked=\{snapshot\.state\.useSavedChats !== false\}[\s\S]*?onChange=\{\(checked\) => void setUseSavedChats\(checked\)\}/);
  assert.match(appSource, /updateState\(await api!\.setUseSavedChats\(enabled\)\)/);
  assert.match(preloadSource, /setUseSavedChats:[\s\S]*?launcher:use-saved-chats/);
  assert.match(electronMain, /handle\("launcher:use-saved-chats"[\s\S]*?runtimeHost\.setUseSavedChats\(enabled === true\)/);
  // The host follows the runtime's own setting, which is on unless explicitly turned off.
  assert.match(electronMain, /getUseSavedChats:[\s\S]*?config\?\.useSavedChats !== false/);
  // English, Simplified Chinese and Japanese; Traditional Chinese overrides live in its locale file.
  assert.equal(i18nSource.match(/^ {2}savedChatsBody: "/gm)?.length, 3);
  const zhTw = fs.readFileSync(path.join(launcherRoot, "src", "i18n", "locales", "zh-TW.ts"), "utf8");
  assert.match(zhTw, /^ {2}savedChatsBody: "/m);
  // The hint must say where the chats go and why Temporary Chat is not the default.
  assert.match(i18nSource, /savedChatsBody: "[^"]*ChatGPT history[^"]*memory and custom instructions[^"]*Temporary Chat[^"]*tools/);
});

test("macOS passkey sign-in is additive to the unchanged embedded login action", () => {
  assert.match(appSource, /onAction=\{openLogin\}/);
  assert.match(appSource, /<BrowserSurface[\s\S]*?operation=\{operation\}[\s\S]*?platform=\{snapshot\.platform\}/);
  assert.match(appSource, /const passkeyAvailable = !manualInteraction[\s\S]*?platform === "darwin"[\s\S]*?browser\?\.authenticated !== true/);
  assert.match(appSource, /\{passkeyAvailable \? \([\s\S]*?className="toolbar-text-button"[\s\S]*?copy\.passkeySignIn/);
  assert.match(appSource, /className="browser-empty-actions"[\s\S]*?copy\.passkeySignIn/);
  assert.match(appSource, /passkeyWaiting \? continuePasskeyLogin : openPasskeyLogin/);
  assert.match(preloadSource, /openPasskeyLogin:[\s\S]*?launcher:browser-passkey-login/);
  assert.match(preloadSource, /continuePasskeyLogin:[\s\S]*?launcher:browser-passkey-login-continue/);
  assert.match(electronMain, /launcher:browser-passkey-login[\s\S]*?browserHost\.openPasskeyLogin\(\)/);
  assert.match(electronMain, /loginWithPasskey: \(\) => runtimeHost\.capturePasskeyLogin\(\)/);
  assert.match(browserHostSource, /await this\.waitForAuthenticated\(60_000\)[\s\S]*?runSessionInspection\(false\)/);
});

test("Bigger Context stays in Settings without opening a startup recommendation", () => {
  assert.match(
    appSource,
    /const \[biggerContextRecommendationOpen, setBiggerContextRecommendationOpen\] = useState\(false\);/,
  );
  assert.match(appSource, /label=\{copy\.biggerContext\}[\s\S]*?onChange=\{\(checked\) => void setBiggerContext\(checked\)\}/);
  assert.match(appSource, /updateState\(await api!\.setBiggerContext\(enabled\)\)/);
  // While it applies (waiting for WebGPT turns, then a bridge restart), the switch shows the asked-for
  // position and the row says what it waits on; it sat at the old position and read as refused.
  assert.match(appSource, /checked=\{biggerPending \?\? snapshot\.state\.experimentalBiggerContext\}/);
  assert.match(appSource, /setBiggerPending\(enabled\);[\s\S]*?finally \{\s*setBiggerPending\(null\);/);
  assert.match(appSource, /operation\?\.name === "bigger-context" && operation\.status === "running"/);
  assert.match(appSource, /: biggerProgress \|\| copy\.biggerContextBody\}/);
  assert.match(
    appSource,
    /<BiggerContextRecommendation[\s\S]*?checked=\{snapshot\.state\.experimentalBiggerContext\}[\s\S]*?onClose=\{\(\) => setBiggerContextRecommendationOpen\(false\)\}/,
  );
  assert.match(appSource, /<Switch checked=\{checked\} disabled=\{busy\} onChange=\{onChange\} \/>/);
  assert.match(stylesSource, /\.bigger-context-recommendation-backdrop\s*\{[^}]*position:\s*fixed;/s);
  assert.doesNotMatch(stylesSource, /\.bigger-context-recommendation-backdrop\s*\{[^}]*backdrop-filter:/s);
});

test("Zero Risk setup commits state after the runtime transaction and preserves manual inspection boundaries", () => {
  const modeSwitchHandler = electronMain.slice(
    electronMain.indexOf('handle("launcher:browser-interaction-mode"'),
    electronMain.indexOf('handle("launcher:set-preference"'),
  );
  const modeTransaction = modeSwitchHandler.indexOf("await browserHost.withInteractionModeChange(");
  const runtimeModeCommit = modeSwitchHandler.indexOf("runtimeHost.setBrowserInteractionMode(mode, afterRuntimeReady)");
  const stateModeCommit = modeSwitchHandler.indexOf("const state = stateStore.update({");
  assert.ok(modeTransaction >= 0 && modeTransaction < runtimeModeCommit);
  assert.ok(runtimeModeCommit < stateModeCommit);

  const mcpSetupHandler = electronMain.slice(
    electronMain.indexOf('handle("launcher:setup-mcp"'),
    electronMain.indexOf('handle("launcher:set-mcp-step"'),
  );
  const runtimeMcpCommit = mcpSetupHandler.indexOf("const runSetup = afterRuntimeReady => setup({");
  const mcpTransaction = mcpSetupHandler.indexOf("await browserHost.withInteractionModeChange(interactionMode, runSetup)");
  const stateMcpCommit = mcpSetupHandler.indexOf("const state = stateStore.update({");
  assert.ok(runtimeMcpCommit >= 0 && runtimeMcpCommit < mcpTransaction);
  assert.ok(mcpTransaction < stateMcpCommit);
  assert.match(browserHostSource, /bindManualTurnContents\(tab\)/);
  // The method itself, up to the next one (the call site comes first in the file).
  const manualBindingStart = browserHostSource.indexOf("  bindManualTurnContents(tab) {");
  const manualBindingEnd = browserHostSource.indexOf("  bindWebContents(", manualBindingStart);
  assert.ok(manualBindingStart >= 0 && manualBindingEnd > manualBindingStart);
  const manualBinding = browserHostSource.slice(manualBindingStart, manualBindingEnd);
  assert.doesNotMatch(manualBinding, /executeJavaScript|insertCSS|querySelector|runBrowserHelperOperation|enableDeviceEmulation/);
  assert.match(browserHostSource, /requireAutomaticBrowserInspection\(this, "ChatGPT authentication probe"\)/);
  assert.match(browserHostSource, /requireAutomaticBrowserInspection\(this, "ChatGPT session and capability inspection"\)/);
  assert.match(browserHostSource, /browserInteractionModeFor\(this\) === "manual"\) return;[\s\S]*?applyViewportCss\(\)/);
  assert.match(
    browserHostSource,
    /page-title-updated[\s\S]*?browserInteractionModeFor\(this\) === "manual"\) return;/,
  );
  assert.doesNotMatch(modeSwitchHandler, /const pending = stateStore\.update|catch \(error\)/);
  assert.match(electronMain, /browserInteractionMode === "manual"[\s\S]*?Local Zero Risk runtime is healthy/);

});

test("MCP connection remains unavailable until the model catalog is verified", () => {
  assert.match(
    appSource,
    /manualInteraction \|\| configuringInactiveMode \|\| snapshot\.state\.codexCatalogVerified[\s\S]*?copy\.mcpStepTwoHint[\s\S]*?copy\.mcpCatalogRequired/,
  );
  assert.match(appSource, /!manualInteraction && !configuringInactiveMode && !snapshot\.state\.codexCatalogVerified/);
});

test("MCP navigation remains locked while an operation is active", () => {
  assert.match(appSource, /<McpSurface[\s\S]*?operation=\{operation\}/);
  assert.match(appSource, /const busy = localBusy \|\| operation\?\.status === "running"/);
  assert.match(appSource, /const safeMove = async \(next: number\) => \{\s*if \(busy\) return;/);
  assert.match(appSource, /disabled=\{busy \|\| index > step\}/);
});

test("failed doctor reports retain every failed check", () => {
  assert.match(
    appSource,
    /report\.ok\s*\?\s*report\.checks\.slice\(-6\)\s*:\s*report\.checks\.filter\(\(check\) => check\.status !== "ok"\)/,
  );
  assert.match(appSource, /visibleChecks\.map\(\(check\) =>/);
});

test("launcher shares only privacy-safe exported diagnostics", () => {
  assert.match(appSource, /api!\.exportLogs\(\)/);
  assert.match(preloadSource, /exportLogs:[\s\S]*?launcher:export-logs/);
  assert.match(electronMain, /launcher:export-logs[\s\S]*?showSaveDialog[\s\S]*?exportSanitizedLogs/);
  assert.doesNotMatch(preloadSource, /launcher:open-logs/);
  assert.doesNotMatch(electronMain, /launcher:open-logs/);
});

test("MCP verification failures stay inside the structured setup report", () => {
  assert.match(appSource, /next\.operation\.name !== "mcp-verification"/);
  assert.match(appSource, /next\.name !== "mcp-verification"/);
  assert.match(electronMain, /Finish the active Codex task before verifying the ChatGPT connector/);
  assert.match(electronMain, /report\.checks\.filter\(\(check\) => check\.id !== "connector"\)/);
  assert.match(electronMain, /mcp\.verification_requested/);
  assert.match(electronMain, /launcherFocused:\s*mainWindow\?\.isFocused\(\) === true/);
  const focusExpression = electronMain.match(/rendererFocused:\s*([^,\r\n]+)/)?.[1];
  assert.ok(focusExpression, "verification must log the renderer focus state");
  const vm = require("node:vm");
  for (const [event, expected] of [
    [undefined, false],
    [{ sender: {} }, false],
    [{ sender: { isFocused: () => false } }, false],
    [{ sender: { isFocused: () => true } }, true],
    [{ sender: { isFocused: () => 1 } }, false],
  ]) {
    assert.equal(vm.runInNewContext(focusExpression, { event }), expected);
  }
});

test("MCP verification proves runtime health before checking the connector", async () => {
  const start = electronMain.indexOf("const performMcpVerification = async (event) => {");
  const end = electronMain.indexOf("  verifyMcpConnection = (event) => {", start);
  const handler = electronMain.slice(start, end);

  assert.ok(start >= 0 && end > start, "MCP verification handler must remain registered");
  assert.match(electronMain, /handle\("launcher:mcp-verify", event => verifyMcpConnection\(event\)\)/);
  const vm = require("node:vm");
  for (const dev of [false, true]) {
    for (const healthy of [false, true]) {
      const steps = [];
      const report = { ok: healthy, checks: [] };
      const state = { browserInteractionMode: "automatic" };
      const context = {
        IS_DEV_PROFILE: dev,
        mainWindow: null,
        browserHost: {
          activeTraceId: null,
          verifyConnector: async () => { steps.push("connector"); },
        },
        runtimeHost: {
          devDoctor: async () => { steps.push("devDoctor"); return report; },
          doctor: async () => { steps.push("doctor"); return report; },
          mcpConnectorName: () => "test connector",
        },
        stateStore: { read: () => state, update: () => state },
        logger: { info() {} },
        publishOperation() {},
        send() {},
      };
      vm.runInNewContext(handler + "\nthis.verify = performMcpVerification;", context);
      const result = await context.verify();
      assert.deepEqual(steps, healthy
        ? [dev ? "devDoctor" : "doctor", "connector"]
        : [dev ? "devDoctor" : "doctor"]);
      assert.equal(result.ok, healthy);
    }
  }
  assert.match(appSource, /operation\?\.name === "mcp-verification"/);
});

test("saved ChatGPT authentication is refreshed before setup is presented", () => {
  assert.match(electronMain, /browserHost\.refreshAuthentication\(\)/);
  const productionStartup = electronMain.indexOf("} else runtimeStartupInFlight = (async () => {");
  const refreshBarrier = electronMain.indexOf("await startupAuthenticationRefresh", productionStartup);
  const upgrade = electronMain.indexOf("runtimeHost.upgradeManagedRuntime()", productionStartup);
  const runtimeStart = electronMain.indexOf("runtimeSupervisor.startIfConfigured()", upgrade);
  const browserGate = electronMain.indexOf("browser?.authenticated !== true", runtimeStart);
  const bridgeConnect = electronMain.indexOf("connectCodexBridgeAfterAuthentication({ logger, stateStore, reason: \"startup\" })", runtimeStart);
  assert.ok(refreshBarrier > productionStartup, "production startup must wait for saved-session refresh");
  assert.ok(upgrade > refreshBarrier, "runtime upgrade must not inspect the browser before refresh settles");
  assert.ok(runtimeStart > upgrade, "configured runtime must start after any upgrade");
  assert.ok(browserGate > runtimeStart, "startup must check saved browser authentication after runtime health");
  assert.ok(bridgeConnect > browserGate, "Codex route must wait for authenticated browser evidence");
  assert.match(appSource, /browser\?\.status === "loading" \? copy\.checkingSignIn/);
});

test("completed model setup remains a repeatable capability probe", () => {
  assert.match(appSource, /<SetupRow[\s\S]*?onAction=\{install\}[\s\S]*?repeatable/);
  assert.match(appSource, /complete && !repeatable/);
  assert.match(
    electronMain,
    /!setupState\.coreSetupComplete[\s\S]*?smokePassedThisSession[\s\S]*?smokePassedForCurrentVersion\(setupState\)/,
  );
});

test("catalog verification reports a failed request instead of requesting another restart, then recovers", async () => {
  const vm = require("node:vm");
  const start = electronMain.indexOf("function startCatalogVerificationMonitor(");
  const end = electronMain.indexOf("\nfunction ", start + 1);
  const source = electronMain.slice(start, end);
  const state = { coreSetupComplete: true, codexCatalogVerified: false, codexRestartRequired: true, language: "en" };
  const operations = [];
  const events = [];
  let tick;
  let payload = { pid: 10, successful_model_catalog_requests: 0, model_catalog_requests: 0, last_model_catalog_result: null };
  const context = {
    catalogVerificationInFlight: false, catalogVerificationTimer: null, lastOperation: null,
    stopCatalogVerificationMonitor() {},
    // A timer must not read the config synchronously (it froze the app for seconds on a busy disk).
    runtimeSupervisor: { readConfig: () => { throw new Error("the monitor read config.json synchronously"); },
      readConfigAsync: async () => ({}), proxyHealthPayload: async () => payload },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    setInterval: callback => { tick = callback; return { unref() {} }; },
    logger: { info: (...args) => events.push(args), warn: (...args) => events.push(args), debug() {} },
    // Like the real publishOperation, the last one published is what a renderer load re-reads.
    send() {}, publishOperation: op => { operations.push(op); context.lastOperation = op; },
    nativeCopyFor: () => ({ catalogFailure: "Catalog failed (HTTP {status}; {reason})." }),
  };
  vm.runInNewContext(source + "\nstartCatalogVerificationMonitor({ logger, stateStore });", context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 0);
  assert.equal(state.codexRestartRequired, true);
  payload = { ...payload, model_catalog_requests: 1, last_model_catalog_result: {
    request: 1, at: "2026-09-16T10:00:00Z", status: 502, failure: { stage: "transport", code: "UnsupportedProxyProtocol" },
  } };
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, false);
  assert.equal(operations[0]?.status, "failed");
  assert.match(operations[0].message, /502.*UnsupportedProxyProtocol/);
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 1, "polling must not repeat the same failure");
  payload = { ...payload, successful_model_catalog_requests: 1, last_successful_model_catalog_request_at: "2026-09-16T10:01:00Z" };
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.codexCatalogVerified, true);
  assert.equal(state.codexRestartRequired, false);
  assert.ok(events.some(([event]) => event === "codex.model_catalog_verified"));
  // The recovery replaces the earlier failure, so a renderer load no longer re-raises it.
  assert.equal(operations.length, 2);
  assert.equal(context.lastOperation.name, "catalog-verification");
  assert.equal(context.lastOperation.status, "completed");
});

test("a completed operation clears only the error its own earlier failure raised", () => {
  assert.match(
    appSource,
    /next\.status === "completed" && previous\?\.status === "failed" && previous\.name === next\.name\)[\s\S]{0,80}setError\(\(current\) => \(current === previous\.message \? null : current\)\)/,
  );
  assert.match(appSource, /lastOperationRef\.current = next\.operation \?\? null/);
});

test("settings expose an opt-in existing MCP auto-connect without provisioning credentials", () => {
  assert.match(typesSource, /autoConnectExistingMcp:\s*boolean/);
  assert.match(
    typesSource,
    /key:\s*"keepRunningOnClose"\s*\|\s*"showBrowserDuringTurns"\s*\|\s*"autoConnectExistingMcp"/,
  );
  assert.match(
    appSource,
    /body=\{copy\.autoConnectExistingMcpBody\}[\s\S]*?label=\{copy\.autoConnectExistingMcp\}[\s\S]*?checked=\{snapshot\.state\.autoConnectExistingMcp\}/,
  );
  assert.match(
    appSource,
    /disabled=\{snapshot\.state\.browserInteractionMode !== "automatic"[\s\S]*?snapshot\.state\.mcpRuntimeInstalled !== true[\s\S]*?!snapshot\.mcpCredentialsConfigured\}/,
  );
  assert.match(
    appSource,
    /api!\.setPreference\("autoConnectExistingMcp", checked\)/,
  );
  assert.match(
    i18nSource,
    /autoConnectExistingMcp:\s*"Auto-connect existing MCP harness"/,
  );
  assert.match(
    i18nSource,
    /autoConnectExistingMcpBody:\s*"After Codex reaches the ready bridge, verify and connect the saved MCP harness\. This never creates a connector, tunnel, or key\."/,
  );
});
