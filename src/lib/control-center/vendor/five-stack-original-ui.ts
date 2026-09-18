export type FiveStackId =
  | "codex-router"
  | "cpa"
  | "commandcode-proxy"
  | "paseo"
  | "anneal";

export const FIVE_STACK_IDS: readonly FiveStackId[] = [
  "codex-router",
  "cpa",
  "commandcode-proxy",
  "paseo",
  "anneal",
];

export const PASEO_ORIGINAL_ORIGIN = "http://127.0.0.1:6768";
export const PASEO_SECTION_PATHS = {
  agents: "/sessions",
  sessions: "/sessions",
  workspaces: "/open-project",
  providers: "/settings",
  plugins: "/settings",
  voice: "/settings",
  settings: "/settings",
} as const;

export const ANNEAL_ORIGINAL_ORIGIN = "http://127.0.0.1:5173";
export const ANNEAL_API_ORIGIN = "http://127.0.0.1:3000";
export const ANNEAL_SECTION_PATHS = {
  tasks: "#/tasks",
  projects: "#/projects",
  agents: "#/agents",
  sessions: "#/sessions",
  inbox: "#/inbox",
  automations: "#/automations",
  triggers: "#/triggers",
  costs: "#/costs",
  goals: "#/goals",
  connections: "#/connections",
  settings: "#/settings",
} as const;

export const CPA_ORIGINAL_ORIGIN = "http://127.0.0.1:8317";
export const CPA_SECTION_PATHS = {
  dashboard: "/management.html#/dashboard",
  "ai-providers": "/management.html#/ai-providers",
  "auth-files": "/management.html#/auth-files",
  oauth: "/management.html#/oauth",
  quota: "/management.html#/quota",
  config: "/management.html#/config",
  logs: "/management.html#/logs",
  system: "/management.html#/system",
  plugins: "/management.html#/plugins",
} as const;

export const CODEX_ROUTER_ORIGINAL_ORIGIN = "http://127.0.0.1:4202";
export const COMMANDCODE_MANAGED_ORIGIN = "http://127.0.0.1:9090";

export type FiveStackSnapshot = {
  id: FiveStackId;
  name: string;
  endpoint: string;
  status: string;
  sections: string[];
  pid: number | null;
  owned: boolean;
  original_chrome: boolean;
  install_state: string;
  error: string | null;
  health: Record<string, unknown> | null;
  long_run?: {
    desired?: string;
    selected_section?: string;
    ui_status?: string;
    uiStatus?: string;
    reconnect_attempts?: number;
    max_attempts?: number;
    retry_after_seconds?: number;
    blocked_reason?: string | null;
  } | null;
};

export type FiveStackCatalog = {
  version: number;
  tools: FiveStackSnapshot[];
};

export type FiveStackOpenResult = {
  tool: FiveStackSnapshot;
  section: string;
  url: string;
  original_window: boolean;
};
