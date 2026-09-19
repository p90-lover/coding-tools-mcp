import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd());

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function write(relative, value) {
  fs.writeFileSync(path.join(root, relative), value, "utf8");
  process.stdout.write(`patched ${relative}\n`);
}

function replaceOnce(relative, oldValue, newValue, sentinel = newValue) {
  const current = read(relative);
  if (current.includes(sentinel)) {
    process.stdout.write(`already patched ${relative}\n`);
    return;
  }
  const count = current.split(oldValue).length - 1;
  if (count !== 1) {
    throw new Error(`Expected one anchor in ${relative}, found ${count}: ${oldValue.slice(0, 180)}`);
  }
  write(relative, current.replace(oldValue, newValue));
}

replaceOnce(
  "desktop-electron/electron/coding-tools-shell-bridge.cjs",
  `function createCodingToolsShellBridge({
  assertFocusedMainWindow,
  headlessHost,
  updateController,
}) {`,
  `function createCodingToolsShellBridge({
  assertFocusedMainWindow,
  headlessHost,
  managedAppApi = null,
  updateController,
}) {`,
  "  managedAppApi = null,\n  updateController,",
);

replaceOnce(
  "desktop-electron/electron/coding-tools-shell-bridge.cjs",
  `  const requireHost = () => {
    if (!headlessHost) throw new Error("Local Coding Tools service is unavailable");
    return headlessHost;
  };

  const requestHeadless`,
  `  const requireHost = () => {
    if (!headlessHost) throw new Error("Local Coding Tools service is unavailable");
    return headlessHost;
  };
  const requireManagedAppApi = () => {
    if (!managedAppApi) throw new Error("Managed application API is unavailable");
    return managedAppApi;
  };

  const requestHeadless`,
  "const requireManagedAppApi = () =>",
);

replaceOnce(
  "desktop-electron/electron/coding-tools-shell-bridge.cjs",
  `    async integrationsSnapshot(event) {
      assertFocusedMainWindow(event, false);
      return {
        available: false,
        reason: "Paseo, Anneal, and provider integrations are owned by sibling Desktop panels.",
      };
    },

    async updatesStatus(event) {`,
  `    async integrationsSnapshot(event) {
      assertFocusedMainWindow(event, false);
      return requireManagedAppApi().snapshot();
    },

    async managedAppsSnapshot(event) {
      assertFocusedMainWindow(event, false);
      return requireManagedAppApi().snapshot();
    },

    async managedAppInvoke(event, input) {
      const operation = typeof input?.operation === "string" ? input.operation : "";
      const mutating = new Set([
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
      ]).has(operation);
      assertFocusedMainWindow(event, mutating);
      return requireManagedAppApi().invoke(input);
    },

    async managedAppsReconcile(event, input) {
      assertFocusedMainWindow(event, true);
      return requireManagedAppApi().reconcile(input);
    },

    async updatesStatus(event) {`,
  "async managedAppsReconcile(event, input)",
);

replaceOnce(
  "desktop-electron/electron/main.cjs",
  `const { createCodingToolsShellBridge } = require("./coding-tools-shell-bridge.cjs");
const { ensurePackagedRuntime, waitForPackagedRuntimeSource } = require("./runtime-install.cjs");`,
  `const { createCodingToolsShellBridge } = require("./coding-tools-shell-bridge.cjs");
const { createManagedAppApiHandler } = require("./managed-app-api.cjs");
const { ensurePackagedRuntime, waitForPackagedRuntimeSource } = require("./runtime-install.cjs");`,
  'require("./managed-app-api.cjs")',
);

replaceOnce(
  "desktop-electron/electron/main.cjs",
  `function registerIpc({ logger, stateStore }) {
  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, handler);
  const codingTools = createCodingToolsShellBridge({
    assertFocusedMainWindow,
    headlessHost,
    updateController,
  });
  const fiveStackControlPlane = createFiveStackControlPlane({`,
  `function registerIpc({ logger, stateStore }) {
  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, handler);
  const managedAppApi = createManagedAppApiHandler({
    externalServices: externalServicesController,
    originalUi: originalUiController,
    upstreamTools: upstreamToolController,
    managedBootstrap: managedBootstrapController,
    getProviderController: providerNetworkReady,
    createExecutionPlan: createProviderExecutionPlan,
    commandCodePlan: (options) => {
      const plan = commandCodeProxyRegistrationPlan(options);
      return { ...plan, text: renderCommandCodeProxyPlan(plan) };
    },
    commandCodeApply: (options) => applyCommandCodeProxyPlan(options),
    performUpstreamAction: (input) => actUpstream(input),
    logger,
  });
  const codingTools = createCodingToolsShellBridge({
    assertFocusedMainWindow,
    headlessHost,
    managedAppApi,
    updateController,
  });
  const fiveStackControlPlane = createFiveStackControlPlane({`,
  "const managedAppApi = createManagedAppApiHandler({",
);

replaceOnce(
  "desktop-electron/electron/main.cjs",
  `  handle("coding-tools:integrations:snapshot", async (event) => {
    const snapshot = await codingTools.integrationsSnapshot(event);
    return {
      ...snapshot,
      available: true,
      five_stack: fiveStackControlPlane.apiMap(),
    };
  });
  handle("coding-tools:updates:status",`,
  `  handle("coding-tools:integrations:snapshot", async (event) => {
    const snapshot = await codingTools.integrationsSnapshot(event);
    return {
      ...snapshot,
      available: true,
      five_stack: fiveStackControlPlane.apiMap(),
    };
  });
  handle("coding-tools:apps:snapshot", (event) => codingTools.managedAppsSnapshot(event));
  handle("coding-tools:apps:invoke", (event, input) => codingTools.managedAppInvoke(event, input));
  handle("coding-tools:apps:reconcile", (event, input) => codingTools.managedAppsReconcile(event, input));
  handle("coding-tools:updates:status",`,
  'handle("coding-tools:apps:snapshot"',
);

replaceOnce(
  "desktop-electron/electron/preload.cjs",
  `const { invokeContract } = require("./ipc-schema.cjs");

const codingToolsApi = Object.freeze({`,
  `const { invokeContract } = require("./ipc-schema.cjs");

function subscribeManagedApps(listener) {
  if (typeof listener !== "function") throw new Error("Managed app listener must be a function");
  const channels = [
    "launcher:external-services-changed",
    "launcher:provider-network-changed",
    "launcher:managed-bootstrap-changed",
  ];
  let disposed = false;
  let queued = false;
  let refreshPromise = null;
  const refresh = () => {
    if (disposed) return;
    if (refreshPromise) {
      queued = true;
      return;
    }
    refreshPromise = invokeContract(ipcRenderer, "apps.snapshot")
      .then((snapshot) => {
        if (!disposed) listener(snapshot);
      })
      .catch(() => undefined)
      .finally(() => {
        refreshPromise = null;
        if (!disposed && queued) {
          queued = false;
          refresh();
        }
      });
  };
  for (const channel of channels) ipcRenderer.on(channel, refresh);
  return () => {
    disposed = true;
    for (const channel of channels) ipcRenderer.removeListener(channel, refresh);
  };
}

const codingToolsApi = Object.freeze({`,
  "function subscribeManagedApps(listener)",
);

replaceOnce(
  "desktop-electron/electron/preload.cjs",
  `  integrations: Object.freeze({
    snapshot: () => invokeContract(ipcRenderer, "integrations.snapshot"),
  }),
  execution: Object.freeze({`,
  `  integrations: Object.freeze({
    snapshot: () => invokeContract(ipcRenderer, "integrations.snapshot"),
  }),
  apps: Object.freeze({
    snapshot: () => invokeContract(ipcRenderer, "apps.snapshot"),
    invoke: (input) => invokeContract(ipcRenderer, "apps.invoke", input),
    reconcile: (input) => invokeContract(ipcRenderer, "apps.reconcile", input),
    onChanged: (listener) => subscribeManagedApps(listener),
  }),
  execution: Object.freeze({`,
  'reconcile: (input) => invokeContract(ipcRenderer, "apps.reconcile", input)',
);

replaceOnce(
  "desktop-electron/electron/ipc-schema.cjs",
  `const executionUpdateRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "expectedRevision", "change", "confirm"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    expectedRevision: Object.freeze({ type: "integer", minimum: 0 }),
    change: genericObject,
    confirm: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const CONTRACTS`,
  `const executionUpdateRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "expectedRevision", "change", "confirm"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    expectedRevision: Object.freeze({ type: "integer", minimum: 0 }),
    change: genericObject,
    confirm: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const managedAppHandle = Object.freeze({
  type: "string",
  enum: Object.freeze(["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]),
});

const managedAppOperation = Object.freeze({
  type: "string",
  enum: Object.freeze([
    "inspect",
    "install",
    "repair",
    "start",
    "stop",
    "restart",
    "providers",
    "plan",
    "sync",
    "ui-inspect",
    "ui-start",
    "ui-stop",
    "ui-restart",
    "ui-open",
    "registration-plan",
    "registration-apply",
    "open",
    "act",
  ]),
});

const managedAppInvokeRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["handle", "operation"]),
  properties: Object.freeze({
    handle: managedAppHandle,
    operation: managedAppOperation,
    arguments: genericObject,
    confirm: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const managedAppsReconcileRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["confirm"]),
  properties: Object.freeze({
    handles: Object.freeze({ type: "array", items: managedAppHandle, maxItems: 5 }),
    reason: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    confirm: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const CONTRACTS`,
  "const managedAppInvokeRequest = Object.freeze({",
);

replaceOnce(
  "desktop-electron/electron/ipc-schema.cjs",
  `  "integrations.snapshot": Object.freeze({
    channel: "coding-tools:integrations:snapshot",
    request: emptyObject,
    response: genericObject,
  }),
  "execution.read":`,
  `  "integrations.snapshot": Object.freeze({
    channel: "coding-tools:integrations:snapshot",
    request: emptyObject,
    response: genericObject,
  }),
  "apps.snapshot": Object.freeze({
    channel: "coding-tools:apps:snapshot",
    request: emptyObject,
    response: genericObject,
  }),
  "apps.invoke": Object.freeze({
    channel: "coding-tools:apps:invoke",
    request: managedAppInvokeRequest,
    response: genericObject,
  }),
  "apps.reconcile": Object.freeze({
    channel: "coding-tools:apps:reconcile",
    request: managedAppsReconcileRequest,
    response: genericObject,
  }),
  "execution.read":`,
  '"apps.snapshot": Object.freeze({',
);

replaceOnce(
  "desktop-electron/src/api/contracts.ts",
  `export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface CodingToolsApi {`,
  `export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ManagedAppHandle = "cpa" | "codex-router" | "commandcode-proxy" | "paseo" | "anneal";
export type ManagedAppOperation =
  | "inspect"
  | "install"
  | "repair"
  | "start"
  | "stop"
  | "restart"
  | "providers"
  | "plan"
  | "sync"
  | "ui-inspect"
  | "ui-start"
  | "ui-stop"
  | "ui-restart"
  | "ui-open"
  | "registration-plan"
  | "registration-apply"
  | "open"
  | "act";

export interface ManagedAppManagedState {
  readonly state: string;
  readonly version: string;
  readonly platformMode: string;
  readonly bundledRuntime: boolean;
  readonly missingInputs: readonly string[];
}

export interface ManagedAppSetupState {
  readonly status: string;
  readonly action: string | null;
  readonly missingInputs: readonly string[];
  readonly message: string | null;
}

export interface ManagedAppUiState {
  readonly status: string;
  readonly available: boolean;
  readonly sections: readonly string[];
  readonly endpoint: string | null;
  readonly originalWindow: boolean;
  readonly error: string | null;
}

export interface ManagedAppSummary {
  readonly handle: ManagedAppHandle;
  readonly name: string;
  readonly kind: "provider-network" | "managed-service" | "managed-upstream";
  readonly status: string;
  readonly available: boolean;
  readonly operations: readonly ManagedAppOperation[];
  readonly endpoint: string | null;
  readonly executionEndpoint: string | null;
  readonly pid: number | null;
  readonly owned: boolean;
  readonly modelCount: number | null;
  readonly accountCount: number;
  readonly connectedAccountCount: number;
  readonly enabledAccountCount: number;
  readonly providerCount: number;
  readonly providerModelCount: number;
  readonly providerNetworkStatus?: string;
  readonly error: string | null;
  readonly managed: ManagedAppManagedState;
  readonly setup: ManagedAppSetupState;
  readonly ui?: ManagedAppUiState;
}

export interface ManagedAppsSnapshot {
  readonly version: 1;
  readonly bootstrap: {
    readonly status: string;
    readonly reason: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly error: string | null;
  };
  readonly apps: readonly ManagedAppSummary[];
}

export interface ManagedAppInvokeInput {
  readonly handle: ManagedAppHandle;
  readonly operation: ManagedAppOperation;
  readonly arguments?: JsonObject;
  readonly confirm?: boolean;
}

export interface ManagedAppsReconcileInput {
  readonly handles?: readonly ManagedAppHandle[];
  readonly reason?: string;
  readonly confirm: boolean;
}

export interface CodingToolsApi {`,
  "export type ManagedAppHandle =",
);

replaceOnce(
  "desktop-electron/src/api/contracts.ts",
  `  readonly integrations: {
    snapshot(): Promise<JsonObject>;
  };
  readonly execution: {`,
  `  readonly integrations: {
    snapshot(): Promise<JsonObject>;
  };
  readonly apps: {
    snapshot(): Promise<ManagedAppsSnapshot>;
    invoke(input: ManagedAppInvokeInput): Promise<JsonObject>;
    reconcile(input: ManagedAppsReconcileInput): Promise<JsonObject>;
    onChanged(listener: (snapshot: ManagedAppsSnapshot) => void): () => void;
  };
  readonly execution: {`,
  "readonly apps: {",
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `import type {
  ExternalServiceId,
  ExternalServicesSnapshot,
  Language,
  ManagedAppTabId,
} from "../types";`,
  `import type { ManagedAppsSnapshot } from "../api/contracts";
import type { Language, ManagedAppTabId } from "../types";`,
  'import type { ManagedAppsSnapshot } from "../api/contracts";',
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `interface ManagedAppTabDefinition {
  id: ManagedAppTabId;
  english: string;
  traditionalChinese: string;
  serviceId: ExternalServiceId;
}

const EMPTY_SERVICES: ExternalServicesSnapshot = { version: 1, services: [] };`,
  `interface ManagedAppTabDefinition {
  id: ManagedAppTabId;
  english: string;
  traditionalChinese: string;
}

const EMPTY_APPS: ManagedAppsSnapshot = {
  version: 1,
  bootstrap: { status: "idle", reason: null, startedAt: null, completedAt: null, error: null },
  apps: [],
};`,
  "const EMPTY_APPS: ManagedAppsSnapshot",
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `  { id: "cpa", english: "CPA", traditionalChinese: "CPA", serviceId: "cpa" },
  {
    id: "codex-router",
    english: "Codex Router",
    traditionalChinese: "Codex Router",
    serviceId: "codex-router",
  },
  {
    id: "commandcode-proxy",
    english: "CommandCode",
    traditionalChinese: "CommandCode",
    serviceId: "commandcode-proxy",
  },
  { id: "paseo", english: "Paseo", traditionalChinese: "Paseo", serviceId: "paseo" },
  { id: "anneal", english: "Anneal", traditionalChinese: "Anneal", serviceId: "anneal" },`,
  `  { id: "cpa", english: "CPA", traditionalChinese: "CPA" },
  {
    id: "codex-router",
    english: "Codex Router",
    traditionalChinese: "Codex Router",
  },
  {
    id: "commandcode-proxy",
    english: "CommandCode",
    traditionalChinese: "CommandCode",
  },
  { id: "paseo", english: "Paseo", traditionalChinese: "Paseo" },
  { id: "anneal", english: "Anneal", traditionalChinese: "Anneal" },`,
  "const appByHandle = useMemo(",
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `  const api = window.codexWebLauncher;
  const [services, setServices] = useState<ExternalServicesSnapshot>(EMPTY_SERVICES);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.externalServicesSnapshot()
      .then((snapshot) => {
        if (!cancelled) setServices(snapshot);
      })
      .catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onExternalServicesChanged(setServices);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, setError]);

  const serviceById = useMemo(
    () => new Map(services.services.map((service) => [service.id, service] as const)),
    [services],
  );`,
  `  const api = window.codingTools?.apps;
  const [snapshot, setSnapshot] = useState<ManagedAppsSnapshot>(EMPTY_APPS);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.snapshot()
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onChanged(setSnapshot);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, setError]);

  const appByHandle = useMemo(
    () => new Map(snapshot.apps.map((app) => [app.handle, app] as const)),
    [snapshot],
  );`,
  "const appByHandle = useMemo(",
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `        {MANAGED_APP_TABS.map((tab) => {
          const service = serviceById.get(tab.serviceId);
          const status = service?.status ?? "unknown";
          const actionRequired = service?.managedInstall.state === "repair-required"
            || service?.managedInstall.state === "error";`,
  `        {MANAGED_APP_TABS.map((tab) => {
          const app = appByHandle.get(tab.id);
          const status = app?.status ?? "unknown";
          const managedState = app?.managed?.state;
          const setupStatus = app?.setup?.status;
          const actionRequired = status === "error"
            || managedState === "repair-required"
            || managedState === "error"
            || managedState === "unavailable"
            || setupStatus === "blocked"
            || setupStatus === "error";`,
  "const setupStatus = app?.setup?.status;",
);

process.stdout.write("RC11_MANAGED_APP_API_MATERIALIZED\n");
