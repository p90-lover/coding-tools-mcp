from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def write(relative: str, content: str) -> None:
    target = ROOT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(relative: str, old: str, new: str, marker: str) -> bool:
    text = read(relative)
    if new in text:
        return False
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{marker}_ANCHOR_MISMATCH:{relative}:found={count}")
    write(relative, text.replace(old, new, 1))
    return True


def insert_after_surface(relative: str, addition: str) -> bool:
    text = read(relative)
    if addition.strip() in text:
        return False
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.startswith("export type Surface = "):
            lines.insert(index + 1, "\n" + addition)
            write(relative, "".join(lines))
            return True
    raise SystemExit(f"SURFACE_ANCHOR_MISSING:{relative}")


PROVIDER_TYPES = '''export type ProviderAuth = "oauth" | "api_key" | "browser_session" | "local_proxy";
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
export type ProxyPolicyMode = "inherit" | "global" | "direct" | "profile";

export interface ProviderAccountRecord {
  id: string;
  providerId: string;
  label: string;
  identity?: string;
  auth: ProviderAuth;
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

export interface ProviderAccountInput {
  id?: string;
  providerId: string;
  label: string;
  identity?: string;
  auth: ProviderAuth;
  status?: ProviderAccountStatus;
  enabled?: boolean;
  isDefault?: boolean;
  models?: string[];
  proxyProfileId?: string;
  secret?: Record<string, string>;
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

export interface ProxyProfileInput {
  id?: string;
  name: string;
  enabled?: boolean;
  endpoint: ProxyEndpointRecord;
  scopes?: ProxyScope[];
  bypass?: string[];
  username?: string;
  password?: string;
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

'''

PROVIDER_METHODS = '''  providerSnapshot(): Promise<ProviderNetworkSnapshot>;
  saveProviderAccount(input: ProviderAccountInput): Promise<ProviderNetworkSnapshot>;
  setDefaultProviderAccount(providerId: string, accountId: string): Promise<ProviderNetworkSnapshot>;
  setProviderAccountEnabled(accountId: string, enabled: boolean): Promise<ProviderNetworkSnapshot>;
  archiveProviderAccount(accountId: string): Promise<ProviderNetworkSnapshot>;
  beginProviderLogin(accountId: string): Promise<{ opened: boolean; mode: "embedded" | "external" }>;
  saveProxyProfile(input: ProxyProfileInput): Promise<ProviderNetworkSnapshot>;
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
    mode: ProxyPolicyMode;
    profileId?: string;
  }): Promise<ProviderNetworkSnapshot>;
  setAccountProxyPolicy(input: {
    accountId: string;
    mode: ProxyPolicyMode;
    profileId?: string;
  }): Promise<ProviderNetworkSnapshot>;
'''

PRELOAD_METHODS = '''  providerSnapshot: () => ipcRenderer.invoke("launcher:provider-snapshot"),
  saveProviderAccount: (input) => ipcRenderer.invoke("launcher:provider-account-save", input),
  setDefaultProviderAccount: (providerId, accountId) => ipcRenderer.invoke(
    "launcher:provider-account-default",
    providerId,
    accountId,
  ),
  setProviderAccountEnabled: (accountId, enabled) => ipcRenderer.invoke(
    "launcher:provider-account-enabled",
    accountId,
    enabled,
  ),
  archiveProviderAccount: (accountId) => ipcRenderer.invoke(
    "launcher:provider-account-archive",
    accountId,
  ),
  beginProviderLogin: (accountId) => ipcRenderer.invoke("launcher:provider-login", accountId),
  saveProxyProfile: (input) => ipcRenderer.invoke("launcher:proxy-profile-save", input),
  archiveProxyProfile: (profileId) => ipcRenderer.invoke("launcher:proxy-profile-archive", profileId),
  testProxyProfile: (profileId) => ipcRenderer.invoke("launcher:proxy-profile-test", profileId),
  setGlobalProxyRouting: (input) => ipcRenderer.invoke("launcher:proxy-global-routing", input),
  setProviderProxyPolicy: (input) => ipcRenderer.invoke("launcher:proxy-provider-policy", input),
  setAccountProxyPolicy: (input) => ipcRenderer.invoke("launcher:proxy-account-policy", input),
'''

ADDITIONAL_PROVIDERS = '''
export const ADDITIONAL_PROVIDERS = [
  {
    id: "openai-api",
    name: "OpenAI API",
    category: "api_key",
    auth: "api_key",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 95,
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    category: "api_key",
    auth: "api_key",
    protocol: "anthropic_messages",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 85,
  },
  {
    id: "gemini-api",
    name: "Gemini API",
    category: "api_key",
    auth: "api_key",
    protocol: "gemini_native",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 75,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    category: "api_key",
    auth: "api_key",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "inherit",
    baseUrl: "https://openrouter.ai/api/v1",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 65,
  },
  {
    id: "ollama",
    name: "Ollama",
    category: "custom",
    auth: "local_proxy",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools", "vision"],
    models: [],
    proxyMode: "direct",
    baseUrl: "http://127.0.0.1:11434/v1",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 20,
  },
  {
    id: "custom-openai-compatible",
    name: "Custom OpenAI Compatible",
    category: "custom",
    auth: "api_key",
    protocol: "openai_chat",
    capabilities: ["text", "reasoning", "tools", "vision", "image_generation"],
    models: [],
    proxyMode: "inherit",
    paseoEnabled: true,
    annealEnabled: true,
    priority: 10,
  },
] satisfies ProviderDefinition[];

export const PROVIDER_CATALOG = [
  ...DEFAULT_PROVIDERS,
  ...ADDITIONAL_PROVIDERS,
] satisfies ProviderDefinition[];
'''

PROXY_TYPES = '''export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";

export type ProxyTraffic =
  | "browser"
  | "provider"
  | "oauth"
  | "paseo"
  | "anneal"
  | "mcp"
  | "websocket"
  | "http"
  | "update"
  | "local-control";

export type ProxyScope = Exclude<ProxyTraffic, "local-control"> | "all";

export interface ProxyEndpoint {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  usernameRef?: string;
  passwordRef?: string;
}

export interface ProxyRoute {
  enabled: boolean;
  endpoint: ProxyEndpoint;
  scopes: ProxyScope[];
  bypass: string[];
}

export interface ProxyProfile extends ProxyRoute {
  id: string;
  name: string;
  lastCheckedAt?: string;
  latencyMs?: number;
  lastError?: string;
  archivedAt?: string;
}

export interface ProviderProxyPolicy {
  providerId: string;
  inheritGlobal: boolean;
  profileId?: string;
  override?: ProxyRoute;
}

export interface AccountProxyPolicy {
  accountId: string;
  providerId: string;
  inheritProvider: boolean;
  inheritGlobal: boolean;
  profileId?: string;
  override?: ProxyRoute;
}

export interface ProxyRoutingState {
  global: ProxyRoute | null;
  providers: ProviderProxyPolicy[];
  accounts?: AccountProxyPolicy[];
  profiles?: ProxyProfile[];
  globalEnabled?: boolean;
  globalProfileId?: string | null;
}

export interface ProxyHealth {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}
'''

PROXY_MANAGER = '''import type {
  AccountProxyPolicy,
  ProviderProxyPolicy,
  ProxyProfile,
  ProxyRoute,
  ProxyRoutingState,
  ProxyTraffic,
} from "./proxy-routing-types";

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || host === "::"
    || host === "0.0.0.0"
    || /^127(?:\\.\\d{1,3}){3}$/.test(host);
}

function matchesBypass(hostname: string, entries: readonly string[]): boolean {
  const host = normalizeHostname(hostname);
  return entries.some((entry) => {
    const pattern = normalizeHostname(entry);
    if (!pattern) return false;
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    if (pattern.startsWith(".")) {
      const suffix = pattern.slice(1);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === pattern;
  });
}

function copyRoute(route: ProxyRoute): ProxyRoute {
  return {
    enabled: route.enabled,
    endpoint: { ...route.endpoint },
    scopes: [...route.scopes],
    bypass: [...route.bypass],
  };
}

function routeFromProfile(
  profileId: string | undefined,
  profiles: readonly ProxyProfile[],
): ProxyRoute | null {
  if (!profileId) return null;
  const profile = profiles.find((item) => item.id === profileId && !item.archivedAt);
  if (!profile || !validateProxy(profile)) return null;
  return copyRoute(profile);
}

function routeFromPolicy(
  policy: Pick<ProviderProxyPolicy | AccountProxyPolicy, "profileId" | "override"> | undefined,
  profiles: readonly ProxyProfile[],
): ProxyRoute | null {
  if (!policy) return null;
  if (policy.override?.enabled && validateProxy(policy.override)) {
    return copyRoute(policy.override);
  }
  return routeFromProfile(policy.profileId, profiles);
}

function globalRoute(state: ProxyRoutingState): ProxyRoute | null {
  if (state.globalEnabled === false) return null;
  const saved = routeFromProfile(state.globalProfileId ?? undefined, state.profiles ?? []);
  if (saved) return saved;
  return state.global?.enabled && validateProxy(state.global)
    ? copyRoute(state.global)
    : null;
}

export function resolveProxy(
  providerId: string,
  state: ProxyRoutingState,
  accountId?: string,
): ProxyRoute | null {
  const profiles = state.profiles ?? [];
  const account = accountId
    ? state.accounts?.find((item) => item.accountId === accountId && item.providerId === providerId)
    : undefined;
  let allowGlobal = true;

  if (account) {
    const accountRoute = routeFromPolicy(account, profiles);
    if (accountRoute) return accountRoute;
    allowGlobal = account.inheritGlobal !== false;
    if (account.inheritProvider === false) {
      return allowGlobal ? globalRoute(state) : null;
    }
  }

  const provider = state.providers.find((item) => item.providerId === providerId);
  const providerRoute = routeFromPolicy(provider, profiles);
  if (providerRoute) return providerRoute;

  if (provider?.inheritGlobal === false || !allowGlobal) return null;
  return globalRoute(state);
}

export function validateProxy(route: ProxyRoute): boolean {
  const { endpoint } = route;
  return Boolean(
    endpoint.host.trim()
      && Number.isInteger(endpoint.port)
      && endpoint.port > 0
      && endpoint.port < 65_536
      && ["http", "https", "socks4", "socks5"].includes(endpoint.protocol)
      && route.scopes.length > 0,
  );
}

export function shouldProxyUrl(
  rawUrl: string,
  traffic: ProxyTraffic,
  route: ProxyRoute | null,
): boolean {
  if (!route?.enabled || !validateProxy(route) || traffic === "local-control") return false;

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return false;
  }

  if (isLoopbackHost(target.hostname) || matchesBypass(target.hostname, route.bypass)) {
    return false;
  }

  return route.scopes.includes("all") || route.scopes.includes(traffic);
}

export function proxyUrl(route: ProxyRoute): string | null {
  if (!validateProxy(route)) return null;
  const protocol = route.endpoint.protocol;
  const host = route.endpoint.host.includes(":")
    ? `[${normalizeHostname(route.endpoint.host)}]`
    : normalizeHostname(route.endpoint.host);
  return `${protocol}://${host}:${route.endpoint.port}`;
}
'''


def patch_types() -> bool:
    changed = insert_after_surface("desktop-electron/src/types.ts", PROVIDER_TYPES)
    changed |= replace_once(
        "desktop-electron/src/types.ts",
        "  logs(limit?: number): Promise<LogRecord[]>;\n",
        PROVIDER_METHODS + "  logs(limit?: number): Promise<LogRecord[]>;\n",
        "LAUNCHER_PROVIDER_METHODS",
    )
    changed |= replace_once(
        "desktop-electron/src/types.ts",
        "  onUpdateState(listener: (state: UpdateState) => void): () => void;\n",
        "  onUpdateState(listener: (state: UpdateState) => void): () => void;\n"
        "  onProviderNetworkChanged(listener: (state: ProviderNetworkSnapshot) => void): () => void;\n",
        "LAUNCHER_PROVIDER_EVENT",
    )
    return changed


def patch_preload() -> bool:
    changed = replace_once(
        "desktop-electron/electron/preload.cjs",
        '  logs: (limit) => ipcRenderer.invoke("launcher:logs", limit),\n',
        PRELOAD_METHODS + '  logs: (limit) => ipcRenderer.invoke("launcher:logs", limit),\n',
        "PRELOAD_PROVIDER_METHODS",
    )
    changed |= replace_once(
        "desktop-electron/electron/preload.cjs",
        '  onUpdateState: (listener) => subscription("launcher:update-state", listener),\n',
        '  onUpdateState: (listener) => subscription("launcher:update-state", listener),\n'
        '  onProviderNetworkChanged: (listener) => subscription("launcher:provider-network-changed", listener),\n',
        "PRELOAD_PROVIDER_EVENT",
    )
    return changed


def patch_renderer_entry() -> bool:
    changed = replace_once(
        "desktop-electron/src/main.tsx",
        'import { App } from "./App";\n',
        'import { App } from "./App";\nimport { ProviderHubIntegration } from "./providers/ProviderHubIntegration";\n',
        "RENDERER_PROVIDER_IMPORT",
    )
    changed |= replace_once(
        "desktop-electron/src/main.tsx",
        "    <App />\n",
        "    <ProviderHubIntegration>\n      <App />\n    </ProviderHubIntegration>\n",
        "RENDERER_PROVIDER_WRAPPER",
    )
    return changed


def patch_package() -> bool:
    relative = "desktop-electron/package.json"
    package = json.loads(read(relative))
    if package.get("main") == "electron/main-with-provider.cjs":
        return False
    package["main"] = "electron/main-with-provider.cjs"
    write(relative, json.dumps(package, indent=2, ensure_ascii=False) + "\n")
    return True


def patch_provider_catalog() -> bool:
    relative = "desktop-electron/src/providers/provider-types.ts"
    text = read(relative)
    if "export const PROVIDER_CATALOG" in text:
        return False
    write(relative, text.rstrip() + "\n" + ADDITIONAL_PROVIDERS)
    return True


def patch_proxy_domain() -> bool:
    changed = read("desktop-electron/src/network/proxy-routing-types.ts") != PROXY_TYPES
    write("desktop-electron/src/network/proxy-routing-types.ts", PROXY_TYPES)
    manager_changed = read("desktop-electron/src/network/proxy-manager.ts") != PROXY_MANAGER
    write("desktop-electron/src/network/proxy-manager.ts", PROXY_MANAGER)
    return changed or manager_changed


def main() -> None:
    changes = {
        "types": patch_types(),
        "preload": patch_preload(),
        "renderer": patch_renderer_entry(),
        "package": patch_package(),
        "catalog": patch_provider_catalog(),
        "proxy": patch_proxy_domain(),
    }
    print(f"PROVIDER_HUB_CURRENT_RELEASE_OK changed={any(changes.values())} details={changes}")


if __name__ == "__main__":
    main()
