from __future__ import annotations

from pathlib import Path


def replace_once(path: str, before: str, after: str) -> None:
    target = Path(path)
    source = target.read_text(encoding="utf-8")
    if after in source:
        print(f"already applied: {path}")
        return
    if source.count(before) != 1:
        raise SystemExit(
            f"RC7_UPSTREAM_PATCH_ANCHOR_MISMATCH:{path}:count={source.count(before)}:{before[:100]!r}"
        )
    target.write_text(source.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {path}")


def patch_types() -> None:
    type_block = '''export type UpstreamToolId = "anneal" | "paseo";
export type UpstreamToolStatus = "unknown" | "offline" | "starting" | "ready" | "error";

export interface UpstreamToolSnapshot {
  id: UpstreamToolId;
  name: string;
  repository: string;
  commit: string;
  version: string | null;
  license: string;
  sections: string[];
  endpoint: string;
  status: UpstreamToolStatus;
  pid: number | null;
  startedAt: string | null;
  checkedAt: string | null;
  latencyMs: number | null;
  error: string | null;
  sourceConfigured: boolean;
  sourceAvailable: boolean;
}

export interface UpstreamToolsSnapshot {
  version: 1;
  tools: UpstreamToolSnapshot[];
}

export interface UpstreamToolOpenResult {
  tool: UpstreamToolSnapshot;
  section: string;
  url: string;
  embedded: boolean;
}

'''
    replace_once(
        "desktop-electron/src/types.ts",
        "export interface LauncherState {\n",
        type_block + "export interface LauncherState {\n",
    )
    replace_once(
        "desktop-electron/src/types.ts",
        "  operation: OperationState | null;\n  update: UpdateState;\n",
        "  operation: OperationState | null;\n  upstreamTools: UpstreamToolsSnapshot;\n  update: UpdateState;\n",
    )
    replace_once(
        "desktop-electron/src/types.ts",
        "  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;\n  providerSnapshot(): Promise<ProviderNetworkSnapshot>;\n",
        '''  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;
  upstreamToolsSnapshot(): Promise<UpstreamToolsSnapshot>;
  inspectUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  setUpstreamToolEndpoint(toolId: UpstreamToolId, endpoint: string): Promise<UpstreamToolSnapshot>;
  startUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  stopUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  openEmbeddedTool(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
  openUpstreamToolExternal(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
  providerSnapshot(): Promise<ProviderNetworkSnapshot>;
''',
    )


def patch_preload() -> None:
    replace_once(
        "desktop-electron/electron/preload.cjs",
        '''  setSidebarState: (state) => ipcRenderer.invoke("launcher:sidebar-state", state),
  providerSnapshot: () => ipcRenderer.invoke("launcher:provider-snapshot"),
''',
        '''  setSidebarState: (state) => ipcRenderer.invoke("launcher:sidebar-state", state),
  upstreamToolsSnapshot: () => ipcRenderer.invoke("launcher:upstream-tools-snapshot"),
  inspectUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-inspect", toolId),
  setUpstreamToolEndpoint: (toolId, endpoint) => ipcRenderer.invoke(
    "launcher:upstream-tool-endpoint",
    toolId,
    endpoint,
  ),
  startUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-start", toolId),
  stopUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-stop", toolId),
  openEmbeddedTool: (toolId, section) => ipcRenderer.invoke(
    "launcher:upstream-tool-open-embedded",
    toolId,
    section,
  ),
  openUpstreamToolExternal: (toolId, section) => ipcRenderer.invoke(
    "launcher:upstream-tool-open-external",
    toolId,
    section,
  ),
  providerSnapshot: () => ipcRenderer.invoke("launcher:provider-snapshot"),
''',
    )


def patch_main() -> None:
    replace_once(
        "desktop-electron/electron/main.cjs",
        'const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");\n',
        'const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");\nconst { createUpstreamToolController } = require("./upstream-tools.cjs");\n',
    )
    replace_once(
        "desktop-electron/electron/main.cjs",
        "let updateController = null;\n",
        "let updateController = null;\nlet upstreamToolController = null;\n",
    )
    replace_once(
        "desktop-electron/electron/main.cjs",
        '''    operation: lastOperation,
    update: updateController?.getState() ?? { status: "disabled" },
''',
        '''    operation: lastOperation,
    upstreamTools: upstreamToolController?.snapshot() ?? { version: 1, tools: [] },
    update: updateController?.getState() ?? { status: "disabled" },
''',
    )
    replace_once(
        "desktop-electron/electron/main.cjs",
        '''  handle("launcher:open-external", async (_event, url) => {
    if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted");
    await openWebUrl(url);
    return true;
  });

''',
        '''  handle("launcher:open-external", async (_event, url) => {
    if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted");
    await openWebUrl(url);
    return true;
  });

  handle("launcher:upstream-tools-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.snapshot();
  });
  handle("launcher:upstream-tool-inspect", (event, toolId) => {
    assertFocusedMainWindow(event, false);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.inspect(toolId);
  });
  handle("launcher:upstream-tool-endpoint", (event, toolId, endpoint) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.setEndpoint(toolId, endpoint);
  });
  handle("launcher:upstream-tool-start", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.start(toolId);
  });
  handle("launcher:upstream-tool-stop", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.stop(toolId);
  });
  handle("launcher:upstream-tool-open-embedded", (event, toolId, section) => {
    assertFocusedMainWindow(event, false);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.openEmbeddedTool(toolId, section);
  });
  handle("launcher:upstream-tool-open-external", (event, toolId, section) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.openExternalTool(toolId, section);
  });

''',
    )
    replace_once(
        "desktop-electron/electron/main.cjs",
        '''  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;
  headlessHost = new HeadlessHost({
''',
        '''  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;
  upstreamToolController = createUpstreamToolController({
    env: process.env,
    logger,
    openExternal: openWebUrl,
  });
  app.once("before-quit", () => upstreamToolController?.dispose());
  headlessHost = new HeadlessHost({
''',
    )


def patch_app() -> None:
    replace_once(
        "desktop-electron/src/App.tsx",
        'import { NetworkProxySurface } from "./features/NetworkProxySurface";\n',
        'import { NetworkProxySurface } from "./features/NetworkProxySurface";\nimport { UpstreamToolSurface } from "./features/UpstreamToolSurface";\n',
    )
    replace_once(
        "desktop-electron/src/App.tsx",
        '''            {surface === "paseo" ? (
              <PaseoOrchestratorSurface language={language} setError={setError} />
            ) : null}
            {surface === "anneal" ? (
              <AnnealTasksSurface language={language} setError={setError} />
            ) : null}
''',
        '''            {surface === "paseo" ? (
              <UpstreamToolSurface
                language={language}
                nativeControl={<PaseoOrchestratorSurface language={language} setError={setError} />}
                setError={setError}
                toolId="paseo"
              />
            ) : null}
            {surface === "anneal" ? (
              <UpstreamToolSurface
                language={language}
                nativeControl={<AnnealTasksSurface language={language} setError={setError} />}
                setError={setError}
                toolId="anneal"
              />
            ) : null}
''',
    )


def patch_package() -> None:
    replace_once(
        "desktop-electron/package.json",
        '      "electron/**",\n      "assets/icon.png",\n',
        '      "electron/**",\n      "vendor/upstream/**",\n      "assets/icon.png",\n',
    )


def main() -> None:
    patch_types()
    patch_preload()
    patch_main()
    patch_app()
    patch_package()
    print("RC7_UPSTREAM_TOOLS_PATCH_APPLIED")


if __name__ == "__main__":
    main()
