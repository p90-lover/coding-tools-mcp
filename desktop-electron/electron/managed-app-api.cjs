"use strict";

const APP_HANDLES = Object.freeze([
  "cpa",
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);
const APP_HANDLE_SET = new Set(APP_HANDLES);
const ORIGINAL_UI_HANDLES = new Set(["cpa", "codex-router"]);
const UPSTREAM_HANDLES = new Set(["paseo", "anneal"]);
const LIFECYCLE_OPERATIONS = Object.freeze([
  "inspect",
  "install",
  "repair",
  "start",
  "stop",
  "restart",
]);
const APP_DEFINITIONS = Object.freeze({
  cpa: Object.freeze({
    name: "CPA / CLIProxyAPI",
    kind: "provider-network",
    operations: Object.freeze([
      ...LIFECYCLE_OPERATIONS,
      "providers",
      "plan",
      "ui-inspect",
      "ui-start",
      "ui-stop",
      "ui-restart",
      "ui-open",
    ]),
  }),
  "codex-router": Object.freeze({
    name: "Codex Router",
    kind: "managed-service",
    operations: Object.freeze([
      ...LIFECYCLE_OPERATIONS,
      "sync",
      "ui-inspect",
      "ui-start",
      "ui-stop",
      "ui-restart",
      "ui-open",
    ]),
  }),
  "commandcode-proxy": Object.freeze({
    name: "CommandCode Proxy",
    kind: "managed-service",
    operations: Object.freeze([
      ...LIFECYCLE_OPERATIONS,
      "registration-plan",
      "registration-apply",
    ]),
  }),
  paseo: Object.freeze({
    name: "Paseo",
    kind: "managed-upstream",
    operations: Object.freeze([...LIFECYCLE_OPERATIONS, "open", "act"]),
  }),
  anneal: Object.freeze({
    name: "Anneal",
    kind: "managed-upstream",
    operations: Object.freeze([...LIFECYCLE_OPERATIONS, "open", "act"]),
  }),
});
const MUTATING_OPERATIONS = new Set([
  "install",
  "repair",
  "start",
  "stop",
  "restart",
  "sync",
  "ui-start",
  "ui-stop",
  "ui-restart",
  "ui-open",
  "registration-apply",
  "open",
  "act",
]);
const PLAN_WORKLOADS = new Set(["subagent", "paseo", "anneal"]);
const SENSITIVE_KEY = /(?:^|_)(?:access_token|refresh_token|api_key|private_key|client_secret|password|secret|token|credential|bearer|authorization|caller_key|proxy_api_key|management_key|session_cookie)(?:_|$)/i;
const MAX_DEPTH = 24;
const MAX_ITEMS = 2_000;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-.\s]+/g, "_");
}

function redactText(value, maximum = 2_000) {
  if (typeof value !== "string" || !value) return "";
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|token|secret|password|api[_-]?key|management[_-]?key|caller[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\buser_[A-Za-z0-9._~-]+/g, "user_[REDACTED]")
    .replaceAll("\0", "")
    .slice(0, maximum);
}

function errorMessage(error, fallback = "Managed application is unavailable") {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return redactText(message || fallback);
}

function sanitizePublic(value, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactText(value, 16_384);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((entry) => sanitizePublic(entry, depth + 1, seen));
  }
  if (!isPlainObject(value) || seen.has(value)) return null;
  seen.add(value);
  try {
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_ITEMS)) {
      if (SENSITIVE_KEY.test(normalizedKey(key)) && typeof entry !== "boolean") continue;
      result[key] = sanitizePublic(entry, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function assertNoSensitiveInputKeys(value, path = "$", depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) throw new Error(`${path} exceeds the managed app API depth limit`);
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`${path} contains a cyclic value`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ITEMS) throw new Error(`${path} has too many items`);
      value.forEach((entry, index) => assertNoSensitiveInputKeys(entry, `${path}[${index}]`, depth + 1, seen));
      return;
    }
    if (!isPlainObject(value)) throw new Error(`${path} must contain only JSON values`);
    const entries = Object.entries(value);
    if (entries.length > MAX_ITEMS) throw new Error(`${path} has too many fields`);
    for (const [key, entry] of entries) {
      if (SENSITIVE_KEY.test(normalizedKey(key))) {
        throw new Error(`${path}.${key} is not allowed in the Coding Tools managed app API`);
      }
      assertNoSensitiveInputKeys(entry, `${path}.${key}`, depth + 1, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function requiredHandle(value) {
  const handle = typeof value === "string" ? value.trim() : "";
  if (!APP_HANDLE_SET.has(handle)) throw new Error(`Unknown managed app handle: ${handle || "missing"}`);
  return handle;
}

function requiredOperation(handle, value) {
  const operation = typeof value === "string" ? value.trim() : "";
  if (!APP_DEFINITIONS[handle].operations.includes(operation)) {
    throw new Error(`${APP_DEFINITIONS[handle].name} does not support operation ${operation || "missing"}`);
  }
  return operation;
}

function optionalIdentifier(value, name, maximum = 160) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function activeAccounts(providerSnapshot) {
  return (Array.isArray(providerSnapshot?.accounts) ? providerSnapshot.accounts : [])
    .filter((account) => account && typeof account === "object" && !account.archivedAt);
}

function providerInventory(providerSnapshot) {
  const providers = new Map();
  for (const account of activeAccounts(providerSnapshot)) {
    const id = typeof account.providerId === "string" ? account.providerId.trim() : "";
    if (!id) continue;
    const current = providers.get(id) || {
      id,
      accountCount: 0,
      connectedAccountCount: 0,
      enabledAccountCount: 0,
      models: new Set(),
    };
    current.accountCount += 1;
    if (account.status === "connected") current.connectedAccountCount += 1;
    if (account.enabled !== false) current.enabledAccountCount += 1;
    for (const model of Array.isArray(account.models) ? account.models : []) {
      if (typeof model === "string" && model.trim()) current.models.add(model.trim());
    }
    providers.set(id, current);
  }
  return [...providers.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => ({
      id: provider.id,
      accountCount: provider.accountCount,
      connectedAccountCount: provider.connectedAccountCount,
      enabledAccountCount: provider.enabledAccountCount,
      modelCount: provider.models.size,
    }));
}

function providerMetrics(providerSnapshot) {
  const accounts = activeAccounts(providerSnapshot);
  const models = new Set();
  for (const account of accounts) {
    for (const model of Array.isArray(account.models) ? account.models : []) {
      if (typeof model === "string" && model.trim()) models.add(model.trim());
    }
  }
  const providers = providerInventory(providerSnapshot);
  return {
    accountCount: accounts.length,
    connectedAccountCount: accounts.filter((account) => account.status === "connected").length,
    enabledAccountCount: accounts.filter((account) => account.enabled !== false).length,
    providerCount: providers.length,
    modelCount: models.size,
  };
}

function emptyManaged(failure = null) {
  return {
    state: failure ? "unavailable" : "external",
    version: "",
    platformMode: "native",
    bundledRuntime: false,
    missingInputs: [],
  };
}

function projectManaged(service, failure = null) {
  const managed = service?.managedInstall && typeof service.managedInstall === "object"
    ? service.managedInstall
    : null;
  if (!managed) return emptyManaged(failure);
  return {
    state: typeof managed.state === "string" ? managed.state : "external",
    version: typeof managed.version === "string" ? managed.version : "",
    platformMode: typeof managed.platformMode === "string" ? managed.platformMode : "native",
    bundledRuntime: managed.bundledRuntime === true,
    missingInputs: Array.isArray(managed.missingCredentials)
      ? managed.missingCredentials.filter((entry) => typeof entry === "string").slice(0, 32)
      : [],
  };
}

function projectSetup(component, failure = null) {
  if (!component || typeof component !== "object") {
    return {
      status: failure ? "error" : "idle",
      action: null,
      missingInputs: [],
      message: failure ? errorMessage(failure, "Managed bootstrap is unavailable") : null,
    };
  }
  return {
    status: typeof component.status === "string" ? component.status : "idle",
    action: typeof component.action === "string" ? component.action : null,
    missingInputs: Array.isArray(component.missingCredentials)
      ? component.missingCredentials.filter((entry) => typeof entry === "string").slice(0, 32)
      : [],
    message: typeof component.message === "string" && component.message
      ? errorMessage(component.message)
      : null,
  };
}

function projectUi(handle, tool, failure = null) {
  if (!ORIGINAL_UI_HANDLES.has(handle)) return undefined;
  if (!tool || typeof tool !== "object") {
    return {
      status: failure ? "error" : "unknown",
      available: false,
      sections: [],
      endpoint: null,
      originalWindow: handle === "codex-router",
      error: failure ? errorMessage(failure, "Original application UI is unavailable") : null,
    };
  }
  return {
    status: typeof tool.status === "string" ? tool.status : "unknown",
    available: tool.status === "ready",
    sections: Array.isArray(tool.sections)
      ? tool.sections.filter((entry) => typeof entry === "string").slice(0, 64)
      : [],
    endpoint: typeof tool.endpoint === "string" ? tool.endpoint : null,
    originalWindow: handle === "codex-router",
    error: typeof tool.error === "string" && tool.error ? errorMessage(tool.error) : null,
  };
}

function projectApp({
  handle,
  service = null,
  serviceFailure = null,
  providerSnapshot = null,
  providerFailure = null,
  uiTool = null,
  uiFailure = null,
  setupComponent = null,
  setupFailure = null,
}) {
  const definition = APP_DEFINITIONS[handle];
  const metrics = handle === "cpa" && providerSnapshot ? providerMetrics(providerSnapshot) : null;
  const serviceStatus = typeof service?.status === "string" ? service.status : null;
  const providerReady = handle === "cpa" && Boolean(providerSnapshot);
  const failed = !service && Boolean(serviceFailure);
  const status = serviceStatus || (providerReady ? "ready" : failed || providerFailure ? "error" : "unknown");
  const serviceError = typeof service?.error === "string" && service.error
    ? errorMessage(service.error)
    : failed ? errorMessage(serviceFailure, `${definition.name} control plane is unavailable`) : null;
  const providerError = handle === "cpa" && providerFailure
    ? errorMessage(providerFailure, "CPA provider network is unavailable")
    : null;
  return {
    handle,
    name: typeof service?.name === "string" && service.name ? service.name : definition.name,
    kind: definition.kind,
    status,
    available: serviceStatus === "ready" || providerReady,
    operations: [...definition.operations],
    endpoint: typeof service?.endpoint === "string" ? service.endpoint : null,
    executionEndpoint: typeof service?.executionEndpoint === "string" ? service.executionEndpoint : null,
    pid: Number.isInteger(service?.pid) ? service.pid : null,
    owned: service?.owned === true,
    modelCount: metrics?.modelCount ?? (Number.isInteger(service?.modelCount) ? service.modelCount : null),
    accountCount: metrics?.accountCount ?? (Number.isInteger(service?.accountCount) ? service.accountCount : 0),
    connectedAccountCount: metrics?.connectedAccountCount
      ?? (Number.isInteger(service?.connectedAccountCount) ? service.connectedAccountCount : 0),
    enabledAccountCount: metrics?.enabledAccountCount ?? 0,
    providerCount: metrics?.providerCount ?? 0,
    providerModelCount: Number.isInteger(service?.providerModelCount) ? service.providerModelCount : 0,
    providerNetworkStatus: handle === "cpa" ? (providerReady ? "ready" : providerFailure ? "error" : "unknown") : undefined,
    error: serviceError || providerError,
    managed: projectManaged(service, serviceFailure),
    setup: projectSetup(setupComponent, setupFailure),
    ...(ORIGINAL_UI_HANDLES.has(handle) ? { ui: projectUi(handle, uiTool, uiFailure) } : {}),
  };
}

function redactPlan(plan) {
  const provider = plan?.provider && typeof plan.provider === "object" ? plan.provider : {};
  const account = plan?.account && typeof plan.account === "object" ? plan.account : {};
  const proxy = plan?.proxy && typeof plan.proxy === "object" ? plan.proxy : {};
  const profile = proxy.profile && typeof proxy.profile === "object" ? proxy.profile : null;
  return {
    version: Number.isInteger(plan?.version) ? plan.version : 1,
    workload: typeof plan?.workload === "string" ? plan.workload : "subagent",
    provider: {
      id: typeof provider.id === "string" ? provider.id : "",
      name: typeof provider.name === "string" ? provider.name : "",
      protocol: typeof provider.protocol === "string" ? provider.protocol : "",
    },
    account: {
      id: typeof account.id === "string" ? account.id : "",
      label: typeof account.label === "string" ? account.label : "",
      auth: typeof account.auth === "string" ? account.auth : "",
    },
    model: typeof plan?.model === "string" ? plan.model : null,
    proxy: {
      mode: proxy.mode === "profile" ? "profile" : "direct",
      source: typeof proxy.source === "string" ? proxy.source : "default",
      profile: profile ? sanitizePublic({
        id: profile.id,
        name: profile.name,
        endpoint: profile.endpoint,
        scopes: profile.scopes,
        bypass: profile.bypass,
      }) : null,
    },
    fallbackUsed: plan?.fallbackUsed === true,
  };
}

function createManagedAppApiHandler({
  externalServices,
  originalUi,
  upstreamTools,
  managedBootstrap,
  getProviderController,
  createExecutionPlan,
  commandCodePlan,
  commandCodeApply,
  performUpstreamAction,
  logger = null,
} = {}) {
  if (!externalServices || typeof externalServices.snapshot !== "function") {
    throw new Error("Managed app API requires the external services controller");
  }
  if (!originalUi || typeof originalUi.snapshot !== "function") {
    throw new Error("Managed app API requires the original UI controller");
  }
  if (!upstreamTools || typeof upstreamTools.openEmbeddedTool !== "function") {
    throw new Error("Managed app API requires the upstream tools controller");
  }
  if (!managedBootstrap || typeof managedBootstrap.getSnapshot !== "function" || typeof managedBootstrap.reconcile !== "function") {
    throw new Error("Managed app API requires the managed bootstrap controller");
  }
  if (typeof getProviderController !== "function") {
    throw new Error("Managed app API requires the provider network controller");
  }
  if (typeof createExecutionPlan !== "function") {
    throw new Error("Managed app API requires provider execution planning");
  }
  if (typeof commandCodePlan !== "function" || typeof commandCodeApply !== "function") {
    throw new Error("Managed app API requires CommandCode registration handlers");
  }
  if (typeof performUpstreamAction !== "function") {
    throw new Error("Managed app API requires the upstream action handler");
  }

  async function providerSnapshot() {
    const controller = await getProviderController();
    const value = controller?.store?.snapshot?.();
    if (!value || typeof value !== "object") throw new Error("CPA provider network is unavailable");
    return value;
  }

  async function providerResult() {
    try {
      return { value: await providerSnapshot(), error: null };
    } catch (error) {
      logger?.warn?.("managed-app-api.provider-unavailable", { message: errorMessage(error) });
      return { value: null, error: new Error("CPA provider network is unavailable") };
    }
  }

  function serviceResult() {
    try {
      const value = externalServices.snapshot();
      return { value: value && typeof value === "object" ? value : { version: 1, services: [] }, error: null };
    } catch (error) {
      logger?.warn?.("managed-app-api.services-unavailable", { message: errorMessage(error) });
      return { value: { version: 1, services: [] }, error: new Error(errorMessage(error, "Managed service control plane is unavailable")) };
    }
  }

  function uiResult() {
    try {
      const value = originalUi.snapshot();
      return { value: value && typeof value === "object" ? value : { version: 1, tools: [] }, error: null };
    } catch (error) {
      logger?.warn?.("managed-app-api.original-ui-unavailable", { message: errorMessage(error) });
      return { value: { version: 1, tools: [] }, error: new Error(errorMessage(error, "Original application UI is unavailable")) };
    }
  }

  function bootstrapResult() {
    try {
      const value = managedBootstrap.getSnapshot();
      return { value: value && typeof value === "object" ? value : { status: "idle", components: [] }, error: null };
    } catch (error) {
      logger?.warn?.("managed-app-api.bootstrap-unavailable", { message: errorMessage(error) });
      return { value: { status: "error", components: [] }, error: new Error(errorMessage(error, "Managed bootstrap is unavailable")) };
    }
  }

  function findService(handle, snapshot) {
    return Array.isArray(snapshot?.services)
      ? snapshot.services.find((candidate) => candidate?.id === handle) || null
      : null;
  }

  function findUi(handle, snapshot) {
    return Array.isArray(snapshot?.tools)
      ? snapshot.tools.find((candidate) => candidate?.id === handle) || null
      : null;
  }

  function findSetup(handle, snapshot) {
    return Array.isArray(snapshot?.components)
      ? snapshot.components.find((candidate) => candidate?.id === handle) || null
      : null;
  }

  async function snapshot() {
    const [provider, services] = await Promise.all([
      providerResult(),
      Promise.resolve().then(serviceResult),
    ]);
    const ui = uiResult();
    const bootstrap = bootstrapResult();
    return sanitizePublic({
      version: 1,
      bootstrap: {
        status: typeof bootstrap.value.status === "string" ? bootstrap.value.status : "idle",
        reason: typeof bootstrap.value.reason === "string" ? bootstrap.value.reason : null,
        startedAt: typeof bootstrap.value.startedAt === "string" ? bootstrap.value.startedAt : null,
        completedAt: typeof bootstrap.value.completedAt === "string" ? bootstrap.value.completedAt : null,
        error: bootstrap.error ? errorMessage(bootstrap.error) : null,
      },
      apps: APP_HANDLES.map((handle) => projectApp({
        handle,
        service: findService(handle, services.value),
        serviceFailure: services.error,
        providerSnapshot: handle === "cpa" ? provider.value : null,
        providerFailure: handle === "cpa" ? provider.error : null,
        uiTool: findUi(handle, ui.value),
        uiFailure: ui.error,
        setupComponent: findSetup(handle, bootstrap.value),
        setupFailure: bootstrap.error,
      })),
    });
  }

  async function appSnapshot(handle, serviceOverride = undefined) {
    const all = await snapshot();
    const current = all.apps.find((app) => app.handle === handle);
    if (!current) throw new Error(`${APP_DEFINITIONS[handle].name} app handle is unavailable`);
    if (serviceOverride === undefined) return current;
    const services = serviceResult();
    const provider = handle === "cpa" ? await providerResult() : { value: null, error: null };
    const ui = uiResult();
    const bootstrap = bootstrapResult();
    return sanitizePublic(projectApp({
      handle,
      service: serviceOverride || findService(handle, services.value),
      serviceFailure: services.error,
      providerSnapshot: provider.value,
      providerFailure: provider.error,
      uiTool: findUi(handle, ui.value),
      uiFailure: ui.error,
      setupComponent: findSetup(handle, bootstrap.value),
      setupFailure: bootstrap.error,
    }));
  }

  function commandCodeOptions() {
    const services = serviceResult();
    const commandCode = findService("commandcode-proxy", services.value);
    const router = findService("codex-router", services.value);
    return {
      baseUrl: typeof commandCode?.endpoint === "string"
        ? commandCode.endpoint
        : "http://127.0.0.1:9090/",
      routerCli: typeof router?.routerCli === "string" && router.routerCli ? router.routerCli : "model-router",
      curateCli: typeof router?.curateCli === "string" && router.curateCli ? router.curateCli : "curate-models",
    };
  }

  async function invoke(input) {
    if (!isPlainObject(input)) throw new Error("Managed app API input is required");
    const handle = requiredHandle(input.handle);
    const operation = requiredOperation(handle, input.operation);
    const argumentsValue = input.arguments === undefined ? {} : input.arguments;
    if (!isPlainObject(argumentsValue)) throw new Error("Managed app API arguments must be an object");
    assertNoSensitiveInputKeys(argumentsValue, "$.arguments");
    if (MUTATING_OPERATIONS.has(operation) && input.confirm !== true) {
      throw new Error(`${APP_DEFINITIONS[handle].name} ${operation} requires explicit confirmation`);
    }
    logger?.info?.("managed-app-api.invoke", { handle, operation });

    if (operation === "providers" || operation === "plan") {
      const provider = await providerSnapshot();
      if (operation === "providers") {
        return sanitizePublic({
          version: 1,
          handle,
          operation,
          app: await appSnapshot(handle),
          providers: providerInventory(provider),
        });
      }
      const workload = optionalIdentifier(argumentsValue.workload, "workload", 32) || "subagent";
      if (!PLAN_WORKLOADS.has(workload)) throw new Error(`Unsupported provider workload: ${workload}`);
      const providerId = optionalIdentifier(argumentsValue.providerId, "providerId");
      const accountId = optionalIdentifier(argumentsValue.accountId, "accountId");
      const model = optionalIdentifier(argumentsValue.model, "model", 256);
      const plan = createExecutionPlan(provider, {
        workload,
        ...(providerId ? { providerId } : {}),
        ...(accountId ? { accountId } : {}),
        ...(model ? { model } : {}),
        allowFallback: argumentsValue.allowFallback !== false,
      });
      return sanitizePublic({
        version: 1,
        handle,
        operation,
        app: await appSnapshot(handle),
        plan: redactPlan(plan),
      });
    }

    if (operation.startsWith("ui-")) {
      const action = operation.slice(3);
      let result;
      if (action === "inspect") result = await originalUi.inspect(handle);
      else if (action === "start") result = await originalUi.start(handle);
      else if (action === "stop") result = await originalUi.stop(handle);
      else if (action === "restart") result = await originalUi.restart(handle);
      else if (action === "open") {
        const section = optionalIdentifier(argumentsValue.section, "section", 128);
        result = await originalUi.openEmbedded(handle, section);
      }
      return sanitizePublic({
        version: 1,
        handle,
        operation,
        app: await appSnapshot(handle),
        ui: result,
      });
    }

    if (operation === "registration-plan" || operation === "registration-apply") {
      if (Object.keys(argumentsValue).length > 0) {
        throw new Error("CommandCode registration endpoint and CLI paths are owned by Coding Tools and cannot be overridden");
      }
      const options = commandCodeOptions();
      const registration = operation === "registration-plan"
        ? await commandCodePlan(options)
        : await commandCodeApply(options);
      return sanitizePublic({
        version: 1,
        handle,
        operation,
        app: await appSnapshot(handle),
        registration,
      });
    }

    if (operation === "open") {
      const section = optionalIdentifier(argumentsValue.section, "section", 128);
      if (!section) throw new Error(`${APP_DEFINITIONS[handle].name} section is required`);
      const embedded = await upstreamTools.openEmbeddedTool(handle, section);
      return sanitizePublic({
        version: 1,
        handle,
        operation,
        app: await appSnapshot(handle),
        embedded: {
          section: embedded.section,
          url: embedded.url,
          embedded: embedded.embedded === true,
        },
      });
    }

    if (operation === "act") {
      for (const forbidden of ["endpoint", "credential", "authorization", "token", "apiKey", "api_key"]) {
        if (Object.hasOwn(argumentsValue, forbidden)) {
          throw new Error(`${forbidden} is not allowed; Coding Tools owns upstream routing and authentication`);
        }
      }
      const configuration = externalServices.upstreamConfiguration(handle);
      const endpoint = configuration?.executionEndpoint;
      if (typeof endpoint !== "string" || !endpoint) {
        throw new Error(`${APP_DEFINITIONS[handle].name} execution endpoint is unavailable`);
      }
      const action = await performUpstreamAction({
        ...argumentsValue,
        toolId: handle,
        endpoint,
      });
      return sanitizePublic({
        version: 1,
        handle,
        operation,
        app: await appSnapshot(handle),
        action,
      });
    }

    let result;
    if (operation === "inspect") result = await externalServices.inspect(handle);
    else if (operation === "install") result = await externalServices.installManagedComponent(handle);
    else if (operation === "repair") result = await externalServices.repairManagedComponent(handle);
    else if (operation === "start") result = await externalServices.start(handle);
    else if (operation === "stop") result = await externalServices.stop(handle);
    else if (operation === "restart") result = await externalServices.restart(handle);
    else if (operation === "sync") result = await externalServices.syncCodexRouter();

    return sanitizePublic({
      version: 1,
      handle,
      operation,
      app: operation === "sync" ? await appSnapshot(handle) : await appSnapshot(handle, result),
      ...(operation === "sync" ? {
        sync: {
          ok: result?.ok === true,
          args: Array.isArray(result?.args)
            ? result.args.filter((entry) => typeof entry === "string").slice(0, 64)
            : [],
          stdout: redactText(result?.stdout, 8_192),
          stderr: redactText(result?.stderr, 8_192),
        },
      } : {}),
    });
  }

  async function reconcile(input = {}) {
    if (!isPlainObject(input)) throw new Error("Managed app reconcile input is required");
    if (input.confirm !== true) throw new Error("Managed app reconciliation requires explicit confirmation");
    const handles = input.handles === undefined || input.handles === null
      ? [...APP_HANDLES]
      : Array.isArray(input.handles)
        ? input.handles.map(requiredHandle)
        : (() => { throw new Error("Managed app reconcile handles must be an array"); })();
    const uniqueHandles = [...new Set(handles)];
    const reason = optionalIdentifier(input.reason, "reason", 128) || "managed-app-api";
    logger?.info?.("managed-app-api.reconcile", { handles: uniqueHandles, reason });
    const bootstrap = await managedBootstrap.reconcile({
      reason,
      componentIds: uniqueHandles,
    });
    const current = await snapshot();
    return sanitizePublic({
      version: 1,
      bootstrap,
      apps: current.apps,
    });
  }

  return Object.freeze({ snapshot, invoke, reconcile });
}

module.exports = Object.freeze({
  APP_HANDLES,
  APP_DEFINITIONS,
  MUTATING_OPERATIONS,
  createManagedAppApiHandler,
  providerInventory,
  redactPlan,
  sanitizePublic,
});
