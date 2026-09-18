from __future__ import annotations

from pathlib import Path


def replace_once(path: Path, old: str, new: str, marker: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if marker in text:
        return False
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


preload = Path("desktop-electron/electron/preload.cjs")
preload_anchor = '  externalServicesSnapshot: () => ipcRenderer.invoke("launcher:external-services-snapshot"),\n'
preload_methods = preload_anchor + '''  managedComponentsSnapshot: () => ipcRenderer.invoke("launcher:managed-components-snapshot"),
  installManagedComponent: (serviceId) => ipcRenderer.invoke("launcher:managed-component-install", serviceId),
  repairManagedComponent: (serviceId) => ipcRenderer.invoke("launcher:managed-component-repair", serviceId),
  setManagedComponentCredential: (serviceId, key, value) => ipcRenderer.invoke(
    "launcher:managed-component-credential",
    serviceId,
    key,
    value,
  ),
'''
replace_once(preload, preload_anchor, preload_methods, "managedComponentsSnapshot:")
replace_once(
    preload,
    '  beginProviderLogin: (accountId) => ipcRenderer.invoke("launcher:provider-login", accountId),\n',
    '  beginProviderLogin: (accountId, adapterId) => ipcRenderer.invoke("launcher:provider-login", accountId, adapterId),\n',
    "beginProviderLogin: (accountId, adapterId)",
)

types = Path("desktop-electron/src/types.ts")
replace_once(
    types,
    'export type ProviderAccountStatus = "pending" | "connected" | "expired" | "error" | "disabled";\n',
    'export type ProviderAccountStatus = "pending" | "connected" | "expired" | "error" | "disabled";\n'
    'export type ProviderCredentialSource = "native_browser" | "cpa" | "commandcode" | "api_key" | "local_proxy";\n',
    "export type ProviderCredentialSource",
)
replace_once(
    types,
    '  hasCredential: boolean;\n  models: string[];\n  proxyProfileId?: string;\n',
    '  hasCredential: boolean;\n  models: string[];\n  loginAdapterId?: string;\n'
    '  credentialSource?: ProviderCredentialSource;\n  proxyProfileId?: string;\n',
    "  loginAdapterId?: string;",
)
replace_once(
    types,
    '  isDefault?: boolean;\n  models?: string[];\n  proxyProfileId?: string;\n',
    '  isDefault?: boolean;\n  models?: string[];\n  loginAdapterId?: string;\n'
    '  credentialSource?: ProviderCredentialSource;\n  proxyProfileId?: string;\n',
    "  credentialSource?: ProviderCredentialSource;",
)

managed_types = '''export type ManagedComponentInstallState =
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
  missingCredentials: string[];
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

'''
external_status = 'export type ExternalServiceStatus = "unknown" | "disabled" | "offline" | "starting" | "ready" | "error";\n'
replace_once(
    types,
    external_status,
    external_status + managed_types,
    "export type ManagedComponentInstallState",
)
replace_once(
    types,
    '  providerModelCount?: number;\n}\n',
    '  providerModelCount?: number;\n  managedInstall: ManagedComponentInstallSnapshot;\n}\n',
    "  managedInstall: ManagedComponentInstallSnapshot;",
)
managed_api = '''  managedComponentsSnapshot(): Promise<ManagedComponentsSnapshot>;
  installManagedComponent(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  repairManagedComponent(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  setManagedComponentCredential(
    serviceId: ExternalServiceId,
    key: string,
    value: string,
  ): Promise<ExternalServiceSnapshot>;
'''
api_anchor = '  externalServicesSnapshot(): Promise<ExternalServicesSnapshot>;\n'
replace_once(types, api_anchor, api_anchor + managed_api, "  managedComponentsSnapshot():")
replace_once(
    types,
    '''  beginProviderLogin(accountId: string): Promise<{
    opened: boolean;
    mode: "embedded" | "external";
    state?: string;
    snapshot?: ProviderNetworkSnapshot;
  }>;
''',
    '''  beginProviderLogin(accountId: string, adapterId?: string): Promise<{
    opened: boolean;
    mode: "embedded" | "external" | "import";
    state?: string | null;
    adapterId?: string;
    snapshot?: ProviderNetworkSnapshot;
  }>;
''',
    "beginProviderLogin(accountId: string, adapterId?: string)",
)

preload_text = preload.read_text(encoding="utf-8")
types_text = types.read_text(encoding="utf-8")
for required in (
    "managedComponentsSnapshot:",
    "beginProviderLogin: (accountId, adapterId)",
):
    if required not in preload_text:
        raise SystemExit(f"missing preload union contract: {required}")
for required in (
    "ProviderCredentialSource",
    "ManagedComponentInstallSnapshot",
    "managedComponentsSnapshot():",
    "beginProviderLogin(accountId: string, adapterId?: string)",
):
    if required not in types_text:
        raise SystemExit(f"missing type union contract: {required}")

print("RC9_FIVE_STACK_CPA_UNION_OK")
