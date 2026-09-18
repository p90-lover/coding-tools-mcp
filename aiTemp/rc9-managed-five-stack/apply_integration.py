from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if new in text:
        print(f"already patched: {relative}")
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match in {relative}, found {count}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched: {relative}")



def insert_before_once(relative: str, anchor: str, block: str, sentinel: str) -> None:
    path = ROOT / relative
    current = path.read_text(encoding="utf-8")
    if sentinel in current:
        print(f"already patched: {relative}")
        return
    count = current.count(anchor)
    if count != 1:
        raise SystemExit(f"expected exactly one insertion anchor in {relative}, found {count}: {anchor[:120]!r}")
    path.write_text(current.replace(anchor, block + anchor, 1), encoding="utf-8")
    print(f"patched: {relative}")


replace_once(
    "desktop-electron/electron/managed-components.cjs",
    '''    return {
      executable,
      args,
      options: {
        cwd: context.home,
        env: { ...env, ...environment },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    };
''',
    '''    if (platform === "win32" && context.mode === "native" && /\\.(?:cmd|bat)$/i.test(executable)) {
      return {
        executable: env.ComSpec || process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", executable, ...args],
        options: {
          cwd: context.home,
          env: { ...env, ...environment },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      };
    }
    return {
      executable,
      args,
      options: {
        cwd: context.home,
        env: { ...env, ...environment },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    };
''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''const { createExternalServicesController } = require("./external-services.cjs");
''',
    '''const { createManagedExternalServicesController } = require("./managed-external-services.cjs");
''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''  externalServicesController = createExternalServicesController({
    filePath: path.join(app.getPath("userData"), "external-services.json"),
''',
    '''  externalServicesController = createManagedExternalServicesController({
    dataRoot: path.join(app.getPath("userData"), "integrations"),
    resolveRuntimeExecutable: () => {
      const runtimeRoot = runtimeRootProvider();
      if (!runtimeRoot) throw new Error("Packaged runtime is unavailable for managed components");
      return runtimeBundlePaths(runtimeRoot, process.platform).executable;
    },
    filePath: path.join(app.getPath("userData"), "external-services.json"),
''',
)

insert_before_once(
    "desktop-electron/electron/main.cjs",
    '''  handle("launcher:external-services-snapshot", (event) => {
''',
    '''  handle("launcher:managed-components-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.managedComponentsSnapshot();
  });
  handle("launcher:managed-component-install", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.installManagedComponent(serviceId);
  });
  handle("launcher:managed-component-repair", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.repairManagedComponent(serviceId);
  });
''',
    "launcher:managed-components-snapshot",
)

replace_once(
    "desktop-electron/electron/preload.cjs",
    '''  externalServicesSnapshot: () => ipcRenderer.invoke("launcher:external-services-snapshot"),
''',
    '''  externalServicesSnapshot: () => ipcRenderer.invoke("launcher:external-services-snapshot"),
  managedComponentsSnapshot: () => ipcRenderer.invoke("launcher:managed-components-snapshot"),
  installManagedComponent: (serviceId) => ipcRenderer.invoke("launcher:managed-component-install", serviceId),
  repairManagedComponent: (serviceId) => ipcRenderer.invoke("launcher:managed-component-repair", serviceId),
''',
)

replace_once(
    "desktop-electron/src/types.ts",
    '''export type ExternalServiceStatus = "unknown" | "disabled" | "offline" | "starting" | "ready" | "error";

export interface ExternalServiceSnapshot {
''',
    '''export type ExternalServiceStatus = "unknown" | "disabled" | "offline" | "starting" | "ready" | "error";
export type ManagedComponentInstallState =
  | "not-installed"
  | "installing"
  | "installed"
  | "repair-required"
  | "external"
  | "error";

export interface ManagedComponentProcessSnapshot {
  id: string;
  pid: number | null;
  running: boolean;
}

export interface ManagedComponentInstallSnapshot {
  state: ManagedComponentInstallState;
  version: string;
  commit: string | null;
  strategy: "release-binary" | "git-source";
  home: string;
  installedAt: string | null;
  currentStep: string | null;
  error: string | null;
  platformMode: "native" | "wsl2" | string;
  processes: ManagedComponentProcessSnapshot[];
}

export interface ManagedComponentsSnapshot {
  version: 1;
  components: Array<{
    id: ExternalServiceId;
    name: string;
    version: string;
    commit: string | null;
    strategy: "release-binary" | "git-source";
    installState: ManagedComponentInstallState;
    managedHome: string;
    installedAt: string | null;
    currentStep: string | null;
    error: string | null;
    platformMode: "native" | "wsl2" | string;
    processes: ManagedComponentProcessSnapshot[];
    secretConfigured: boolean;
  }>;
}

export interface ExternalServiceSnapshot {
''',
)

replace_once(
    "desktop-electron/src/types.ts",
    '''  providerModelCount?: number;
}
''',
    '''  providerModelCount?: number;
  managedInstall: ManagedComponentInstallSnapshot;
}
''',
)

replace_once(
    "desktop-electron/src/types.ts",
    '''  externalServicesSnapshot(): Promise<ExternalServicesSnapshot>;
''',
    '''  externalServicesSnapshot(): Promise<ExternalServicesSnapshot>;
  managedComponentsSnapshot(): Promise<ManagedComponentsSnapshot>;
  installManagedComponent(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  repairManagedComponent(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
''',
)

replace_once(
    "desktop-electron/src/features/ExternalServicesSurface.tsx",
    '''function splitArguments(value: string): string[] {
''',
    '''function installStateLabel(language: Language, service: ExternalServiceSnapshot): string {
  const labels: Record<ExternalServiceSnapshot["managedInstall"]["state"], [string, string]> = {
    "not-installed": ["Not installed", "尚未安裝"],
    installing: ["Installing", "正在安裝"],
    installed: ["Managed install ready", "受管理安裝已就緒"],
    "repair-required": ["Repair required", "需要修復"],
    external: ["External install", "外部安裝"],
    error: ["Install error", "安裝錯誤"],
  };
  const value = labels[service.managedInstall.state];
  return text(language, value[0], value[1]);
}

function splitArguments(value: string): string[] {
''',
)

replace_once(
    "desktop-electron/src/features/ExternalServicesSurface.tsx",
    '''  const restart = () => run("restart", async () => {
    if (!api || !selected) return;
    await api.restartExternalService(selected.id);
  });

''',
    '''  const restart = () => run("restart", async () => {
    if (!api || !selected) return;
    await api.restartExternalService(selected.id);
  });

  const installOrRepair = () => run("managed-install", async () => {
    if (!api || !selected) return;
    const repair = selected.managedInstall.state === "repair-required"
      || selected.managedInstall.state === "error";
    if (repair) await api.repairManagedComponent(selected.id);
    else await api.installManagedComponent(selected.id);
    setNotice(text(
      language,
      `${serviceName(language, selected.id)} is installed and started by Coding Tools.`,
      `${serviceName(language, selected.id)} 已由 Coding Tools 安裝並啟動。`,
    ));
  });

''',
)

replace_once(
    "desktop-electron/src/features/ExternalServicesSurface.tsx",
    '''            "Manage separately installed Codex Router, CommandCode Proxy, Paseo and Anneal while CPA Provider Hub remains the encrypted account and routing authority.",
            "統一管理另外安裝的 Codex Router、CommandCode Proxy、Paseo 與 Anneal；CPA 供應商中心繼續作為加密帳戶與路由權限來源。",
''',
    '''            "Install, repair and run Codex Router, CommandCode Proxy, Paseo and Anneal from Coding Tools while CPA Provider Hub remains the encrypted account and routing authority.",
            "直接由 Coding Tools 安裝、修復同執行 Codex Router、CommandCode Proxy、Paseo 與 Anneal；CPA 供應商中心繼續作為加密帳戶同路由權限來源。",
''',
)

replace_once(
    "desktop-electron/src/features/ExternalServicesSurface.tsx",
    '''                <small>{statusLabel(language, service)}</small>
''',
    '''                <small>{statusLabel(language, service)} · {installStateLabel(language, service)}</small>
''',
)

replace_once(
    "desktop-electron/src/features/ExternalServicesSurface.tsx",
    '''          <div className="external-service-form">
''',
    '''          <section className={`managed-install-panel state-${selected.managedInstall.state}`}>
            <div>
              <span>{text(language, "APP-MANAGED COMPONENT", "APP 受管理元件")}</span>
              <strong>{installStateLabel(language, selected)}</strong>
              <small>
                {text(language, "Pinned version", "固定版本")} {selected.managedInstall.version}
                {selected.managedInstall.commit ? ` · ${selected.managedInstall.commit.slice(0, 12)}` : ""}
                {selected.managedInstall.platformMode === "wsl2" ? " · WSL2" : ""}
              </small>
              {selected.managedInstall.currentStep ? <small>{text(language, "Current step", "目前步驟")}: {selected.managedInstall.currentStep}</small> : null}
              {selected.managedInstall.error ? <small className="managed-install-error">{selected.managedInstall.error}</small> : null}
            </div>
            <button
              className="primary"
              disabled={busy !== null || selected.managedInstall.state === "installing"}
              onClick={() => void installOrRepair()}
              type="button"
            >
              {busy === "managed-install" || selected.managedInstall.state === "installing"
                ? "…"
                : selected.managedInstall.state === "installed"
                  ? text(language, "Repair installation", "修復安裝")
                  : text(language, "Install / Repair", "安裝／修復")}
            </button>
          </section>

          <details className="external-service-advanced">
            <summary>{text(language, "Advanced manual configuration", "進階手動設定")}</summary>
            <div className="external-service-form">
''',
)

replace_once(
    "desktop-electron/src/features/ExternalServicesSurface.tsx",
    '''          </div>

          {selected.error ? <p className="external-service-error">{selected.error}</p> : null}
''',
    '''            </div>
          </details>

          {selected.error ? <p className="external-service-error">{selected.error}</p> : null}
''',
)

replace_once(
    "desktop-electron/package.json",
    '''      "vendor/upstream/**",
''',
    '''      "vendor/upstream/**",
      "vendor/managed-components/**",
''',
)

css_path = ROOT / "desktop-electron/src/features/external-services.css"
css = css_path.read_text(encoding="utf-8")
css_marker = ".managed-install-panel {"
if css_marker not in css:
    css += '''

.managed-install-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin: 18px 0;
  padding: 16px;
  border: 1px solid rgba(128, 152, 255, 0.24);
  border-radius: 14px;
  background: rgba(77, 99, 185, 0.08);
}

.managed-install-panel > div {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.managed-install-panel span,
.managed-install-panel small {
  color: rgba(231, 235, 246, 0.58);
  font-size: 10px;
}

.managed-install-panel strong {
  font-size: 13px;
}

.managed-install-panel.state-error,
.managed-install-panel.state-repair-required {
  border-color: rgba(239, 91, 104, 0.28);
  background: rgba(168, 51, 64, 0.08);
}

.managed-install-error {
  color: #f0a0a8 !important;
}

.external-service-advanced {
  margin: 14px 0;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
}

.external-service-advanced > summary {
  cursor: pointer;
  color: rgba(232, 236, 247, 0.68);
  font-size: 11px;
  font-weight: 700;
}

.external-service-advanced[open] > summary {
  margin-bottom: 14px;
}
'''
    css_path.write_text(css, encoding="utf-8")
    print("patched: desktop-electron/src/features/external-services.css")
else:
    print("already patched: desktop-electron/src/features/external-services.css")
