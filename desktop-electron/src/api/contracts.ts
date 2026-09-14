export type RuntimeState =
  | "stopped"
  | "starting"
  | "running"
  | "draining"
  | "stopping"
  | "blocked"
  | "error";

export interface RuntimeStatus {
  readonly protocolVersion: number;
  readonly state: RuntimeState;
  readonly version: string;
  readonly activeOperations: number;
  readonly reason?: string;
}

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

export interface CodingToolsApi {
  readonly runtime: {
    status(): Promise<RuntimeStatus>;
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
  readonly updates: {
    status(): Promise<JsonObject>;
  };
  readonly diagnostics: {
    snapshot(): Promise<JsonObject>;
  };
}

declare global {
  interface Window {
    codingTools?: CodingToolsApi;
  }
}
