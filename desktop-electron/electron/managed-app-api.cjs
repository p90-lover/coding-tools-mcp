"use strict";

const APP_HANDLES = Object.freeze([
  "cpa",
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);
const APP_HANDLE_SET = new Set(APP_HANDLES);
const APP_DEFINITIONS = Object.freeze({
  cpa: Object.freeze({
    name: "CPA / CLIProxyAPI",
    kind: "provider-network",
    operations: Object.freeze(["inspect", "providers", "plan"]),
  }),
  "codex-router": Object.freeze({
    name: "Codex Router",
    kind: "managed-service",
    operations: Object.freeze(["inspect", "install", "repair", "start", "stop", "restart", "sync"]),
  }),
  "commandcode-proxy": Object.freeze({
    name: "CommandCode Proxy",
    kind: "managed-service",
    operations: Object.freeze(["inspect", "install", "repair", "start", "stop", "restart"]),
  }),
  paseo: Object.freeze({
    name: "Paseo",
    kind: "managed-upstream",
    operations: Object.freeze(["inspect", "install", "repair", "start", "stop", "restart", "open"]),
  }),
  anneal: Object.freeze({
    name: "Anneal",
    kind: "managed-upstream",
    operations: Object.freeze(["inspect", "install", "repair", "start", "stop", "restart", "open"]),
  }),
});
const MUTATING_OPERATIONS = new Set(["install", "repair", "start", "stop", "restart", "sync"]);
const PLAN_WORKLOADS = new Set(["subagent", "paseo", "anneal"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function redactText(value, maximum = 2_000) {
  if (typeof value !== "string" || !value) return "";
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, maximum);
}

function errorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return redactText(message || fallback || "Managed application is unavailable");
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

function projectCpa(providerSnapshot, failure = null) {
  const available = Boolean(providerSnapshot && typeof providerSnapshot === "object");
  const accounts = available ? activeAccounts(providerSnapshot) : [];
  const models = new Set();
  for (const account of accounts) {
    for (const model of Array.isArray(account.models) ? account.models : []) {
      if (typeof model === "string" && model.trim()) models.add(model.trim());
    }
  }
  const providers = available ? providerInventory(providerSnapshot) : [];
  return {
    handle: "cpa",
    name: APP_DEFINITIONS.cpa.name,
    kind: APP_DEFINITIONS.cpa.kind,
    status: available ? "ready" : "error",
    available,
    operations: [...APP_DEFINITIONS.cpa.operations],
    accountCount: accounts.length,
    connectedAccountCount: accounts.filter((account) => account.status === "connected").length,
    enabledAccountCount: accounts.filter((account) => account.enabled !== false).length,
    providerCount: providers.length,
    modelCount: models.size,
    error: available ? null : errorMessage(failure, "CPA provider network is unavailable"),
  };
}

function projectManagedService(handle, service, failure = null) {
  const definition = APP_DEFINITIONS[handle];
  const install = service?.managedInstall && typeof service.managedInstall === "object"
    ? service.managedInstall
    : {};
  const failed = !service && Boolean(failure);
  return {
    handle,
    name: typeof service?.name === "string" && service.name ? service.name : definition.name,
    kind: definition.kind,
    status: typeof service?.status === "string" ? service.status : failed ? "error" : "unknown",
    available: service?.status === "ready",
    operations: [...definition.operations],
    endpoint: typeof service?.endpoint === "string" ? service.endpoint : null,
    executionEndpoint: typeof service?.executionEndpoint === "string" ? service.executionEndpoint : null,
    modelCount: Number.isInteger(service?.modelCount) ? service.modelCount : null,
    accountCount: Number.isInteger(service?.accountCount) ? service.accountCount : 0,
    connectedAccountCount: Number.isInteger(service?.connectedAccountCount) ? service.connectedAccountCount : 0,
    providerModelCount: Number.isInteger(service?.providerModelCount) ? service.providerModelCount : 0,
    error: typeof service?.error === "string" && service.error
      ? errorMessage(service.error)
      : failed ? errorMessage(failure, `${definition.name} control plane is unavailable`) : null,
    managed: {
      state: typeof install.state === "string" ? install.state : failed ? "unavailable" : "external",
      version: typeof install.version === "string" ? install.version : "",
      platformMode: typeof install.platformMode === "string" ? install.platformMode : "native",
      missingInputs: Array.isArray(install.missingCredentials)
        ? install.missingCredentials.filter((entry) => typeof entry === "string").slice(0, 32)
        : [],
    },
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
      profile: profile ? {
        id: typeof profile.id === "string" ? profile.id : "",
        name: typeof profile.name === "string" ? profile.name : "",
        endpoint: profile.endpoint && typeof profile.endpoint === "object"
          ? {
              protocol: typeof profile.endpoint.protocol === "string" ? profile.endpoint.protocol : "http",
              host: typeof profile.endpoint.host === "string" ? profile.endpoint.host : "",
              port: Number.isInteger(profile.endpoint.port) ? profile.endpoint.port : 0,
            }
          : null,
        scopes: Array.isArray(profile.scopes)
          ? profile.scopes.filter((entry) => typeof entry === "string").slice(0, 32)
          : [],
        bypass: Array.isArray(profile.bypass)
          ? profile.bypass.filter((entry) => typeof entry === "string").slice(0, 128)
          : [],
      } : null,
    },
    fallbackUsed: plan?.fallbackUsed === true,
  };
}

function createManagedAppApiHandler({
  externalServices,
  upstreamTools,
  getProviderController,
  createExecutionPlan,
  logger = null,
} = {}) {
  if (!externalServices || typeof externalServices.snapshot !== "function") {
    throw new Error("Managed app API requires the external services controller");
  }
  if (!upstreamTools || typeof upstreamTools.openEmbeddedTool !== "function") {
    throw new Error("Managed app API requires the upstream tools controller");
  }
  if (typeof getProviderController !== "function") {
    throw new Error("Managed app API requires the provider network controller");
  }
  if (typeof createExecutionPlan !== "function") {
    throw new Error("Managed app API requires provider execution planning");
  }

  async function providerSnapshot() {
    const controller = await getProviderController();
    const value = controller?.store?.snapshot?.();
    if (!value || typeof value !== "object") throw new Error("CPA provider network is unavailable");
    return value;
  }

  async function providerSnapshotResult() {
    try {
      return { value: await providerSnapshot(), error: null };
    } catch (error) {
      logger?.warn?.("managed-app-api.provider-snapshot-unavailable", {
        message: errorMessage(error, "CPA provider network is unavailable"),
      });
      return { value: null, error: new Error("CPA provider network is unavailable") };
    }
  }

  function serviceSnapshotResult() {
    try {
      const value = externalServices.snapshot();
      return { value: value && typeof value === "object" ? value : { version: 1, services: [] }, error: null };
    } catch (error) {
      logger?.warn?.("managed-app-api.service-snapshot-unavailable", {
        message: errorMessage(error, "Managed service control plane is unavailable"),
      });
      return { value: { version: 1, services: [] }, error };
    }
  }

  function findService(handle, serviceSnapshot) {
    return Array.isArray(serviceSnapshot?.services)
      ? serviceSnapshot.services.find((candidate) => candidate?.id === handle) || null
      : null;
  }

  async function appSnapshot(handle) {
    if (handle === "cpa") {
      const provider = await providerSnapshotResult();
      return projectCpa(provider.value, provider.error);
    }
    const services = serviceSnapshotResult();
    return projectManagedService(handle, findService(handle, services.value), services.error);
  }

  async function snapshot() {
    const [provider, services] = await Promise.all([
      providerSnapshotResult(),
      Promise.resolve().then(serviceSnapshotResult),
    ]);
    return {
      version: 1,
      apps: [
        projectCpa(provider.value, provider.error),
        ...APP_HANDLES.slice(1).map((handle) => projectManagedService(
          handle,
          findService(handle, services.value),
          services.error,
        )),
      ],
    };
  }

  async function invoke(input) {
    if (!isPlainObject(input)) throw new Error("Managed app API input is required");
    const handle = requiredHandle(input.handle);
    const operation = requiredOperation(handle, input.operation);
    const argumentsValue = input.arguments === undefined ? {} : input.arguments;
    if (!isPlainObject(argumentsValue)) throw new Error("Managed app API arguments must be an object");
    if (MUTATING_OPERATIONS.has(operation) && input.confirm !== true) {
      throw new Error(`${APP_DEFINITIONS[handle].name} ${operation} requires explicit confirmation`);
    }

    logger?.info?.("managed-app-api.invoke", { handle, operation });

    if (handle === "cpa") {
      const provider = await providerSnapshot();
      if (operation === "inspect") {
        return { version: 1, handle, operation, app: projectCpa(provider) };
      }
      if (operation === "providers") {
        return {
          version: 1,
          handle,
          operation,
          app: projectCpa(provider),
          providers: providerInventory(provider),
        };
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
      return {
        version: 1,
        handle,
        operation,
        app: projectCpa(provider),
        plan: redactPlan(plan),
      };
    }

    let result;
    if (operation === "inspect") result = await externalServices.inspect(handle);
    else if (operation === "install") result = await externalServices.installManagedComponent(handle);
    else if (operation === "repair") result = await externalServices.repairManagedComponent(handle);
    else if (operation === "start") result = await externalServices.start(handle);
    else if (operation === "stop") result = await externalServices.stop(handle);
    else if (operation === "restart") result = await externalServices.restart(handle);
    else if (operation === "sync") result = await externalServices.syncCodexRouter();
    else if (operation === "open") {
      const section = optionalIdentifier(argumentsValue.section, "section", 128);
      if (!section) throw new Error(`${APP_DEFINITIONS[handle].name} section is required`);
      const embedded = await upstreamTools.openEmbeddedTool(handle, section);
      return {
        version: 1,
        handle,
        operation,
        app: await appSnapshot(handle),
        embedded: {
          section: embedded.section,
          url: embedded.url,
          embedded: embedded.embedded === true,
        },
      };
    }

    return {
      version: 1,
      handle,
      operation,
      app: operation === "sync"
        ? await appSnapshot(handle)
        : projectManagedService(handle, result),
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
    };
  }

  return Object.freeze({ snapshot, invoke });
}

module.exports = Object.freeze({
  APP_HANDLES,
  APP_DEFINITIONS,
  MUTATING_OPERATIONS,
  createManagedAppApiHandler,
  providerInventory,
  redactPlan,
});
