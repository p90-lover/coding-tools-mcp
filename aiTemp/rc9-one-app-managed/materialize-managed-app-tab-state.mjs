import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd());

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function write(relative, value) {
  fs.writeFileSync(path.join(root, relative), value, "utf8");
  process.stdout.write(`patched ${relative}\n`);
}

function replaceOnce(relative, oldValue, newValue, sentinel = newValue) {
  const current = read(relative);
  if (current.includes(sentinel)) {
    process.stdout.write(`already patched ${relative}\n`);
    return;
  }
  const count = current.split(oldValue).length - 1;
  if (count !== 1) {
    throw new Error(`Expected one anchor in ${relative}, found ${count}: ${oldValue.slice(0, 140)}`);
  }
  write(relative, current.replace(oldValue, newValue));
}

function replaceAllExact(relative, oldValue, newValue, expected) {
  const current = read(relative);
  if (current.includes(newValue) && !current.includes(oldValue)) {
    process.stdout.write(`already patched ${relative}\n`);
    return;
  }
  const count = current.split(oldValue).length - 1;
  if (count !== expected) {
    throw new Error(`Expected ${expected} anchors in ${relative}, found ${count}: ${oldValue.slice(0, 140)}`);
  }
  write(relative, current.split(oldValue).join(newValue));
}

replaceOnce(
  "desktop-electron/electron/state.cjs",
  'const SESSION_REFRESH_REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000;\n',
  `const SESSION_REFRESH_REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000;
const MANAGED_APP_TAB_SET = new Set([
  "cpa",
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);
`,
  'const MANAGED_APP_TAB_SET = new Set([',
);

replaceOnce(
  "desktop-electron/electron/state.cjs",
  '  sidebarOpen: true,\n  sidebarWidth: 252,\n  mcpGuideStep: 0,',
  '  sidebarOpen: true,\n  sidebarWidth: 252,\n  managedAppTab: "cpa",\n  mcpGuideStep: 0,',
  'managedAppTab: "cpa"',
);

replaceOnce(
  "desktop-electron/electron/state.cjs",
  `    if (state.language !== null && state.language !== "en" && state.language !== "zh-CN" && state.language !== "zh-TW" && state.language !== "ja") {
      state.language = DEFAULT_STATE.language;
    }
`,
  `    if (state.language !== null && state.language !== "en" && state.language !== "zh-CN" && state.language !== "zh-TW" && state.language !== "ja") {
      state.language = DEFAULT_STATE.language;
    }
    if (!MANAGED_APP_TAB_SET.has(state.managedAppTab)) {
      state.managedAppTab = DEFAULT_STATE.managedAppTab;
    }
`,
  'if (!MANAGED_APP_TAB_SET.has(state.managedAppTab))',
);

replaceOnce(
  "desktop-electron/electron/state.cjs",
  `function validateSidebarState(value) {
`,
  `function validateManagedAppTab(value) {
  if (typeof value !== "string" || !MANAGED_APP_TAB_SET.has(value)) {
    throw new Error("Managed app tab is invalid");
  }
  return value;
}

function validateSidebarState(value) {
`,
  'function validateManagedAppTab(value)',
);

replaceOnce(
  "desktop-electron/electron/state.cjs",
  '  nextSessionRefreshReminderAt,\n  validateSidebarState,',
  '  nextSessionRefreshReminderAt,\n  validateManagedAppTab,\n  validateSidebarState,',
  '  validateManagedAppTab,\n  validateSidebarState,',
);

replaceOnce(
  "desktop-electron/electron/main.cjs",
  `  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
`,
  `  createStateStore,
  nextSessionRefreshReminderAt,
  validateManagedAppTab,
  validateSidebarState,
`,
  '  validateManagedAppTab,\n  validateSidebarState,',
);

replaceOnce(
  "desktop-electron/electron/main.cjs",
  '  handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));\n  handle("launcher:logs",',
  `  handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));
  handle("launcher:managed-app-tab", (event, tab) => {
    assertFocusedMainWindow(event, true);
    const state = stateStore.update({ managedAppTab: validateManagedAppTab(tab) });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:logs",`,
  'handle("launcher:managed-app-tab"',
);

replaceOnce(
  "desktop-electron/electron/preload.cjs",
  '  setSidebarState: (state) => ipcRenderer.invoke("launcher:sidebar-state", state),\n  externalServicesSnapshot:',
  '  setSidebarState: (state) => ipcRenderer.invoke("launcher:sidebar-state", state),\n  setManagedAppTab: (tab) => ipcRenderer.invoke("launcher:managed-app-tab", tab),\n  externalServicesSnapshot:',
  'setManagedAppTab: (tab) => ipcRenderer.invoke("launcher:managed-app-tab", tab)',
);

replaceOnce(
  "desktop-electron/src/types.ts",
  'export type Surface = "browser" | "setup" | "mcp" | "apps" | "providers" | "integrations" | "paseo" | "anneal" | "network" | "activity" | "settings";\n',
  `export type Surface = "browser" | "setup" | "mcp" | "apps" | "providers" | "integrations" | "paseo" | "anneal" | "network" | "activity" | "settings";
export type ManagedAppTabId = "cpa" | "codex-router" | "commandcode-proxy" | "paseo" | "anneal";
`,
  'export type ManagedAppTabId =',
);

replaceOnce(
  "desktop-electron/src/types.ts",
  '  sidebarOpen: boolean;\n  sidebarWidth: number;\n  browserSmokePassed?:',
  '  sidebarOpen: boolean;\n  sidebarWidth: number;\n  managedAppTab: ManagedAppTabId;\n  browserSmokePassed?:',
  '  managedAppTab: ManagedAppTabId;',
);

replaceOnce(
  "desktop-electron/src/types.ts",
  '  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;\n  externalServicesSnapshot():',
  '  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;\n  setManagedAppTab(tab: ManagedAppTabId): Promise<LauncherState>;\n  externalServicesSnapshot():',
  'setManagedAppTab(tab: ManagedAppTabId): Promise<LauncherState>',
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  'import type { ExternalServiceId, ExternalServicesSnapshot, Language } from "../types";',
  'import type { ExternalServiceId, ExternalServicesSnapshot, Language, ManagedAppTabId } from "../types";',
  'Language, ManagedAppTabId',
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `export type ManagedAppTabId =
  | "cpa"
  | "codex-router"
  | "commandcode-proxy"
  | "paseo"
  | "anneal";

`,
  '',
  'interface ManagedAppsSurfaceProps {',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  'import { ManagedAppsSurface, type ManagedAppTabId } from "./features/ManagedAppsSurface";',
  'import { ManagedAppsSurface } from "./features/ManagedAppsSurface";',
  'import { ManagedAppsSurface } from "./features/ManagedAppsSurface";',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  '  LauncherState,\n  LogRecord,',
  '  LauncherState,\n  ManagedAppTabId,\n  LogRecord,',
  '  ManagedAppTabId,\n  LogRecord,',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  '  const [managedAppTab, setManagedAppTab] = useState<ManagedAppTabId>("cpa");',
  '  const [managedAppTab, setManagedAppTabState] = useState<ManagedAppTabId>(snapshot.state.managedAppTab);',
  'setManagedAppTabState] = useState<ManagedAppTabId>(snapshot.state.managedAppTab)',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  `  const selectedManualTab = browser?.tabs.find(tab => tab.active && tab.interactionMode === "manual");

  useEffect(() => {
`,
  `  const selectedManualTab = browser?.tabs.find(tab => tab.active && tab.interactionMode === "manual");
  const selectManagedAppTab = useCallback((tab: ManagedAppTabId) => {
    setManagedAppTabState(tab);
    void api!.setManagedAppTab(tab)
      .then(updateState)
      .catch((cause) => {
        setManagedAppTabState(snapshot.state.managedAppTab);
        setError(messageOf(cause));
      });
  }, [setError, snapshot.state.managedAppTab, updateState]);

  useEffect(() => {
    setManagedAppTabState(snapshot.state.managedAppTab);
  }, [snapshot.state.managedAppTab]);

  useEffect(() => {
`,
  'const selectManagedAppTab = useCallback((tab: ManagedAppTabId)',
);

replaceAllExact(
  "desktop-electron/src/App.tsx",
  'setManagedAppTab("',
  'selectManagedAppTab("',
  3,
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  'onSelectedTabChange={setManagedAppTab}',
  'onSelectedTabChange={selectManagedAppTab}',
  'onSelectedTabChange={selectManagedAppTab}',
);

replaceAllExact(
  "desktop-electron/tests/state.test.cjs",
  '      autoStart: true,\n      keepRunningOnClose:',
  '      autoStart: true,\n      automaticUpdates: true,\n      keepRunningOnClose:',
  3,
);

replaceAllExact(
  "desktop-electron/tests/state.test.cjs",
  '      sidebarWidth: 252,\n      mcpGuideStep:',
  '      sidebarWidth: 252,\n      managedAppTab: "cpa",\n      mcpGuideStep:',
  3,
);

process.stdout.write("managed app tab state materialization complete\n");
