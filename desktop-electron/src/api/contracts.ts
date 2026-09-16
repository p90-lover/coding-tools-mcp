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

export interface ExecutionReadInput {
  readonly workspaceId: string;
  readonly missionId?: string | null;
  readonly refreshSource?: boolean;
}

export type ExecutionProviderOperation = "configure" | "connect" | "disable";
export type ExecutionEngine = "paseo" | "anneal";

export interface ExecutionProviderSettings {
  readonly id?: string | null;
  readonly engine: ExecutionEngine;
  readonly endpoint: string;
  readonly provider: string;
  readonly model: string;
  readonly mode: string;
  readonly projectId?: string | null;
  readonly repoId?: string | null;
  readonly assigneeId?: string | null;
  readonly maxDurationMin: number;
  readonly allowCodex: boolean;
  readonly confirmExternalExecution: boolean;
}

export interface ExecutionProviderInput {
  readonly workspaceId: string;
  readonly operation: ExecutionProviderOperation;
  readonly expectedRevision?: number | null;
  readonly bindingId?: string | null;
  readonly settings?: ExecutionProviderSettings | null;
  readonly credential?: string;
  readonly confirm: boolean;
}

export interface ExecutionUpdateInput {
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly change: JsonObject;
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
  readonly execution: {
    read(input: ExecutionReadInput): Promise<JsonObject>;
    provider(input: ExecutionProviderInput): Promise<JsonObject>;
    update(input: ExecutionUpdateInput): Promise<JsonObject>;
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
