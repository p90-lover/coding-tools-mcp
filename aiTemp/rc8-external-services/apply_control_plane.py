from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, before: str, after: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {relative}")
        return
    count = text.count(before)
    if count != 1:
        raise SystemExit(
            f"expected one anchor in {relative}, found {count}: {before[:180]!r}"
        )
    path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {relative}")


def patch_main() -> None:
    path = "desktop-electron/electron/main.cjs"
    replace_once(
        path,
        '''  nativeTheme,
  screen,
  shell,
''',
        '''  nativeTheme,
  screen,
  safeStorage,
  shell,
''',
    )
    replace_once(
        path,
        'const { providerNetworkReady } = require("./provider-bootstrap.cjs");\n',
        '''const {
  providerNetworkReady,
  setProviderBrowserHost,
} = require("./provider-bootstrap.cjs");
''',
    )
    replace_once(
        path,
        'const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");\n',
        '''const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");
const { createExternalServicesController } = require("./external-services.cjs");
''',
    )
    replace_once(
        path,
        '''let updateController = null;
let upstreamToolController = null;
''',
        '''let updateController = null;
let externalServicesController = null;
let upstreamToolController = null;
''',
    )
    replace_once(
        path,
        '''    upstreamTools: upstreamToolController?.snapshot() ?? { version: 1, tools: [] },
    update: updateController?.getState() ?? { status: "disabled" },
''',
        '''    upstreamTools: upstreamToolController?.snapshot() ?? { version: 1, tools: [] },
    externalServices: externalServicesController?.snapshot() ?? { version: 1, services: [] },
    update: updateController?.getState() ?? { status: "disabled" },
''',
    )
    replace_once(
        path,
        '''  handle("launcher:upstream-tools-snapshot", (event) => {
''',
        '''  handle("launcher:external-services-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.snapshot();
  });
  handle("launcher:external-service-configure", (event, serviceId, input) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.configure(serviceId, input);
  });
  handle("launcher:external-service-inspect", (event, serviceId) => {
    assertFocusedMainWindow(event, false);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.inspect(serviceId);
  });
  handle("launcher:external-service-start", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.start(serviceId);
  });
  handle("launcher:external-service-stop", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.stop(serviceId);
  });
  handle("launcher:external-service-restart", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.restart(serviceId);
  });
  handle("launcher:codex-router-sync", (event) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("External services controller is unavailable");
    return externalServicesController.syncCodexRouter();
  });

  handle("launcher:upstream-tools-snapshot", (event) => {
''',
    )
    replace_once(
        path,
        '''    updateController?.stopPeriodicChecks?.();
    upstreamToolController?.dispose();
''',
        '''    updateController?.stopPeriodicChecks?.();
    externalServicesController?.dispose();
    upstreamToolController?.dispose();
''',
    )
    replace_once(
        path,
        '''  upstreamToolController = createUpstreamToolController({
    env: process.env,
    logger,
    openExternal: openWebUrl,
  });
  app.once("before-quit", () => upstreamToolController?.dispose());
''',
        '''  externalServicesController = createExternalServicesController({
    filePath: path.join(app.getPath("userData"), "external-services.json"),
    keyPath: path.join(app.getPath("userData"), "external-services.key"),
    safeStorage,
    env: process.env,
    logger,
    publish: (value) => send("launcher:external-services-changed", value),
    runRuntimeCommand: async (args) => {
      if (!runtimeSupervisor) throw new Error("Packaged runtime is not ready");
      const invocation = runtimeSupervisor.runtimeCommand(args);
      const result = spawnSync(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env },
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || "").trim();
        throw new Error(`Codex Router integration failed (${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`);
      }
      return { stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
    },
  });
  upstreamToolController = createUpstreamToolController({
    env: process.env,
    logger,
    openExternal: openWebUrl,
    externalServices: externalServicesController,
  });
  app.once("before-quit", () => {
    externalServicesController?.dispose();
    upstreamToolController?.dispose();
  });
''',
    )
    replace_once(
        path,
        '''  await browserHost.ready();
  const updaterRuntimeRoot = runtimeRootProvider();
''',
        '''  await browserHost.ready();
  setProviderBrowserHost(() => browserHost);
  for (const service of externalServicesController?.snapshot().services ?? []) {
    if (!service.enabled || !service.autoStart) continue;
    void externalServicesController.start(service.id).catch((error) => {
      logger.warn("external-service.autostart-failed", {
        serviceId: service.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const updaterRuntimeRoot = runtimeRootProvider();
''',
    )


def patch_preload() -> None:
    path = "desktop-electron/electron/preload.cjs"
    replace_once(
        path,
        '''  upstreamToolsSnapshot: () => ipcRenderer.invoke("launcher:upstream-tools-snapshot"),
''',
        '''  externalServicesSnapshot: () => ipcRenderer.invoke("launcher:external-services-snapshot"),
  configureExternalService: (serviceId, input) => ipcRenderer.invoke(
    "launcher:external-service-configure",
    serviceId,
    input,
  ),
  inspectExternalService: (serviceId) => ipcRenderer.invoke("launcher:external-service-inspect", serviceId),
  startExternalService: (serviceId) => ipcRenderer.invoke("launcher:external-service-start", serviceId),
  stopExternalService: (serviceId) => ipcRenderer.invoke("launcher:external-service-stop", serviceId),
  restartExternalService: (serviceId) => ipcRenderer.invoke("launcher:external-service-restart", serviceId),
  syncCodexRouter: () => ipcRenderer.invoke("launcher:codex-router-sync"),
  upstreamToolsSnapshot: () => ipcRenderer.invoke("launcher:upstream-tools-snapshot"),
''',
    )
    replace_once(
        path,
        '''  onProviderNetworkChanged: (listener) => subscription("launcher:provider-network-changed", listener),
''',
        '''  onExternalServicesChanged: (listener) => subscription("launcher:external-services-changed", listener),
  onProviderNetworkChanged: (listener) => subscription("launcher:provider-network-changed", listener),
''',
    )


def patch_types() -> None:
    path = "desktop-electron/src/types.ts"
    replace_once(
        path,
        'export type Surface = "browser" | "setup" | "mcp" | "providers" | "paseo" | "anneal" | "network" | "activity" | "settings";\n',
        'export type Surface = "browser" | "setup" | "mcp" | "providers" | "integrations" | "paseo" | "anneal" | "network" | "activity" | "settings";\n',
    )
    replace_once(
        path,
        'export type UpstreamToolId = "anneal" | "paseo";\n',
        '''export type ExternalServiceId = "codex-router" | "commandcode-proxy" | "paseo" | "anneal";
export type ExternalServiceStatus = "unknown" | "disabled" | "offline" | "starting" | "ready" | "error";

export interface ExternalServiceSnapshot {
  id: ExternalServiceId;
  name: string;
  endpoint: string;
  home: string;
  executable: string;
  arguments: string[];
  enabled: boolean;
  autoStart: boolean;
  status: ExternalServiceStatus;
  pid: number | null;
  owned: boolean;
  startedAt: string | null;
  checkedAt: string | null;
  latencyMs: number | null;
  statusCode: number | null;
  modelCount: number | null;
  error: string | null;
  secretConfigured: boolean;
  sourceConfigured: boolean;
  routerCli?: string;
  curateCli?: string;
  webBaseUrl?: string;
  accountCount?: number;
  connectedAccountCount?: number;
  providerModelCount?: number;
}

export interface ExternalServicesSnapshot {
  version: 1;
  services: ExternalServiceSnapshot[];
}

export interface ExternalServiceConfigurationInput {
  endpoint?: string;
  home?: string;
  executable?: string;
  arguments?: string[];
  enabled?: boolean;
  autoStart?: boolean;
  callerKey?: string;
  routerCli?: string;
  curateCli?: string;
  webBaseUrl?: string;
}

export interface CodexRouterSyncResult {
  ok: boolean;
  args: string[];
  stdout: string;
  stderr: string;
}

export type UpstreamToolId = "anneal" | "paseo";
''',
    )
    replace_once(
        path,
        'export type UpstreamToolStatus = "unknown" | "offline" | "starting" | "ready" | "error";\n',
        'export type UpstreamToolStatus = "unknown" | "disabled" | "offline" | "starting" | "ready" | "error";\n',
    )
    replace_once(
        path,
        '''  upstreamTools: UpstreamToolsSnapshot;
  update: UpdateState;
''',
        '''  upstreamTools: UpstreamToolsSnapshot;
  externalServices: ExternalServicesSnapshot;
  update: UpdateState;
''',
    )
    replace_once(
        path,
        '''  upstreamToolsSnapshot(): Promise<UpstreamToolsSnapshot>;
''',
        '''  externalServicesSnapshot(): Promise<ExternalServicesSnapshot>;
  configureExternalService(serviceId: ExternalServiceId, input: ExternalServiceConfigurationInput): Promise<ExternalServiceSnapshot>;
  inspectExternalService(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  startExternalService(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  stopExternalService(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  restartExternalService(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  syncCodexRouter(): Promise<CodexRouterSyncResult>;
  upstreamToolsSnapshot(): Promise<UpstreamToolsSnapshot>;
''',
    )
    replace_once(
        path,
        '''  onProviderNetworkChanged(listener: (state: ProviderNetworkSnapshot) => void): () => void;
''',
        '''  onExternalServicesChanged(listener: (state: ExternalServicesSnapshot) => void): () => void;
  onProviderNetworkChanged(listener: (state: ProviderNetworkSnapshot) => void): () => void;
''',
    )


def patch_app() -> None:
    path = "desktop-electron/src/App.tsx"
    replace_once(
        path,
        'import { UpstreamToolSurface } from "./features/UpstreamToolSurface";\n',
        '''import { UpstreamToolSurface } from "./features/UpstreamToolSurface";
import { ExternalServicesSurface } from "./features/ExternalServicesSurface";
''',
    )
    provider_item = '''                <SidebarItem
                  active={surface === "providers"}
                  icon="providers"
                  label={language === "zh-TW" ? "供應商" : language === "zh-CN" ? "供应商" : language === "ja" ? "プロバイダー" : "Providers"}
                  onClick={() => navigateSurface("providers")}
                />
'''
    replace_once(
        path,
        provider_item,
        provider_item + '''                <SidebarItem
                  active={surface === "integrations"}
                  icon="globe"
                  label={language === "zh-TW" ? "整合服務" : language === "zh-CN" ? "集成服务" : language === "ja" ? "統合サービス" : "Integrations"}
                  onClick={() => navigateSurface("integrations")}
                />
''',
    )
    provider_surface = '''            {surface === "providers" ? (
              <ProviderCenterSurface language={language} setError={setError} />
            ) : null}
'''
    replace_once(
        path,
        provider_surface,
        provider_surface + '''            {surface === "integrations" ? (
              <ExternalServicesSurface
                language={language}
                openAnneal={() => navigateSurface("anneal")}
                openPaseo={() => navigateSurface("paseo")}
                openProviders={() => navigateSurface("providers")}
                setError={setError}
              />
            ) : null}
''',
    )


def main() -> None:
    patch_main()
    patch_preload()
    patch_types()
    patch_app()
    print("RC8_EXTERNAL_SERVICES_CONTROL_PLANE_APPLIED")


if __name__ == "__main__":
    main()
