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
  | "providers"
  | "plan"
  | "install"
  | "repair"
  | "start"
  | "stop"
  | "restart"
  | "sync"
  | "open";

export interface ManagedAppManagedState extends JsonObject {
  readonly state: string;
  readonly version: string;
  readonly platformMode: string;
  readonly missingInputs: readonly string[];
}

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
  readonly managed?: ManagedAppManagedState;
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
    snapshot(): Promise<ManagedAppsSnapshot>;
  };
  readonly apps: {
    snapshot(): Promise<ManagedAppsSnapshot>;
    invoke(input: ManagedAppInvokeInput): Promise<JsonObject>;
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
