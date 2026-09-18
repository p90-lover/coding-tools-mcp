from __future__ import annotations

import json
from pathlib import Path


def replace_once(pathname: str, old: str, new: str) -> None:
    path = Path(pathname)
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one patch anchor in {pathname}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "desktop-electron/electron/managed-components.cjs",
    '''const COMPONENT_IDS = Object.freeze([
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);''',
    '''const COMPONENT_IDS = Object.freeze([
  "codex-router",
  "commandcode-proxy",
  "cpa",
  "paseo",
  "anneal",
]);''',
)

replace_once(
    "desktop-electron/electron/managed-components.cjs",
    '''  function ensureComponentSecrets(id) {
    const current = secretFor(id);
    if (id === "commandcode-proxy" && !current.proxyApiKey) {
      const next = { ...current, proxyApiKey: crypto.randomBytes(36).toString("base64url") };
      writeSecret(id, next);
      return next;
    }
    return current;
  }''',
    '''  function ensureComponentSecrets(id) {
    let current = secretFor(id);
    let changed = false;
    if ((id === "commandcode-proxy" || id === "cpa") && !current.proxyApiKey) {
      current = { ...current, proxyApiKey: crypto.randomBytes(36).toString("base64url") };
      changed = true;
    }
    if (id === "cpa" && !current.managementKey) {
      current = { ...current, managementKey: crypto.randomBytes(36).toString("base64url") };
      changed = true;
    }
    if (changed) writeSecret(id, current);
    return current;
  }''',
)

replace_once(
    "desktop-electron/electron/managed-components.cjs",
    '''  function healthHeaders(idValue) {
    const id = requiredComponentId(idValue);
    if (id !== "commandcode-proxy") return {};
    const proxyApiKey = ensureComponentSecrets(id).proxyApiKey;
    return proxyApiKey ? { Authorization: `Bearer ${proxyApiKey}` } : {};
  }''',
    '''  function runtimeSecrets(idValue) {
    const id = requiredComponentId(idValue);
    return { ...ensureComponentSecrets(id) };
  }

  function healthHeaders(idValue) {
    const id = requiredComponentId(idValue);
    const template = manifestFor(id).health?.authorization;
    if (!template) return {};
    const current = ensureComponentSecrets(id);
    const authorization = String(template).replace(
      /\\{secret:([A-Za-z0-9_-]+)\\}/g,
      (_match, key) => String(current[key] || ""),
    );
    if (!authorization || authorization.includes("{secret:")) {
      throw new Error(`${manifestFor(id).name} health credential is unavailable`);
    }
    return { Authorization: authorization };
  }''',
)

replace_once(
    "desktop-electron/electron/managed-components.cjs",
    '''    runtimeConfiguration,
    healthHeaders,
    dispose,''',
    '''    runtimeConfiguration,
    runtimeSecrets,
    healthHeaders,
    dispose,''',
)

replace_once(
    "desktop-electron/electron/external-services.cjs",
    '''const SERVICE_IDS = Object.freeze([
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);''',
    '''const SERVICE_IDS = Object.freeze([
  "codex-router",
  "commandcode-proxy",
  "cpa",
  "paseo",
  "anneal",
]);''',
)

replace_once(
    "desktop-electron/electron/external-services.cjs",
    '''  "commandcode-proxy": Object.freeze({
    name: "CommandCode Proxy",
    endpoint: "http://127.0.0.1:9090/",
    home: "",
    executable: "",
    arguments: [],
    enabled: true,
    autoStart: false,
  }),
  paseo: Object.freeze({''',
    '''  "commandcode-proxy": Object.freeze({
    name: "CommandCode Proxy",
    endpoint: "http://127.0.0.1:9090/",
    home: "",
    executable: "",
    arguments: [],
    enabled: true,
    autoStart: false,
  }),
  cpa: Object.freeze({
    name: "CPA / CLIProxyAPI",
    endpoint: "http://127.0.0.1:8317/",
    home: "",
    executable: "",
    arguments: [],
    enabled: true,
    autoStart: false,
  }),
  paseo: Object.freeze({''',
)

replace_once(
    "desktop-electron/electron/external-services.cjs",
    '''          : id === "codex-router"
            ? env.CODING_TOOLS_CODEX_ROUTER_URL
            : env.CODING_TOOLS_COMMANDCODE_URL;''',
    '''          : id === "codex-router"
            ? env.CODING_TOOLS_CODEX_ROUTER_URL
            : id === "commandcode-proxy"
              ? env.CODING_TOOLS_COMMANDCODE_URL
              : env.CODING_TOOLS_CPA_URL;''',
)

replace_once(
    "desktop-electron/electron/external-services.cjs",
    '''    const selected = id === "commandcode-proxy"
      ? accounts.filter((account) => account.providerId === "commandcode-proxy" && !account.archivedAt)
      : id === "codex-router"
        ? accounts.filter((account) => account.enabled !== false && !account.archivedAt)
        : [];''',
    '''    const selected = id === "commandcode-proxy"
      ? accounts.filter((account) => account.providerId === "commandcode-proxy" && !account.archivedAt)
      : id === "cpa"
        ? accounts.filter((account) => (
            !account.archivedAt
              && (
                account.credentialSource === "cpa"
                || String(account.loginAdapterId || "").startsWith("cpa-")
                || account.providerId === "cliproxyapi-antigravity"
              )
          ))
        : id === "codex-router"
          ? accounts.filter((account) => account.enabled !== false && !account.archivedAt)
          : [];''',
)

replace_once(
    "desktop-electron/electron/external-services.cjs",
    '''    if (id === "commandcode-proxy") return new URL("/v1/models", config.endpoint).toString();
    return config.endpoint;''',
    '''    if (id === "commandcode-proxy" || id === "cpa") {
      return new URL("/v1/models", config.endpoint).toString();
    }
    return config.endpoint;''',
)

replace_once(
    "desktop-electron/electron/external-services.cjs",
    '''    const router = state.services["codex-router"];
    const commandCode = state.services["commandcode-proxy"];
    const callerKey = secretFor("codex-router").callerKey;
    return Object.freeze({
      CODING_TOOLS_CODEX_ROUTER_URL: router.endpoint.replace(/\\/$/, ""),
      ...(callerKey ? { CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: callerKey } : {}),
      CODING_TOOLS_COMMANDCODE_URL: commandCode.endpoint.replace(/\\/$/, ""),''',
    '''    const router = state.services["codex-router"];
    const commandCode = state.services["commandcode-proxy"];
    const cpa = state.services.cpa;
    const callerKey = secretFor("codex-router").callerKey;
    return Object.freeze({
      CODING_TOOLS_CODEX_ROUTER_URL: router.endpoint.replace(/\\/$/, ""),
      ...(callerKey ? { CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: callerKey } : {}),
      CODING_TOOLS_COMMANDCODE_URL: commandCode.endpoint.replace(/\\/$/, ""),
      CODING_TOOLS_CPA_URL: cpa.endpoint.replace(/\\/$/, ""),''',
)

replace_once(
    "desktop-electron/electron/managed-external-services.cjs",
    '''  "commandcode-proxy": Object.freeze({ endpoint: "http://127.0.0.1:9090/" }),
  paseo: Object.freeze({''',
    '''  "commandcode-proxy": Object.freeze({ endpoint: "http://127.0.0.1:9090/" }),
  cpa: Object.freeze({ endpoint: "http://127.0.0.1:8317/" }),
  paseo: Object.freeze({''',
)

replace_once(
    "desktop-electron/electron/managed-external-services.cjs",
    '''  function dispose() {
    managedController.dispose();''',
    '''  function cpaConnection() {
    const managed = managedController.project("cpa");
    if (managed.installState !== "installed") return null;
    const secrets = managedController.runtimeSecrets("cpa");
    const managementKey = String(secrets.managementKey || "").trim();
    const proxyApiKey = String(secrets.proxyApiKey || "").trim();
    if (!managementKey || !proxyApiKey) {
      throw new Error("Managed CPA credentials are unavailable");
    }
    return {
      baseUrl: SERVICE_ENDPOINTS.cpa.endpoint.replace(/\\/$/, ""),
      managementKey,
      proxyApiKey,
    };
  }

  function dispose() {
    managedController.dispose();''',
)

replace_once(
    "desktop-electron/electron/managed-external-services.cjs",
    '''    upstreamConfiguration,
    installManagedComponent,''',
    '''    upstreamConfiguration,
    cpaConnection,
    installManagedComponent,''',
)

replace_once(
    "desktop-electron/electron/provider-bootstrap.cjs",
    '''let providerNetworkControllerPromise = null;
let providerBrowserHostGetter = () => null;''',
    '''let providerNetworkControllerPromise = null;
let providerBrowserHostGetter = () => null;
let providerCpaConnectionGetter = () => null;''',
)

replace_once(
    "desktop-electron/electron/provider-bootstrap.cjs",
    '''function providerNetworkReady() {
  if (!providerNetworkControllerPromise) {''',
    '''function setProviderCpaConnection(getter) {
  if (typeof getter !== "function") {
    throw new Error("Provider CPA connection getter must be a function");
  }
  providerCpaConnectionGetter = getter;
}

function providerNetworkReady() {
  if (!providerNetworkControllerPromise) {''',
)

replace_once(
    "desktop-electron/electron/provider-bootstrap.cjs",
    '''      getBrowserHost: () => providerBrowserHostGetter?.() ?? null,
      logger,''',
    '''      getBrowserHost: () => providerBrowserHostGetter?.() ?? null,
      getCpaConnection: () => providerCpaConnectionGetter?.() ?? null,
      logger,''',
)

replace_once(
    "desktop-electron/electron/provider-bootstrap.cjs",
    '''  providerNetworkReady,
  setProviderBrowserHost,
};''',
    '''  providerNetworkReady,
  setProviderBrowserHost,
  setProviderCpaConnection,
};''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  browserPartition,
  getBrowserHost,
  logger,''',
    '''  browserPartition,
  getBrowserHost,
  getCpaConnection = null,
  logger,''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  function cpaConnection(account) {
    const secret = store.accountSecret(account.id) || {};
    const managementKey = String(secret.managementKey ?? secret.credential ?? "").trim();
    if (!managementKey) throw new Error("Enter the CPA / CLIProxyAPI management key before login or testing");
    const baseUrl = normalizeProviderBaseUrl(
      account.endpoint || secret.baseUrl || DEFAULT_CPA_BASE_URL,
    );
    return { baseUrl, managementKey };
  }''',
    '''  function cpaConnection(account) {
    const managed = getCpaConnection?.();
    const managedKey = String(managed?.managementKey || "").trim();
    if (managedKey) {
      return {
        baseUrl: normalizeProviderBaseUrl(managed.baseUrl || DEFAULT_CPA_BASE_URL),
        managementKey: managedKey,
        proxyApiKey: String(managed.proxyApiKey || "").trim(),
      };
    }

    const secret = store.accountSecret(account.id) || {};
    const managementKey = String(secret.managementKey ?? secret.credential ?? "").trim();
    if (!managementKey) {
      throw new Error("Install managed CPA or enter an external CPA / CLIProxyAPI management key before login or testing");
    }
    const baseUrl = normalizeProviderBaseUrl(
      account.endpoint || secret.baseUrl || DEFAULT_CPA_BASE_URL,
    );
    return { baseUrl, managementKey, proxyApiKey: String(secret.apiKey || "").trim() };
  }''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    if (account.providerId === "codex-oauth") {
      const secret = store.accountSecret(account.id) || {};
      return secret.managementKey || secret.credential ? "cpa-codex" : "native-browser";
    }''',
    '''    if (account.providerId === "codex-oauth") {
      const managed = getCpaConnection?.();
      const secret = store.accountSecret(account.id) || {};
      return managed?.managementKey || secret.managementKey || secret.credential
        ? "cpa-codex"
        : "native-browser";
    }''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''  providerNetworkReady,
  setProviderBrowserHost,
} = require("./provider-bootstrap.cjs");''',
    '''  providerNetworkReady,
  setProviderBrowserHost,
  setProviderCpaConnection,
} = require("./provider-bootstrap.cjs");''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''  });
  upstreamToolController = createUpstreamToolController({
    env: process.env,''',
    '''  });
  setProviderCpaConnection(() => externalServicesController?.cpaConnection());
  upstreamToolController = createUpstreamToolController({
    env: process.env,''',
)

replace_once(
    "desktop-electron/src/types.ts",
    '''export type ExternalServiceId = "codex-router" | "commandcode-proxy" | "paseo" | "anneal";''',
    '''export type ExternalServiceId = "codex-router" | "commandcode-proxy" | "cpa" | "paseo" | "anneal";''',
)

replace_once(
    "desktop-electron/src/features/ExternalServicesSurface.tsx",
    '''    "commandcode-proxy": ["CommandCode Proxy", "CommandCode 代理"],
    paseo: ["Paseo", "Paseo"],''',
    '''    "commandcode-proxy": ["CommandCode Proxy", "CommandCode 代理"],
    cpa: ["CPA / CLIProxyAPI", "CPA／CLIProxyAPI"],
    paseo: ["Paseo", "Paseo"],''',
)

replace_once(
    "desktop-electron/src/features/ExternalServicesSurface.tsx",
    '''            "Install, repair and run Codex Router, CommandCode Proxy, Paseo and Anneal from Coding Tools while CPA Provider Hub remains the encrypted account and routing authority.",
            "直接由 Coding Tools 安裝、修復同執行 Codex Router、CommandCode Proxy、Paseo 與 Anneal；CPA 供應商中心繼續作為加密帳戶同路由權限來源。",''',
    '''            "Install, repair and run CPA / CLIProxyAPI, Codex Router, CommandCode Proxy, Paseo and Anneal from Coding Tools while Provider Hub remains the encrypted account and routing authority.",
            "直接由 Coding Tools 安裝、修復同執行 CPA／CLIProxyAPI、Codex Router、CommandCode Proxy、Paseo 與 Anneal；供應商中心繼續作為加密帳戶同路由權限來源。",''',
)

package_path = Path("desktop-electron/package.json")
package = json.loads(package_path.read_text(encoding="utf-8"))
unpacked = package.setdefault("build", {}).setdefault("asarUnpack", [])
if "electron/cpa-managed.cjs" not in unpacked:
    unpacked.append("electron/cpa-managed.cjs")
package_path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

replace_once(
    "desktop-electron/tests/managed-components-runtime.test.cjs",
    '''const COMPONENT_IDS = ["codex-router", "commandcode-proxy", "paseo", "anneal"];''',
    '''const COMPONENT_IDS = ["codex-router", "commandcode-proxy", "cpa", "paseo", "anneal"];''',
)

replace_once(
    "desktop-electron/tests/managed-components-runtime.test.cjs",
    '''      endpoint: `http://127.0.0.1:${id === "codex-router" ? 4202 : id === "commandcode-proxy" ? 9090 : id === "paseo" ? 6768 : 5173}/`,''',
    '''      endpoint: `http://127.0.0.1:${id === "codex-router" ? 4202 : id === "commandcode-proxy" ? 9090 : id === "cpa" ? 8317 : id === "paseo" ? 6768 : 5173}/`,''',
)

replace_once(
    "desktop-electron/tests/external-services-control-plane.test.cjs",
    '''test("external service controller owns the four architecture-B services and rejects remote endpoints", () => {''',
    '''test("external service controller owns the five app-managed services and rejects remote endpoints", () => {''',
)

replace_once(
    "desktop-electron/tests/external-services-control-plane.test.cjs",
    '''    "codex-router",
    "commandcode-proxy",
    "paseo",
    "anneal",''',
    '''    "codex-router",
    "commandcode-proxy",
    "cpa",
    "paseo",
    "anneal",''',
)

replace_once(
    "desktop-electron/tests/rc9-managed-five-stack.test.cjs",
    '''const COMPONENT_IDS = ["codex-router", "commandcode-proxy", "paseo", "anneal"];''',
    '''const COMPONENT_IDS = ["codex-router", "commandcode-proxy", "cpa", "paseo", "anneal"];''',
)

print("RC9_MANAGED_CPA_RUNTIME_MATERIALIZED")
