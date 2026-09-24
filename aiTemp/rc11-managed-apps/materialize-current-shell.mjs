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
    throw new Error(`Expected one anchor in ${relative}, found ${count}: ${oldValue.slice(0, 160)}`);
  }
  write(relative, current.replace(oldValue, newValue));
}

function replaceEvery(relative, oldValue, newValue, minimum = 1) {
  const current = read(relative);
  if (current.includes(newValue) && !current.includes(oldValue)) {
    process.stdout.write(`already patched ${relative}\n`);
    return;
  }
  const count = current.split(oldValue).length - 1;
  if (count < minimum) {
    throw new Error(`Expected at least ${minimum} anchors in ${relative}, found ${count}: ${oldValue.slice(0, 160)}`);
  }
  write(relative, current.split(oldValue).join(newValue));
}

replaceOnce(
  "desktop-electron/src/types.ts",
  'export type Surface = "browser" | "setup" | "mcp" | "providers" | "integrations" | "cpa" | "codex-router" | "paseo" | "anneal" | "network" | "activity" | "settings";\n',
  'export type Surface = "browser" | "setup" | "mcp" | "apps" | "providers" | "integrations" | "cpa" | "codex-router" | "paseo" | "anneal" | "network" | "activity" | "settings";\nexport type ManagedAppTabId = "cpa" | "codex-router" | "commandcode-proxy" | "paseo" | "anneal";\n',
  'export type ManagedAppTabId = "cpa"',
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
  'setManagedAppTab(tab: ManagedAppTabId)',
);

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
  'function validateSidebarState(value) {\n',
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
  'setManagedAppTab: (tab)',
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  `  openCodexRouter: () => void;
  openPaseo: () => void;
  openAnneal: () => void;
}`,
  `  openCodexRouter: () => void;
  openPaseo: () => void;
  openAnneal: () => void;
  preferredServiceId?: ExternalServiceId;
}`,
  'preferredServiceId?: ExternalServiceId;',
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  `  openCodexRouter,
  openPaseo,
  openAnneal,
}: ExternalServicesSurfaceProps) {`,
  `  openCodexRouter,
  openPaseo,
  openAnneal,
  preferredServiceId,
}: ExternalServicesSurfaceProps) {`,
  '  preferredServiceId,\n}: ExternalServicesSurfaceProps)',
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  '  const [selectedId, setSelectedId] = useState<ExternalServiceId>("codex-router");',
  '  const [selectedId, setSelectedId] = useState<ExternalServiceId>(preferredServiceId ?? "codex-router");\n  const effectiveSelectedId = preferredServiceId ?? selectedId;',
  'const effectiveSelectedId = preferredServiceId ?? selectedId;',
);

replaceEvery(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  'service.id === selectedId',
  'service.id === effectiveSelectedId',
  2,
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  `  )), [services, commandCodeAccounts, commandCodeModels]);

  const refresh = async () => {`,
  `  )), [services, commandCodeAccounts, commandCodeModels]);

  useEffect(() => {
    if (preferredServiceId) setSelectedId(preferredServiceId);
  }, [preferredServiceId]);

  const refresh = async () => {`,
  'if (preferredServiceId) setSelectedId(preferredServiceId);',
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  '  }, [api, selectedId, setError]);',
  '  }, [api, effectiveSelectedId, preferredServiceId, selectedId, setError]);',
  '[api, effectiveSelectedId, preferredServiceId, selectedId, setError]',
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  '  }, [selectedId]);',
  '  }, [effectiveSelectedId]);',
  '[effectiveSelectedId]',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  'import { ExternalServicesSurface } from "./features/ExternalServicesSurface";\nimport { OriginalUiSurface } from "./features/OriginalUiSurface";',
  'import { ExternalServicesSurface } from "./features/ExternalServicesSurface";\nimport { ManagedAppsSurface } from "./features/ManagedAppsSurface";\nimport { OriginalUiSurface } from "./features/OriginalUiSurface";',
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
  `  const [surface, setSurface] = useState<Surface>(
    firstRunZeroRiskSetup ? "mcp" : interactionSetupComplete ? "browser" : "setup",
  );
  const devProfile = snapshot.profile === "development";`,
  `  const [surface, setSurface] = useState<Surface>(
    firstRunZeroRiskSetup ? "mcp" : interactionSetupComplete ? "browser" : "setup",
  );
  const [managedAppTab, setManagedAppTabState] = useState<ManagedAppTabId>(snapshot.state.managedAppTab);
  const devProfile = snapshot.profile === "development";`,
  'setManagedAppTabState] = useState<ManagedAppTabId>',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  '  const extraSurfaceActive = surface === "providers"\n',
  '  const extraSurfaceActive = surface === "apps"\n    || surface === "providers"\n',
  'const extraSurfaceActive = surface === "apps"',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  `  const selectedManualTab = browser?.tabs.find(tab => tab.active && tab.interactionMode === "manual");

  useEffect(() => {`,
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

  useEffect(() => {`,
  'const selectManagedAppTab = useCallback((tab: ManagedAppTabId)',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  `                <SidebarItem
                  active={surface === "providers"}
                  icon="providers"
                  label={copy.providers}
                  onClick={() => navigateSurface("providers")}
                />
                <SidebarItem
                  active={surface === "integrations"}
                  icon="globe"
                  label={copy.integrations}
                  onClick={() => navigateSurface("integrations")}
                />
                <SidebarItem
                  active={surface === "cpa"}
                  icon="providers"
                  label="CPA"
                  onClick={() => navigateSurface("cpa")}
                />
                <SidebarItem
                  active={surface === "codex-router"}
                  icon="orchestrator"
                  label="Codex Router"
                  onClick={() => navigateSurface("codex-router")}
                />
                <SidebarItem
                  active={surface === "paseo"}
                  icon="orchestrator"
                  label={language === "zh-TW" ? "Paseo 協調器" : copy.paseoOrchestrator}
                  onClick={() => navigateSurface("paseo")}
                />
                <SidebarItem
                  active={surface === "anneal"}
                  icon="activity"
                  label={language === "zh-TW" ? "Anneal 任務" : copy.annealTasks}
                  onClick={() => navigateSurface("anneal")}
                />`,
  `                <SidebarItem
                  active={surface === "apps"}
                  icon="providers"
                  label={language === "zh-TW" ? "受管理應用程式" : "Managed Apps"}
                  onClick={() => navigateSurface("apps")}
                />`,
  'label={language === "zh-TW" ? "受管理應用程式" : "Managed Apps"}',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  `            {surface === "providers" ? (
              <ProviderCenterSurface language={language} setError={setError} />
            ) : null}`,
  `            {surface === "apps" ? (
              <ManagedAppsSurface
                language={language}
                onSelectedTabChange={selectManagedAppTab}
                selectedTab={managedAppTab}
                setError={setError}
              />
            ) : null}
            {surface === "providers" ? (
              <ProviderCenterSurface language={language} setError={setError} />
            ) : null}`,
  'onSelectedTabChange={selectManagedAppTab}',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  `                openAnneal={() => navigateSurface("anneal")}
                openCpa={() => navigateSurface("cpa")}
                openCodexRouter={() => navigateSurface("codex-router")}
                openPaseo={() => navigateSurface("paseo")}
                openProviders={() => navigateSurface("providers")}`,
  `                openAnneal={() => {
                  selectManagedAppTab("anneal");
                  navigateSurface("apps");
                }}
                openCpa={() => {
                  selectManagedAppTab("cpa");
                  navigateSurface("apps");
                }}
                openCodexRouter={() => {
                  selectManagedAppTab("codex-router");
                  navigateSurface("apps");
                }}
                openPaseo={() => {
                  selectManagedAppTab("paseo");
                  navigateSurface("apps");
                }}
                openProviders={() => {
                  selectManagedAppTab("cpa");
                  navigateSurface("apps");
                }}`,
  'selectManagedAppTab("codex-router")',
);

replaceOnce(
  "desktop-electron/tests/state.test.cjs",
  '  nextSessionRefreshReminderAt,\n  validateSidebarState,',
  '  nextSessionRefreshReminderAt,\n  validateManagedAppTab,\n  validateSidebarState,',
  '  validateManagedAppTab,\n  validateSidebarState,',
);

replaceEvery(
  "desktop-electron/tests/state.test.cjs",
  '      autoStart: true,\n      keepRunningOnClose:',
  '      autoStart: true,\n      automaticUpdates: true,\n      keepRunningOnClose:',
  3,
);

replaceEvery(
  "desktop-electron/tests/state.test.cjs",
  '      sidebarWidth: 252,\n      mcpGuideStep:',
  '      sidebarWidth: 252,\n      managedAppTab: "cpa",\n      mcpGuideStep:',
  3,
);

replaceOnce(
  "desktop-electron/tests/state.test.cjs",
  `test("sidebar state accepts only bounded native shell dimensions", () => {
  assert.deepEqual(validateSidebarState({ open: false, width: 300.4 }), {
    sidebarOpen: false,
    sidebarWidth: 300,
  });
  assert.throws(() => validateSidebarState({ open: "yes", width: 300 }), /invalid/);
  assert.throws(() => validateSidebarState({ open: true, width: 100 }), /between 240 and 420/);
  assert.throws(() => validateSidebarState({ open: true, width: 900 }), /between 240 and 420/);
});
`,
  `test("sidebar state accepts only bounded native shell dimensions", () => {
  assert.deepEqual(validateSidebarState({ open: false, width: 300.4 }), {
    sidebarOpen: false,
    sidebarWidth: 300,
  });
  assert.throws(() => validateSidebarState({ open: "yes", width: 300 }), /invalid/);
  assert.throws(() => validateSidebarState({ open: true, width: 100 }), /between 240 and 420/);
  assert.throws(() => validateSidebarState({ open: true, width: 900 }), /between 240 and 420/);
});

test("managed application tab accepts only the fixed five-stack destinations", () => {
  for (const tab of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.equal(validateManagedAppTab(tab), tab);
  }
  assert.throws(() => validateManagedAppTab("other"), /invalid/);
});
`,
  'test("managed application tab accepts only the fixed five-stack destinations"',
);

process.stdout.write("RC11_MANAGED_APPS_SHELL_MATERIALIZED\n");
