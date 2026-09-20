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

/**
 * In-process Coding Tools modules on `codingTools.apps`.
 *
 * `instant-mcp-tools` is typed for the Instant MCP Tools Managed App visual.
 * Bot GG owns `app-handler` registration — do not invent a second IPC host.
 * Until that handler lands, `apps.list()` / `apps_list` still return the five
 * registered modules; Instant MCP Tools runs as an in-process embed with no
 * listen-port Start. Expected Bot GG operations: inspect, list-tools, run-tool.
 */
export type AppsModuleId =
  | "cpa"
  | "codex-router"
  | "commandcode-proxy"
  | "paseo"
  | "anneal"
  | "instant-mcp-tools";

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
  readonly apps: {
    list(): Promise<JsonObject>;
    catalog(): Promise<JsonObject>;
    call(input: {
      readonly moduleId: AppsModuleId;
      readonly operation: string;
      readonly requestId?: string;
      readonly arguments?: JsonObject;
    }): Promise<JsonObject>;
    invoke(input: {
      readonly handle?: AppsModuleId;
      readonly moduleId?: AppsModuleId;
      readonly operation: string;
      readonly requestId?: string;
      readonly arguments?: JsonObject;
      readonly confirm?: boolean;
    }): Promise<JsonObject>;
  };
}

declare global {
  interface Window {
    codingTools?: CodingToolsApi;
  }
}
