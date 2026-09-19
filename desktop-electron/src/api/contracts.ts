export type WorkspaceMcpState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly mcpState: WorkspaceMcpState;
  readonly policyRevision: number;
}

export interface PageRequest {
  readonly cursor?: number;
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: number | null;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
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

export interface CodingToolsApi {
  readonly runtime: {
    status(): Promise<JsonObject>;
  };
  readonly workspaces: {
    list(input?: PageRequest): Promise<Page<WorkspaceSummary>>;
  };
  readonly permissions: {
    snapshot(input: { readonly workspaceId: string }): Promise<JsonObject>;
  };
  readonly computer: {
    status(): Promise<JsonObject>;
  };
  readonly tasks: {
    list(input?: PageRequest & { readonly workspaceId?: string }): Promise<Page<JsonObject>>;
  };
  readonly history: {
    search(input: {
      readonly workspaceRoot: string;
      readonly query: string;
      readonly cursor?: number;
      readonly limit?: number;
    }): Promise<Page<JsonObject>>;
  };
  readonly nativeCodex: {
    status(): Promise<JsonObject>;
  };
  readonly integrations: {
    snapshot(): Promise<JsonObject>;
  };
  readonly apps: {
    snapshot(): Promise<ManagedAppsSnapshot>;
    invoke(input: ManagedAppInvokeInput): Promise<JsonObject>;
    reconcile(input: ManagedAppsReconcileInput): Promise<JsonObject>;
    onChanged(listener: (snapshot: ManagedAppsSnapshot) => void): () => void;
  };
  readonly execution: {
    read(input: {
      readonly workspaceId: string;
      readonly missionId?: string | null;
      readonly refreshSource?: boolean;
    }): Promise<JsonObject>;
    provider(input: {
      readonly workspaceId: string;
      readonly operation: "configure" | "connect" | "disable";
      readonly expectedRevision?: number | null;
      readonly bindingId?: string | null;
      readonly settings?: JsonObject | null;
      readonly providerAccountId?: string | null;
      readonly allowProviderFallback?: boolean;
      readonly controlCredential?: string;
      readonly confirm: boolean;
    }): Promise<JsonObject>;
    update(input: {
      readonly workspaceId: string;
      readonly expectedRevision: number;
      readonly change: JsonObject;
      readonly confirm: boolean;
    }): Promise<JsonObject>;
  };
  readonly updates: {
    status(): Promise<JsonObject>;
  };
  readonly diagnostics: {
    snapshot(): Promise<JsonObject>;
  };
  readonly tools: {
    catalog(input: { readonly workspaceId: string }): Promise<JsonObject>;
    call(input: {
      readonly workspaceId: string;
      readonly tool: string;
      readonly requestId?: string;
      readonly arguments?: JsonObject;
    }): Promise<JsonObject>;
  };
}

declare global {
  interface Window {
    codingTools?: CodingToolsApi;
  }
}
