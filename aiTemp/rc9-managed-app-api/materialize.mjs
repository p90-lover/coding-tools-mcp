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
    throw new Error(`Expected one anchor in ${relative}, found ${count}: ${oldValue.slice(0, 160)}`);
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
  managedAppApi,
  updateController,
}) {`,
  "  managedAppApi,\n  updateController,",
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
      const mutating = ["install", "repair", "start", "stop", "restart", "sync"]
        .includes(input?.operation);
      assertFocusedMainWindow(event, mutating);
      return requireManagedAppApi().invoke(input);
    },

    async updatesStatus(event) {`,
  "async managedAppsSnapshot(event)",
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
  `  const codingTools = createCodingToolsShellBridge({
    assertFocusedMainWindow,
    headlessHost,
    updateController,
  });`,
  `  const managedAppApi = createManagedAppApiHandler({
    externalServices: externalServicesController,
    upstreamTools: upstreamToolController,
    getProviderController: providerNetworkReady,
    createExecutionPlan: createProviderExecutionPlan,
    logger,
  });
  const codingTools = createCodingToolsShellBridge({
    assertFocusedMainWindow,
    headlessHost,
    managedAppApi,
    updateController,
  });`,
  "const managedAppApi = createManagedAppApiHandler({",
);

replaceOnce(
  "desktop-electron/electron/main.cjs",
  `  handle("coding-tools:integrations:snapshot", (event) => codingTools.integrationsSnapshot(event));
  handle("coding-tools:updates:status",`,
  `  handle("coding-tools:integrations:snapshot", (event) => codingTools.integrationsSnapshot(event));
  handle("coding-tools:apps:snapshot", (event) => codingTools.managedAppsSnapshot(event));
  handle("coding-tools:apps:invoke", (event, input) => codingTools.managedAppInvoke(event, input));
  handle("coding-tools:updates:status",`,
  'handle("coding-tools:apps:snapshot"',
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
  }),
  execution: Object.freeze({`,
  'invokeContract(ipcRenderer, "apps.snapshot")',
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

const managedAppInvokeRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["handle", "operation"]),
  properties: Object.freeze({
    handle: Object.freeze({
      type: "string",
      enum: Object.freeze(["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]),
    }),
    operation: Object.freeze({
      type: "string",
      enum: Object.freeze([
        "inspect", "providers", "plan", "install", "repair", "start", "stop", "restart", "sync", "open",
      ]),
    }),
    arguments: genericObject,
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
  | "providers"
  | "plan"
  | "install"
  | "repair"
  | "start"
  | "stop"
  | "restart"
  | "sync"
  | "open";

export interface ManagedAppSummary {
  readonly handle: ManagedAppHandle;
  readonly name: string;
  readonly kind: "provider-network" | "managed-service" | "managed-upstream";
  readonly status: string;
  readonly available: boolean;
  readonly operations: readonly ManagedAppOperation[];
  readonly endpoint?: string | null;
  readonly executionEndpoint?: string | null;
  readonly accountCount: number;
  readonly connectedAccountCount: number;
  readonly modelCount: number | null;
  readonly error: string | null;
  readonly [key: string]: JsonValue | undefined;
}

export interface ManagedAppsSnapshot {
  readonly version: 1;
  readonly apps: readonly ManagedAppSummary[];
}

export interface ManagedAppInvokeInput {
  readonly handle: ManagedAppHandle;
  readonly operation: ManagedAppOperation;
  readonly arguments?: JsonObject;
  readonly confirm?: boolean;
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
    snapshot(): Promise<ManagedAppsSnapshot>;
  };
  readonly apps: {
    snapshot(): Promise<ManagedAppsSnapshot>;
    invoke(input: ManagedAppInvokeInput): Promise<JsonObject>;
  };
  readonly execution: {`,
  "readonly apps: {",
);

process.stdout.write("managed app API materialization complete\n");
