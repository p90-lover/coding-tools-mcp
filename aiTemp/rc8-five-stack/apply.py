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


def replace_all(relative: str, before: str, after: str, minimum: int = 1) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if after in text and before not in text:
        print(f"already applied: {relative}")
        return
    count = text.count(before)
    if count < minimum:
        raise SystemExit(
            f"expected at least {minimum} anchors in {relative}, found {count}: {before[:180]!r}"
        )
    path.write_text(text.replace(before, after), encoding="utf-8")
    print(f"patched {count} anchors: {relative}")


def patch_external_services() -> None:
    path = "desktop-electron/electron/external-services.cjs"
    replace_once(
        path,
        '''  paseo: Object.freeze({
    name: "Paseo",
    endpoint: "http://127.0.0.1:6768/",
''',
        '''  paseo: Object.freeze({
    name: "Paseo",
    endpoint: "http://127.0.0.1:6768/",
    executionEndpoint: "ws://127.0.0.1:6767/ws",
''',
    )
    replace_once(
        path,
        '''  anneal: Object.freeze({
    name: "Anneal",
    endpoint: "http://127.0.0.1:3000/",
''',
        '''  anneal: Object.freeze({
    name: "Anneal",
    endpoint: "http://127.0.0.1:3000/",
    executionEndpoint: "http://127.0.0.1:3000/",
''',
    )
    replace_once(
        path,
        '''function createSecretCodec({ safeStorage, keyPath }) {
''',
        '''function normalizeLoopbackExecutionEndpoint(value, serviceId) {
  const id = requiredServiceId(serviceId);
  if (id !== "paseo" && id !== "anneal") {
    throw new Error(`Service ${id} does not expose an execution endpoint`);
  }
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${DEFAULTS[id].name} execution endpoint must be a valid URL`);
  }
  const allowed = id === "paseo"
    ? new Set(["ws:", "wss:"])
    : new Set(["http:", "https:"]);
  if (!allowed.has(parsed.protocol)) {
    throw new Error(
      id === "paseo"
        ? "Paseo execution endpoint must use WebSocket (WS or WSS)"
        : "Anneal execution endpoint must use HTTP or HTTPS",
    );
  }
  const hostname = parsed.hostname.replace(/^\\[|\\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("Execution endpoints are restricted to loopback hosts");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Execution endpoints must not contain credentials, query parameters, or fragments");
  }
  if (id === "anneal" && !parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function createSecretCodec({ safeStorage, keyPath }) {
''',
    )
    replace_once(
        path,
        '''      const environmentEndpoint = id === "paseo"
        ? env.CODING_TOOLS_PASEO_URL
        : id === "anneal"
          ? env.CODING_TOOLS_ANNEAL_URL
          : id === "codex-router"
            ? env.CODING_TOOLS_CODEX_ROUTER_URL
            : env.CODING_TOOLS_COMMANDCODE_URL;
      return [id, {
        ...defaults,
        endpoint: normalizeLoopbackServiceEndpoint(environmentEndpoint || defaults.endpoint),
        home: optionalText(environmentHome) || defaults.home,
      }];
''',
        '''      const environmentEndpoint = id === "paseo"
        ? env.CODING_TOOLS_PASEO_URL
        : id === "anneal"
          ? env.CODING_TOOLS_ANNEAL_URL
          : id === "codex-router"
            ? env.CODING_TOOLS_CODEX_ROUTER_URL
            : env.CODING_TOOLS_COMMANDCODE_URL;
      const environmentExecutionEndpoint = id === "paseo"
        ? env.CODING_TOOLS_PASEO_EXECUTION_URL
        : id === "anneal"
          ? env.CODING_TOOLS_ANNEAL_EXECUTION_URL
          : undefined;
      return [id, {
        ...defaults,
        endpoint: normalizeLoopbackServiceEndpoint(environmentEndpoint || defaults.endpoint),
        ...(defaults.executionEndpoint ? {
          executionEndpoint: normalizeLoopbackExecutionEndpoint(
            environmentExecutionEndpoint || defaults.executionEndpoint,
            id,
          ),
        } : {}),
        home: optionalText(environmentHome) || defaults.home,
      }];
''',
    )
    replace_once(
        path,
        '''    let endpoint = defaults.endpoint;
    try { endpoint = normalizeLoopbackServiceEndpoint(input.endpoint || defaults.endpoint); } catch {}
    services[id] = {
      ...defaults,
      endpoint,
''',
        '''    let endpoint = defaults.endpoint;
    try { endpoint = normalizeLoopbackServiceEndpoint(input.endpoint || defaults.endpoint); } catch {}
    let executionEndpoint = defaults.executionEndpoint;
    if (executionEndpoint) {
      try {
        executionEndpoint = normalizeLoopbackExecutionEndpoint(
          input.executionEndpoint || defaults.executionEndpoint,
          id,
        );
      } catch {}
    }
    services[id] = {
      ...defaults,
      endpoint,
      ...(executionEndpoint ? { executionEndpoint } : {}),
''',
    )
    replace_once(
        path,
        '''      id,
      name: DEFAULTS[id].name,
      endpoint: config.endpoint,
      home: config.home,
''',
        '''      id,
      name: DEFAULTS[id].name,
      endpoint: config.endpoint,
      ...(config.executionEndpoint ? { executionEndpoint: config.executionEndpoint } : {}),
      home: config.home,
''',
    )
    replace_once(
        path,
        '''      ...(input.endpoint !== undefined
        ? { endpoint: normalizeLoopbackServiceEndpoint(input.endpoint) }
        : {}),
      ...(input.home !== undefined ? { home: optionalText(input.home) || "" } : {}),
''',
        '''      ...(input.endpoint !== undefined
        ? { endpoint: normalizeLoopbackServiceEndpoint(input.endpoint) }
        : {}),
      ...((id === "paseo" || id === "anneal") && input.executionEndpoint !== undefined
        ? { executionEndpoint: normalizeLoopbackExecutionEndpoint(input.executionEndpoint, id) }
        : {}),
      ...(input.home !== undefined ? { home: optionalText(input.home) || "" } : {}),
''',
    )
    replace_once(
        path,
        '''      CODING_TOOLS_COMMANDCODE_URL: commandCode.endpoint.replace(/\/$/, ""),
    });
''',
        '''      CODING_TOOLS_COMMANDCODE_URL: commandCode.endpoint.replace(/\/$/, ""),
      CODING_TOOLS_PASEO_EXECUTION_URL: state.services.paseo.executionEndpoint,
      CODING_TOOLS_ANNEAL_EXECUTION_URL: state.services.anneal.executionEndpoint,
    });
''',
    )
    replace_once(
        path,
        '''    return {
      endpoint: config.endpoint,
      home: config.home,
''',
        '''    return {
      endpoint: config.endpoint,
      executionEndpoint: config.executionEndpoint,
      home: config.home,
''',
    )
    replace_once(
        path,
        '''  createExternalServicesController,
  normalizeLoopbackServiceEndpoint,
};
''',
        '''  createExternalServicesController,
  normalizeLoopbackExecutionEndpoint,
  normalizeLoopbackServiceEndpoint,
};
''',
    )


def patch_provider_execution_router() -> None:
    path = "desktop-electron/electron/provider-execution-router.cjs"
    replace_once(
        path,
        'const WORKLOADS = new Set(["paseo", "anneal"]);\n',
        'const WORKLOADS = new Set(["subagent", "paseo", "anneal"]);\n',
    )
    replace_all(
        path,
        'paseoEnabled: true, annealEnabled: true',
        'subagentEnabled: true, paseoEnabled: true, annealEnabled: true',
        minimum=10,
    )
    replace_once(
        path,
        '    throw new Error("Workload must be paseo or anneal");\n',
        '    throw new Error("Workload must be subagent, paseo or anneal");\n',
    )
    replace_once(
        path,
        '''function eligibleProviders(workload, catalog) {
  const flag = workload === "paseo" ? "paseoEnabled" : "annealEnabled";
''',
        '''function eligibleProviders(workload, catalog) {
  const flag = workload === "subagent"
    ? "subagentEnabled"
    : workload === "paseo"
      ? "paseoEnabled"
      : "annealEnabled";
''',
    )


def patch_provider_network() -> None:
    path = "desktop-electron/electron/provider-network.cjs"
    replace_once(
        path,
        '''  "provider",
  "oauth",
  "paseo",
''',
        '''  "provider",
  "oauth",
  "subagent",
  "paseo",
''',
    )
    replace_once(
        path,
        '''  async function openProviderLogin(accountId) {
    const account = accountRecord(accountId);
    if (account.providerId === "chatgpt-web" || account.providerId === "codex-oauth") {
      const browser = await getBrowserHost()?.openLogin();
      return { opened: true, mode: "embedded", browser: browser || null };
    }
''',
        '''  async function syncBrowserProviderAccount(account) {
    const browserHost = typeof getBrowserHost === "function" ? getBrowserHost() : null;
    if (!browserHost || typeof browserHost.openLogin !== "function") {
      throw new Error("Browser provider login is unavailable");
    }
    store.updateAccountConnection(account.id, { status: "pending", error: undefined });
    const browser = await browserHost.openLogin();
    if (!browser || browser.authenticated !== true) {
      const snapshot = store.updateAccountConnection(account.id, {
        status: "pending",
        error: "Complete the ChatGPT sign-in before connecting this provider account",
      });
      const error = new Error("Browser provider login did not establish an authenticated session");
      error.snapshot = snapshot;
      throw error;
    }
    const snapshot = store.updateAccountConnection(account.id, {
      status: "connected",
      error: undefined,
      models: account.models,
    });
    return { opened: true, mode: "embedded", browser, snapshot };
  }

  async function openProviderLogin(accountId) {
    const account = accountRecord(accountId);
    if (account.providerId === "chatgpt-web" || account.providerId === "codex-oauth") {
      return syncBrowserProviderAccount(account);
    }
''',
    )


def patch_types() -> None:
    path = "desktop-electron/src/types.ts"
    replace_once(
        path,
        '''  | "provider"
  | "oauth"
  | "paseo"
''',
        '''  | "provider"
  | "oauth"
  | "subagent"
  | "paseo"
''',
    )
    replace_once(
        path,
        'export type ProviderExecutionWorkload = "paseo" | "anneal";\n',
        'export type ProviderExecutionWorkload = "subagent" | "paseo" | "anneal";\n',
    )
    replace_once(
        path,
        '''  endpoint: string;
  home: string;
''',
        '''  endpoint: string;
  executionEndpoint?: string;
  home: string;
''',
    )
    replace_once(
        path,
        '''  endpoint?: string;
  home?: string;
''',
        '''  endpoint?: string;
  executionEndpoint?: string;
  home?: string;
''',
    )


def patch_provider_types() -> None:
    path = "desktop-electron/src/providers/provider-types.ts"
    replace_once(
        path,
        '''  loginMode?: ProviderLoginMode;
  paseoEnabled: boolean;
''',
        '''  loginMode?: ProviderLoginMode;
  subagentEnabled: boolean;
  paseoEnabled: boolean;
''',
    )
    replace_all(
        path,
        '    paseoEnabled: true,\n',
        '    subagentEnabled: true,\n    paseoEnabled: true,\n',
        minimum=10,
    )


def patch_agent_adapter() -> None:
    path = ROOT / "desktop-electron/src/agents/agent-provider-adapter.ts"
    content = '''import type {
  LauncherApi,
  ProviderExecutionPlan,
} from "../types";
import {
  PROVIDER_CATALOG,
  type ProviderDefinition,
} from "../providers/provider-types";
import type { AgentProfile, ModelAgentProfile } from "./subagent-types";

export interface AgentProviderResolution {
  compatible: boolean;
  provider?: ProviderDefinition;
  errors: string[];
}

export interface AgentExecutionOptions {
  accountId?: string;
  allowFallback?: boolean;
}

export interface AgentProviderExecution {
  provider: ProviderDefinition;
  plan: ProviderExecutionPlan;
}

export function resolveAgentProvider(
  agent: AgentProfile,
  providers: readonly ProviderDefinition[],
): AgentProviderResolution {
  if (agent.kind !== "model") {
    return {
      compatible: false,
      errors: ["orchestrator agents do not resolve model providers"],
    };
  }

  return resolveModelAgentProvider(agent, providers);
}

function resolveModelAgentProvider(
  agent: ModelAgentProfile,
  providers: readonly ProviderDefinition[],
): AgentProviderResolution {
  const provider = providers.find((candidate) => candidate.id === agent.providerId);
  if (!provider) {
    return {
      compatible: false,
      errors: [`provider ${agent.providerId} is not registered`],
    };
  }

  const missingCapabilities = agent.capabilities.filter(
    (capability) => !provider.capabilities.includes(capability),
  );
  const errors = missingCapabilities.map(
    (capability) => `provider ${provider.id} does not support ${capability}`,
  );

  if (!provider.subagentEnabled) {
    errors.push(`provider ${provider.id} is not enabled for subagent execution`);
  }
  if (provider.models.length > 0 && !provider.models.includes(agent.model)) {
    errors.push(`provider ${provider.id} does not advertise model ${agent.model}`);
  }

  return {
    compatible: errors.length === 0,
    provider,
    errors,
  };
}

export async function planAgentExecution(
  agent: ModelAgentProfile,
  api: Pick<LauncherApi, "providerExecutionPlan">,
  options: AgentExecutionOptions = {},
  providers: readonly ProviderDefinition[] = PROVIDER_CATALOG,
): Promise<AgentProviderExecution> {
  const resolution = resolveModelAgentProvider(agent, providers);
  if (!resolution.compatible || !resolution.provider) {
    throw new Error(resolution.errors.join("; ") || "Agent provider is unavailable");
  }

  const plan = await api.providerExecutionPlan({
    workload: "subagent",
    providerId: resolution.provider.id,
    accountId: options.accountId,
    model: agent.model,
    allowFallback: options.allowFallback ?? true,
  });

  if (plan.workload !== "subagent") {
    throw new Error("Codex Router returned a non-subagent execution plan");
  }
  if (!plan.credentialHandle?.providerId || !plan.credentialHandle?.accountId) {
    throw new Error("Codex Router returned an invalid credential handle");
  }
  return { provider: resolution.provider, plan };
}
'''
    if path.read_text(encoding="utf-8") == content:
        print(f"already applied: {path.relative_to(ROOT)}")
        return
    path.write_text(content, encoding="utf-8")
    print(f"patched: {path.relative_to(ROOT)}")


def patch_provider_surface() -> None:
    path = "desktop-electron/src/features/ProviderHubSaasSurface.tsx"
    replace_once(
        path,
        '''import type {
  Language,
''',
        '''import type {
  ExternalServicesSnapshot,
  Language,
''',
    )
    replace_once(
        path,
        '''const ACCOUNT_STATUSES: readonly ProviderAccountStatus[] = [
''',
        '''const EMPTY_EXTERNAL_SERVICES: ExternalServicesSnapshot = { version: 1, services: [] };

const ACCOUNT_STATUSES: readonly ProviderAccountStatus[] = [
''',
    )
    replace_once(
        path,
        '''function defaultEngineEndpoint(workload: ProviderExecutionWorkload): string {
  return workload === "paseo"
    ? "ws://127.0.0.1:6767/ws"
    : "http://127.0.0.1:3000/";
}
''',
        '''function defaultEngineEndpoint(
  workload: ProviderExecutionWorkload,
  services: ExternalServicesSnapshot,
): string {
  if (workload === "subagent") return "http://127.0.0.1:4202/";
  const configured = services.services.find((service) => service.id === workload)?.executionEndpoint;
  if (configured) return configured;
  return workload === "paseo"
    ? "ws://127.0.0.1:6767/ws"
    : "http://127.0.0.1:3000/";
}
''',
    )
    replace_once(
        path,
        '''  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot>(EMPTY_SNAPSHOT);
  const [providerSearch, setProviderSearch] = useState("");
''',
        '''  const [snapshot, setSnapshot] = useState<ProviderNetworkSnapshot>(EMPTY_SNAPSHOT);
  const [externalServices, setExternalServices] = useState<ExternalServicesSnapshot>(EMPTY_EXTERNAL_SERVICES);
  const [providerSearch, setProviderSearch] = useState("");
''',
    )
    replace_once(
        path,
        '''  const [workload, setWorkload] = useState<ProviderExecutionWorkload>("anneal");
  const [engineEndpoint, setEngineEndpoint] = useState(defaultEngineEndpoint("anneal"));
''',
        '''  const [workload, setWorkload] = useState<ProviderExecutionWorkload>("anneal");
  const [engineEndpoint, setEngineEndpoint] = useState(
    defaultEngineEndpoint("anneal", EMPTY_EXTERNAL_SERVICES),
  );
''',
    )
    replace_once(
        path,
        '''    void launcher.providerSnapshot()
      .then((next) => {
        if (active) adoptSnapshot(next);
      })
      .catch((cause) => {
        if (active) setError(messageOf(cause));
      });
    const unsubscribe = launcher.onProviderNetworkChanged((next) => {
      if (active) adoptSnapshot(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
''',
        '''    void Promise.all([
      launcher.providerSnapshot(),
      launcher.externalServicesSnapshot(),
    ])
      .then(([nextProviders, nextServices]) => {
        if (!active) return;
        adoptSnapshot(nextProviders);
        setExternalServices(nextServices);
      })
      .catch((cause) => {
        if (active) setError(messageOf(cause));
      });
    const unsubscribeProviders = launcher.onProviderNetworkChanged((next) => {
      if (active) adoptSnapshot(next);
    });
    const unsubscribeServices = launcher.onExternalServicesChanged((next) => {
      if (active) setExternalServices(next);
    });
    return () => {
      active = false;
      unsubscribeProviders();
      unsubscribeServices();
    };
''',
    )
    replace_once(
        path,
        '''  useEffect(() => {
    void refreshBindings().catch((cause) => setError(messageOf(cause)));
  }, [refreshBindings, setError]);
''',
        '''  useEffect(() => {
    void refreshBindings().catch((cause) => setError(messageOf(cause)));
  }, [refreshBindings, setError]);

  useEffect(() => {
    setEngineEndpoint(defaultEngineEndpoint(workload, externalServices));
  }, [externalServices, workload]);
''',
    )
    replace_all(
        path,
        'setEngineEndpoint(defaultEngineEndpoint(next));',
        'setEngineEndpoint(defaultEngineEndpoint(next, externalServices));',
        minimum=1,
    )


def patch_external_services_surface() -> None:
    path = "desktop-electron/src/features/ExternalServicesSurface.tsx"
    replace_once(
        path,
        '''interface ServiceDraft {
  endpoint: string;
  home: string;
''',
        '''interface ServiceDraft {
  endpoint: string;
  executionEndpoint: string;
  home: string;
''',
    )
    replace_once(
        path,
        '''  return {
    endpoint: service.endpoint,
    home: service.home,
''',
        '''  return {
    endpoint: service.endpoint,
    executionEndpoint: service.executionEndpoint ?? "",
    home: service.home,
''',
    )
    replace_once(
        path,
        '''    const input: ExternalServiceConfigurationInput = {
      endpoint: draft.endpoint,
      home: draft.home,
''',
        '''    const input: ExternalServiceConfigurationInput = {
      endpoint: draft.endpoint,
      ...((selected.id === "paseo" || selected.id === "anneal")
        ? { executionEndpoint: draft.executionEndpoint }
        : {}),
      home: draft.home,
''',
    )
    replace_once(
        path,
        '''            <label>
              <span>{text(language, "Source / working directory", "原始碼／工作目錄")}</span>
''',
        '''            {selected.id === "paseo" || selected.id === "anneal" ? (
              <label className="wide-field">
                <span>{text(language, "Execution endpoint", "執行端點")}</span>
                <input
                  value={draft.executionEndpoint}
                  onChange={(event) => setDraft({ ...draft, executionEndpoint: event.target.value })}
                />
              </label>
            ) : null}
            <label>
              <span>{text(language, "Source / working directory", "原始碼／工作目錄")}</span>
''',
    )


def main() -> None:
    patch_external_services()
    patch_provider_execution_router()
    patch_provider_network()
    patch_types()
    patch_provider_types()
    patch_agent_adapter()
    patch_provider_surface()
    patch_external_services_surface()
    print("RC8_FIVE_STACK_ROUTING_APPLIED")


if __name__ == "__main__":
    main()
