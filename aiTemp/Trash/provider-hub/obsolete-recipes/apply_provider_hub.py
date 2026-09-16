from __future__ import annotations

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: Path, old: str, new: str, marker: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return False
    if old not in text:
        raise SystemExit(f"{marker}_ANCHOR_MISSING:{path.as_posix()}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


def patch_types() -> bool:
    path = ROOT / "desktop-electron/src/types.ts"
    changed = False
    changed |= replace_once(
        path,
        'export type Surface = "browser" | "setup" | "mcp" | "activity" | "settings";',
        'export type Surface = "browser" | "providers" | "setup" | "mcp" | "activity" | "settings";',
        "SURFACE",
    )

    provider_types = '''export type ProviderAccountAuth = "oauth" | "api_key" | "browser_session" | "local_proxy";
export type ProviderAccountStatus = "pending" | "connected" | "expired" | "error" | "disabled";
export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";
export type ProxyScope =
  | "all"
  | "browser"
  | "provider"
  | "oauth"
  | "paseo"
  | "anneal"
  | "mcp"
  | "websocket"
  | "http"
  | "update";

export interface ProviderAccountRecord {
  id: string;
  providerId: string;
  label: string;
  identity?: string;
  auth: ProviderAccountAuth;
  status: ProviderAccountStatus;
  enabled: boolean;
  isDefault: boolean;
  models: string[];
  proxyProfileId?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  archivedAt?: string;
  error?: string;
}

export interface ProxyEndpointRecord {
  protocol: ProxyProtocol;
  host: string;
  port: number;
}

export interface ProxyProfileRecord {
  id: string;
  name: string;
  enabled: boolean;
  endpoint: ProxyEndpointRecord;
  scopes: ProxyScope[];
  bypass: string[];
  hasAuthentication: boolean;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  latencyMs?: number;
  lastError?: string;
  archivedAt?: string;
}

export interface ProviderProxyPolicyRecord {
  providerId: string;
  inheritGlobal: boolean;
  profileId?: string;
}

export interface AccountProxyPolicyRecord {
  accountId: string;
  providerId: string;
  inheritProvider: boolean;
  inheritGlobal: boolean;
  profileId?: string;
}

export interface ProviderNetworkSnapshot {
  version: 1;
  accounts: ProviderAccountRecord[];
  proxyProfiles: ProxyProfileRecord[];
  routing: {
    globalEnabled: boolean;
    globalProfileId: string | null;
    providers: ProviderProxyPolicyRecord[];
    accounts: AccountProxyPolicyRecord[];
  };
}

export interface SaveProviderAccountInput {
  id?: string;
  providerId: string;
  label: string;
  identity?: string;
  auth: ProviderAccountAuth;
  status?: ProviderAccountStatus;
  enabled?: boolean;
  isDefault?: boolean;
  models?: string[];
  proxyProfileId?: string;
  error?: string;
  secret?: Record<string, string>;
}

export interface SaveProxyProfileInput {
  id?: string;
  name: string;
  enabled?: boolean;
  endpoint: ProxyEndpointRecord;
  scopes?: ProxyScope[];
  bypass?: string[];
  username?: string;
  password?: string;
}

export type ProviderProxyMode = "inherit" | "direct" | "profile";
export type AccountProxyMode = "inherit" | "global" | "direct" | "profile";

'''
    changed |= replace_once(
        path,
        "export interface LauncherApi {\n",
        provider_types + "export interface LauncherApi {\n",
        "PROVIDER_TYPES",
    )

    methods = '''  providerSnapshot(): Promise<ProviderNetworkSnapshot>;
  saveProviderAccount(input: SaveProviderAccountInput): Promise<ProviderNetworkSnapshot>;
  setDefaultProviderAccount(providerId: string, accountId: string): Promise<ProviderNetworkSnapshot>;
  setProviderAccountEnabled(accountId: string, enabled: boolean): Promise<ProviderNetworkSnapshot>;
  archiveProviderAccount(accountId: string): Promise<ProviderNetworkSnapshot>;
  beginProviderLogin(accountId: string): Promise<{
    opened: boolean;
    mode: "embedded" | "external";
  }>;
  saveProxyProfile(input: SaveProxyProfileInput): Promise<ProviderNetworkSnapshot>;
  archiveProxyProfile(profileId: string): Promise<ProviderNetworkSnapshot>;
  testProxyProfile(profileId: string): Promise<{
    reachable: boolean;
    latencyMs?: number;
    error?: string;
    snapshot: ProviderNetworkSnapshot;
  }>;
  setGlobalProxyRouting(input: {
    enabled: boolean;
    profileId?: string | null;
  }): Promise<ProviderNetworkSnapshot>;
  setProviderProxyPolicy(input: {
    providerId: string;
    mode: ProviderProxyMode;
    profileId?: string;
  }): Promise<ProviderNetworkSnapshot>;
  setAccountProxyPolicy(input: {
    accountId: string;
    mode: AccountProxyMode;
    profileId?: string;
  }): Promise<ProviderNetworkSnapshot>;
'''
    changed |= replace_once(
        path,
        "  logs(limit?: number): Promise<LogRecord[]>;\n",
        methods + "  logs(limit?: number): Promise<LogRecord[]>;\n",
        "PROVIDER_METHODS",
    )

    changed |= replace_once(
        path,
        "  onUpdateState(listener: (state: UpdateState) => void): () => void;\n",
        "  onUpdateState(listener: (state: UpdateState) => void): () => void;\n"
        "  onProviderNetworkChanged(listener: (snapshot: ProviderNetworkSnapshot) => void): () => void;\n",
        "PROVIDER_EVENT",
    )
    return changed


def patch_app() -> bool:
    path = ROOT / "desktop-electron/src/App.tsx"
    changed = False
    changed |= replace_once(
        path,
        'import { Icon, type IconName } from "./icons";\n',
        'import { Icon, type IconName } from "./icons";\n'
        'import { ProviderManagerSurface } from "./ProviderManagerSurface";\n',
        "APP_IMPORT",
    )

    nav = '''                <SidebarItem
                  active={surface === "providers"}
                  icon="globe"
                  label={language === "zh-CN" ? "供應商" : language === "ja" ? "プロバイダー" : "Providers"}
                  onClick={() => navigateSurface("providers")}
                />
'''
    changed |= replace_once(
        path,
        '              <SidebarGroup label={copy.configuration}>\n                <SidebarItem\n                  active={surface === "setup"}',
        '              <SidebarGroup label={copy.configuration}>\n' + nav + '                <SidebarItem\n                  active={surface === "setup"}',
        "APP_NAV",
    )

    render = '''            {surface === "providers" ? (
              <ProviderManagerSurface language={language} setError={setError} />
            ) : null}
'''
    changed |= replace_once(
        path,
        '            {surface === "setup" ? (\n              <SetupSurface',
        render + '            {surface === "setup" ? (\n              <SetupSurface',
        "APP_RENDER",
    )
    return changed


def patch_contract() -> bool:
    path = ROOT / "desktop-electron/tests/provider-multiaccount-global-proxy.test.cjs"
    changed = False
    changed |= replace_once(
        path,
        '  const main = read("electron/main.cjs");\n  const styles = read("src/styles.css");',
        '  const bootstrap = read("electron/provider-bootstrap.cjs");\n'
        '  const entrypoint = read("electron/main-with-provider.cjs");\n'
        '  const styles = read("src/ProviderManagerSurface.css");',
        "CONTRACT_FILES",
    )
    changed |= replace_once(
        path,
        '  assert.match(main, /createProviderNetworkStore/);\n'
        '  assert.match(main, /launcher:provider-snapshot/);\n'
        '  assert.match(main, /launcher:proxy-global-routing/);',
        '  assert.match(entrypoint, /installProviderNetwork/);\n'
        '  assert.match(bootstrap, /createProviderNetworkStore/);\n'
        '  assert.match(bootstrap, /launcher:provider-snapshot/);\n'
        '  assert.match(bootstrap, /launcher:proxy-global-routing/);',
        "CONTRACT_ARCHITECTURE",
    )
    return changed


def main() -> None:
    changes = {
        "types": patch_types(),
        "app": patch_app(),
        "contract": patch_contract(),
    }
    paths = [
        "desktop-electron/src/types.ts",
        "desktop-electron/src/App.tsx",
        "desktop-electron/tests/provider-multiaccount-global-proxy.test.cjs",
    ]
    subprocess.run(["git", "add", "--", *paths], cwd=ROOT, check=True)
    print(f"PROVIDER_HUB_WIRING_OK changed={any(changes.values())} details={changes}")


if __name__ == "__main__":
    main()
