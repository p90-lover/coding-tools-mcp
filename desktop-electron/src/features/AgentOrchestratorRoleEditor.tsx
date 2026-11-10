import { useEffect, useState } from "react";
import type { AoMission, AoNode } from "./AgentOrchestratorSurface";
import { chatWorkingDetail, type ChatActivity } from "./ao-chat";
import { scoreBadge, type ModelScoreHint } from "./model-scores";
import { GroupLogo, HarnessLogo, ModelLogo } from "./HarnessLogo";

export type RoleSettings = { name: string; specialty: string; instructions: string; expected_output: string; working_directory: string; revision: number; auto_decide?: boolean; role_name?: string };
export type AoTeam = { id: string; workspace_id: string; name: string; revision: number; worker_limit: number; max_review_rounds?: number; review_loop?: boolean; link_points?: Record<string, { x: number; y: number }>; is_default?: boolean; editable_graph?: boolean; nodes: AoNode[]; permission_selections?: Record<string, { permission_profile?: string; approval_policy?: string; approvals_reviewer?: string }> };
export type AoHarness = { id: string; label: string; runnable: boolean; installed: boolean; authStatus?: string; chat?: boolean };
export type AoRoute = AoNode["route"];
export type AoModelCapabilities = {
  efforts?: string[];
  /** The upstream CPA serves this model through, as CPA reports it (e.g. "antigravity"). */
  provider?: string;
  /** `fixed`: the window is set for the model (WebGPT's, by the Codex bridge), not picked. */
  contextWindow?: { min: number; max?: number; kind?: "context" | "compaction"; fixed?: boolean };
  contextLimit?: number; effortReason?: string; contextReason?: string;
};
/** `unavailable`: models CPA lists but cannot serve now, with why (e.g. their plugin's account is disabled in CPA). */
/** `held`: listed models CPA is not listing right now (kept from memory), with why; they still run.
 *  `stale`: CPA could not be read, so the list is the remembered one. */
/** `scores`: each model's points from finished Team rounds (model-scores.ts), for the picker's badges. */
export type AoModelCatalog = { models: string[]; capabilities?: Record<string, AoModelCapabilities>; unavailable?: Record<string, string>;
  held?: Record<string, string>; stale?: boolean; scores?: Record<string, ModelScoreHint> };
export type AoModelLoader = (harness: string) => Promise<string[] | AoModelCatalog>;
export const emptyRoleSettings = (): RoleSettings => ({ name: "", specialty: "", instructions: "", expected_output: "", working_directory: "", revision: 0 });

type CardRole = AoNode["role"];
/**
 * What a new card of each role is told to do. The card keeps its own editable copy (Instructions and
 * Expected output), which is the text its agent reads; the role's built-in duty is added by the
 * controller, so these are the working rules on top of it.
 */
const ROLE_STARTERS: Record<CardRole, { instructions: string; expected_output: string }> = {
  planner: {
    instructions: "Read the mission and the workspace before planning. Give each worker one concrete assignment with the files or areas it owns, the exact steps or commands, and a done-when check it can prove. Keep assignments independent so workers do not edit the same files. Name the tools each check must use.",
    expected_output: "A short plan: one line per worker with its assignment and done-when check, then anything the reviewer must look at closely.",
  },
  approver: {
    instructions: "Read every assignment as the commands it will run. Send it back if a step deletes or overwrites data, force-pushes, installs software, reaches outside the workspace or network, or touches secrets without the mission asking for it. Also send it back when a done-when check cannot be verified.",
    expected_output: "APPROVED or CHANGES_REQUIRED as the first word, then the exact step that must change and why.",
  },
  worker: {
    instructions: "Do only your assignment, inside the workspace. Use the tools the assignment names and run its done-when check yourself. Finish the work before you answer: your final message must contain every requested value (counts, paths, command output), not a promise to report it. If something blocks you, say exactly what and stop.",
    expected_output: "What you changed or checked, the exact commands or tool calls with their key output, and whether the done-when check passed.",
  },
  retry: {
    instructions: "Read the failed worker's error and evidence. Retry only when the failure looks temporary (rate limit, timeout, lost connection) or the assignment can succeed unchanged; wait when a provider or sign-in must recover; give up when the assignment itself is wrong.",
    expected_output: "JSON only, with the action and a one-sentence reason.",
  },
  review_split: {
    instructions: "Give every worker's output to exactly one sub-reviewer, and tell each sub-reviewer which done-when checks to verify.",
    expected_output: "One line per sub-reviewer with the worker cards and checks it covers.",
  },
  sub_reviewer: {
    instructions: "Check only your part. Re-run the cheapest read-only check that proves each claim (read the file, list the folder, run the test) instead of trusting the report. Do not edit anything.",
    expected_output: "PART_OK or PART_FAILED as the first word of your final message, then what you verified and any claim that did not hold.",
  },
  reviewer: {
    instructions: "Verify each worker's report against its assignment and done-when check. Re-run a read-only check for any claim you can test cheaply. A report that is cut off or missing a requested value is not done. Do not edit the implementation.",
    expected_output: "APPROVED or CHANGES_REQUIRED as the first word of your final message, on its own line, then why. With CHANGES_REQUIRED, list the worker cards that must redo their work.",
  },
};

/** Extra working rules for a quick worker preset, keyed by its focus. */
const SPECIALTY_STARTERS: Record<string, string> = {
  frontend: "Check the changed screens at the sizes they are used and keep them keyboard accessible.",
  backend: "Validate inputs, handle errors explicitly, and add or update tests for the changed paths.",
  testing: "Report each test command with its pass/fail counts; do not change product code to make a test pass.",
  research: "Cite where each fact comes from (file and line, doc link, or command output) and do not edit files.",
  security: "Report each risk with where it is, how it could be used, and a fix; do not change credentials.",
  docs: "Match the existing documentation style and check every command or path you document.",
  devops: "Make each build or deploy step repeatable and say how to roll it back.",
};

/** Settings for a new card: its name and focus, plus the starter instructions for its role. */
export function starterSettings(role: CardRole, name: string, specialty = "", roleName?: string): RoleSettings {
  const starter = ROLE_STARTERS[role];
  const extra = SPECIALTY_STARTERS[specialty];
  return { ...emptyRoleSettings(), name, specialty, ...(roleName ? { role_name: roleName } : {}),
    instructions: extra ? `${starter.instructions}\n${extra}` : starter.instructions, expected_output: starter.expected_output };
}

export const NATIVE_HARNESS = "codex-native";
/** New workers run Gemini through the CPA gateway on Claude Code (Native Codex is for OpenAI models). */
export const DEFAULT_WORKER_HARNESS = "ao:claude-code";
export const DEFAULT_WORKER_MODEL = "cpa/gemini-3.8-flash-high";
/** "default" lets an AO agent pick (and change) its own model, so it is never offered or saved. */
export const AGENT_DEFAULT_MODEL = "default";
export const WEB_ROUTE: AoRoute = { harness_id: NATIVE_HARNESS, provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only" };
export const SPECIALTIES = ["planning", "research", "architecture", "frontend", "backend", "database", "api", "devops", "security",
  "testing", "performance", "debugging", "refactor", "docs", "ui-ux", "mobile", "data-ml", "implementation", "qa", "review", "delivery", "recovery"];

/**
 * WebGPT runs only on Native Codex, through the bridge, so a WebGPT model always gets the
 * Native Codex route. Native Codex also runs every CPA pool model, through the shared pool; an
 * AO harness runs CPA models through the gateway as "cpa/<model>". Unspecified non-WebGPT
 * choices default to Claude Code; explicit choices stay on their harness.
 */
export const isWebModel = (model: string) => model.replace(/^cpa\//, "").startsWith("chatgpt-web/");

export function workerRoute(harness: string, model: string, permission: NativePermission = ":workspace"): AoRoute {
  const bare = model.replace(/^cpa\//, "");
  if (isWebModel(model)) return { ...WEB_ROUTE, model: bare, permission_profile: permission === ":ao-default" ? WEB_ROUTE.permission_profile : permission };
  if (harness === NATIVE_HARNESS && model && model !== AGENT_DEFAULT_MODEL) {
    return { harness_id: NATIVE_HARNESS, provider_id: "cliproxyapi-antigravity", account_id: "shared-cpa-pool", model: bare,
      permission_profile: permission === ":ao-default" ? ":workspace" : permission };
  }
  const agent = harness.startsWith("ao:") ? harness : DEFAULT_WORKER_HARNESS;
  const routed = harness.startsWith("ao:") || !model ? model : `cpa/${bare}`;
  return { harness_id: agent, provider_id: "agent-orchestrator", account_id: "ao-local", model: routed || "default", permission_profile: ":ao-default" };
}

/**
 * AO harnesses whose adapter takes the three permission modes: the engine's PERMISSION_AGENTS
 * (electron/agent-orchestrator-workflow.cjs) as harness ids. Native Codex takes them on its own route.
 */
export const PERMISSION_HARNESSES: ReadonlySet<string> = new Set(["ao:claude-code", "ao:codex", "ao:agy"]);
/**
 * The route without a permission choice its harness can't honor. A mode picked on Claude Code or
 * Codex and carried to Pi or opencode (a model pick, the remembered last route, a saved chat) was
 * refused at every launch ("cannot honor the saved permission tuple"), and their permission menu
 * offers no mode to pick instead, so the chat could never start. Those agents run on their own
 * permissions, which the chip shows as Custom.
 */
export function permissionsFitted(route: AoRoute): AoRoute {
  if (!route.harness_id.startsWith("ao:") || PERMISSION_HARNESSES.has(route.harness_id)) return route;
  if (route.native_permission_profile === undefined && route.approval_policy === undefined && route.approvals_reviewer === undefined) return route;
  const fitted: AoRoute = { ...route };
  delete fitted.native_permission_profile;
  delete fitted.approval_policy;
  delete fitted.approvals_reviewer;
  return fitted;
}

/** Reasoning efforts a card may ask for (Codex's names; the engine checks the same list). */
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
/**
 * The WebGPT tiers as ChatGPT's own effort picker names them, each with the one effort the
 * bridge runs it at (Pro is Codex's "ultra"). A tier is its effort: picking either picks both.
 * Luna and Think are not listed: they exist only on Free/Go accounts without that picker, and
 * there the bridge already runs these tiers as Luna (Instant, Medium) or Think (High and up).
 */
export const WEB_TIERS = [
  { model: "chatgpt-web/light", effort: "low", label: "Instant" },
  { model: "chatgpt-web/medium", effort: "medium", label: "Medium" },
  { model: "chatgpt-web/high", effort: "high", label: "High" },
  { model: "chatgpt-web/extra-high", effort: "xhigh", label: "Extra High" },
  { model: "chatgpt-web/pro", effort: "ultra", label: "Pro" },
] as const;
export const webTier = (model: string | undefined) => WEB_TIERS.find(tier => tier.model === model);
/** What Native Codex offers when the model reports no efforts of its own (WebGPT tiers). */
const NATIVE_DEFAULT_EFFORTS = EFFORTS.slice(0, 5);
/** Legacy Native-to-agent carry-over policy; AO controls use the selected model capabilities. */
export const effortApplies = (route: AoRoute) => !(route.harness_id.startsWith("ao:") && route.model.startsWith("cpa/"));
/** Legacy carry-over policy when entering or leaving Native Codex. */
export const contextApplies = (route: AoRoute) => route.harness_id === NATIVE_HARNESS;

/**
 * Carry a card's effort and context window over to its new route where they still apply. Given
 * the catalog the new route is picked from, the window is fitted to the new model (fitWindow): a
 * 1M window carried to a 262K model was sent as is and refused. Without one it stays as it was.
 */
export function withTuning(next: AoRoute, previous: AoRoute, capabilities?: Record<string, AoModelCapabilities>): AoRoute {
  const route: AoRoute = { ...next };
  // Routing is not a permission change: preserve raw custom and managed profile IDs.
  const permission = previous.harness_id === NATIVE_HARNESS ? previous.permission_profile : previous.native_permission_profile ?? (previous.permission_profile !== ":ao-default" ? previous.permission_profile : undefined);
  if (permission !== undefined) {
    if (route.harness_id === NATIVE_HARNESS) route.permission_profile = permission;
    else route.native_permission_profile = permission;
  }
  if (route.harness_id === NATIVE_HARNESS && previous.native_permission_profile !== undefined) route.native_permission_profile = previous.native_permission_profile;
  if (previous.approval_policy !== undefined) route.approval_policy = previous.approval_policy;
  if (previous.approvals_reviewer !== undefined) route.approvals_reviewer = previous.approvals_reviewer;
  // A new model starts on its own effort: carrying the last one over gave DeepSeek and Gemini
  // "effort high" because WebGPT High had been picked before. The window carries where it applies.
  // (A WebGPT model sets its own effort: it is one ChatGPT effort.)
  delete route.effort;
  delete route.context_window;
  const betweenAgents = next.harness_id.startsWith("ao:") && previous.harness_id.startsWith("ao:");
  if (previous.context_window && (betweenAgents || contextApplies(route))) route.context_window = previous.context_window;
  // An AO model the catalog does not describe keeps it (a legacy id list knows no range); Native
  // Codex's range is known without one. A permission mode goes only where the harness takes one.
  const fitted = permissionsFitted(route);
  return capabilities && (capabilities[route.model] || route.harness_id === NATIVE_HARNESS) ? fitWindow(fitted, capabilities[route.model]) : fitted;
}

/** A route's window inside what its model takes: clamped into the range, or dropped where none can be set. */
export function fitWindow(route: AoRoute, capability: AoModelCapabilities | undefined): AoRoute {
  if (route.context_window === undefined) return route;
  const { context } = routeTuning(route, capability);
  const next = { ...route };
  if (!context) delete next.context_window;
  else next.context_window = Math.max(context.min, Math.min(context.max ?? route.context_window, route.context_window));
  return next;
}

/** 262144 -> "256K"; 1048576 and 1000000 -> "1M". */
export function tokensLabel(tokens: number): string {
  if (tokens >= 1_048_576 && tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_024 && tokens % 1_024 === 0) return `${tokens / 1_024}K`;
  return tokens.toLocaleString("en-US");
}

/** A typed token count: "272000", "272,000", "200k", "1.5m" or "1M"; null when it is not one. */
export function parseTokens(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text.replace(/[,_\s]/g, ""));
  if (!match) return null;
  const tokens = Math.round(Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1_000 : 1));
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

/** A token count as the field shows it, read back exactly by parseTokens: "1M", "128k", "272,500". */
export function contextText(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return tokens.toLocaleString("en-US");
}

/** Window sizes offered as you type, within what the model and harness allow. */
const CONTEXT_PRESETS = [32_000, 64_000, 128_000, 200_000, 272_000, 400_000, 1_000_000, 2_000_000];

const EFFORT_ORDER: string[] = [...EFFORTS];

/** What a model supports, for model lists: "up to xhigh effort · 272K context". Native Codex accepts
 *  every effort and a 4,096–2M budget; other harnesses show only what their catalog verified. */
export function capabilityText(capability: AoModelCapabilities | undefined, native = false): string {
  const efforts = (native && !capability?.efforts?.length ? [...NATIVE_DEFAULT_EFFORTS] : capability?.efforts ?? []).filter(effort => EFFORT_ORDER.includes(effort));
  const top = efforts.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)).at(-1);
  // Only a limit the catalog reported is the model's; without one the window's max is just the
  // client's 2M ceiling, which every such model read as "2M context (unverified)". Say nothing then.
  const limit = capability?.contextLimit ?? (native ? 2_000_000 : undefined);
  // Catalog limits are decimal (272,000), so they read best as "272K" rather than tokensLabel's binary units.
  const size = !limit ? "" : limit >= 1_000_000 && limit % 100_000 === 0 ? `${limit / 1_000_000}M`
    : limit >= 1_000 && limit % 1_000 === 0 ? `${limit / 1_000}K` : tokensLabel(limit);
  return [top ? `up to ${top} effort` : "", size ? `${size} context` : ""].filter(Boolean).join(" · ");
}

/**
 * What a route can be tuned to, from its model's catalog entry: the efforts it takes, the
 * window range a card may set, the window a blank card launches with (the model's full known
 * limit, as the workflow's defaultContextWindow), and the preset sizes within range. Native
 * Codex takes the model's own limit when reported, else a 4,096–2M budget. Its WebGPT models take
 * ChatGPT's efforts; a CPA model there only those CPA advertised: offering all five sent "xhigh"
 * to upstreams that reject it. Shared by the role editor and the composer's effort and window menus.
 */
export function routeTuning(route: AoRoute, capability: AoModelCapabilities | undefined) {
  const native = route.harness_id === NATIVE_HARNESS;
  const efforts: readonly string[] | undefined = !native ? capability?.efforts
    : isWebModel(route.model) ? (capability?.efforts?.length ? capability.efforts : [...NATIVE_DEFAULT_EFFORTS]) : capability?.efforts ?? [];
  const nativeMax = Math.min(2000000, capability?.contextLimit ?? 2000000);
  // WebGPT's window is the Codex bridge's own (agent-orchestrator-workflow webWindow): one size, not a choice.
  const fixed = native && isWebModel(route.model) && capability?.contextWindow?.fixed === true ? capability.contextWindow.max ?? null : null;
  const context = fixed ? { min: fixed, max: fixed } : native ? { min: 4096, max: nativeMax } : capability?.contextWindow;
  const fullLimit = fixed ?? (!native && context && capability?.contextLimit ? Math.min(capability.contextLimit, context.max ?? capability.contextLimit) : null);
  const presets = fixed ? [] : context ? CONTEXT_PRESETS.filter(tokens => tokens >= context.min && (context.max === undefined || tokens <= context.max)) : [];
  return { native, efforts, nativeMax, context, fullLimit, presets, fixed };
}

/** Listed models serving the same model as `model` under another provider: a card saved on
 *  cpa/cline-pass/deepseek-v4.1-flash finds cpa/commandcode-go/deepseek-v4.1-flash. */
export function sameModelElsewhere(model: string, models: readonly string[]): string[] {
  const name = (id: string) => id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  const wanted = name(model);
  return wanted ? models.filter(id => id !== model && name(id) === wanted).slice(0, 3) : [];
}

const ROLE_LABELS = { planner: "Orchestrator", approver: "Command approver", worker: "Worker", review_split: "Main reviewer · split", sub_reviewer: "Sub-reviewer", reviewer: "Main reviewer", retry: "Retry" } as const;

/** The role a card shows: the custom role the user typed, else its built-in role's name. */
export function roleLabel(node: Pick<AoNode, "role" | "settings">): string {
  return node.settings?.role_name?.trim() || ROLE_LABELS[node.role];
}

/** One line describing how a card runs: harness · model · effort · context · role. */
export function cardMeta(node: Pick<AoNode, "role" | "settings" | "route">, harnesses: AoHarness[] = [], showRole = true): string {
  const route = node.route;
  return [
    harnessLabel(route.harness_id, harnesses),
    modelLabel(route.model, route.provider_id === "cliproxyapi-antigravity"),
    route.effort && (effortApplies(route) || route.harness_id.startsWith("ao:")) ? `effort ${route.effort}` : "",
    route.context_window && (contextApplies(route) || route.harness_id.startsWith("ao:")) ? `${tokensLabel(route.context_window)} context` : "",
    showRole ? roleLabel(node) : "",
  ].filter(Boolean).join(" · ");
}

/**
 * Native Codex cards use Codex's own profiles: workspace (create, edit and delete inside the
 * workspace; anything else is asked for) or read-only. Workers default to workspace.
 */
export type NativePermission = string;
export const nativePermission = (route: AoRoute): NativePermission => route.harness_id === NATIVE_HARNESS ? route.permission_profile : route.native_permission_profile ?? route.permission_profile;

/** "chatgpt-web/extra-high" -> "WebGPT Extra High"; other model ids are shown as-is. */
// Providers CPA reported for its models, remembered as catalogs load so every label can use them.
const cpaProviders = new Map<string, string>();
export function rememberCpaProviders(capabilities?: Record<string, AoModelCapabilities>) {
  for (const [id, capability] of Object.entries(capabilities ?? {})) {
    if (capability?.provider) cpaProviders.set(id.replace(/^cpa\//, ""), capability.provider);
  }
}
const PROVIDER_NAMES: Record<string, string> = {
  antigravity: "Antigravity", "gemini-cli": "Gemini CLI", gemini: "Gemini", google: "Google", vertex: "Vertex",
  codex: "Codex", openai: "OpenAI", claude: "Claude", anthropic: "Anthropic", "cline-pass": "Cline Pass", cline: "Cline",
  qwen: "Qwen", iflow: "iFlow", kimi: "Kimi", moonshot: "Moonshot", deepseek: "DeepSeek", xai: "xAI", grok: "Grok",
  zhipu: "Zhipu", glm: "Zhipu", openrouter: "OpenRouter", commandcode: "CommandCode", "commandcode-go": "CommandCode Go", "opencode-go": "OpenCode Go", stepfun: "StepFun",
  minimax: "MiniMax", mistral: "Mistral",
};
const providerName = (provider: string) => PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
/** The CPA provider serving a "cpa/<id>" route model (as CPA reported it, else the id's own prefix); null for other models. */
export function cpaProviderOf(model: string | undefined): string | null {
  if (!model?.startsWith("cpa/")) return null;
  const id = model.slice(4);
  const slash = id.indexOf("/");
  return cpaProviders.get(id) ?? (slash > 0 ? id.slice(0, slash) : null);
}
/** A CPA id's provider (as CPA reported it, else the id's own prefix or family) and the model's own part. */
function cpaParts(id: string): { provider: string; name: string } {
  const slash = id.indexOf("/");
  const prefix = slash > 0 ? id.slice(0, slash) : "";
  const name = prefix ? id.slice(slash + 1) : id;
  const lower = name.toLowerCase();
  const family = lower.startsWith("gemini") ? "gemini" : lower.startsWith("claude") ? "claude"
    : /^(gpt|o\d|codex)/.test(lower) ? "openai" : lower.startsWith("grok") ? "grok" : lower.startsWith("deepseek") ? "deepseek"
    : lower.startsWith("glm") ? "zhipu" : lower.startsWith("qwen") ? "qwen" : lower.startsWith("kimi") ? "kimi" : "";
  const provider = cpaProviders.get(id) ?? (prefix || family);
  return { provider: provider ? providerName(provider) : "", name };
}

/** "CPA · <provider> · <model>": the provider CPA reported, else the model id's own prefix or family. */
function cpaLabel(id: string): string {
  const { provider, name } = cpaParts(id);
  return provider ? `CPA · ${provider} · ${name}` : `CPA · ${name}`;
}

// Words whose usual casing a plain capital letter gets wrong.
const MODEL_WORDS: Record<string, string> = {
  gpt: "GPT", oss: "OSS", glm: "GLM", deepseek: "DeepSeek", minimax: "MiniMax", mimo: "MiMo", xai: "xAI",
};

/**
 * A model id as a person reads it: "claude-opus-4-6-thinking" -> "Opus 4.6 Thinking",
 * "gpt-5.6-terra" -> "GPT-5.6 Terra", "kimi-k2.7-code" -> "Kimi K2.7 Code". Claude's family word
 * goes (the group already says Claude; "Opus" is the name); split version digits ("4-6") join.
 */
export function prettyModelName(id: string): string {
  const parts = id.replace(/^claude-(?=opus|sonnet|haiku)/i, "").split("-").filter(Boolean);
  const words: string[] = [];
  for (const part of parts) {
    const previous = words.at(-1);
    // "4-6" is one version, "4.6"; "gpt-5.6" keeps its hyphen, as OpenAI writes it.
    if (/^\d+$/.test(part) && previous && /^\d+(\.\d+)?$/.test(previous)) { words[words.length - 1] = `${previous}.${part}`; continue; }
    if (/^\d/.test(part) && previous === "GPT") { words[words.length - 1] = `GPT-${part}`; continue; }
    const lower = part.toLowerCase();
    words.push(MODEL_WORDS[lower] ?? (/^[a-z]\d/.test(lower) ? lower.toUpperCase() : lower[0].toUpperCase() + lower.slice(1)));
  }
  return words.join(" ");
}

/**
 * How a model list row names a model once a group header says who serves it: the group
 * ("WebGPT", "Claude · CPA") and the model's own name ("High", "Opus 4.6 Thinking"). An
 * agent's own model (not WebGPT, not CPA) has no group and keeps its id, which is what that
 * agent's own docs call it. modelLabel stays the full, unambiguous form for cards and hints.
 */
export function modelShortLabel(model: string, cpaPool = false): { group: string; name: string } {
  // WebGPT keeps its whole name ("ChatGPT Web High") in the list and on the chip, ungrouped: the
  // tier at its end is the effort, which the effort chip then shows and picks.
  if (model.startsWith("chatgpt-web/")) return { group: "", name: modelLabel(model) };
  const cpa = model.startsWith("cpa/") ? model.slice(4) : cpaPool && model ? model : null;
  if (cpa === null) return { group: "", name: model };
  const { provider, name } = cpaParts(cpa);
  return { group: provider ? `${provider} · CPA` : "CPA", name: prettyModelName(name) };
}

/** cpaPool: a bare id that Native Codex runs through the shared CPA pool. */
export function modelLabel(model: string, cpaPool = false): string {
  // On an AO harness, "cpa/<model>" runs that CPA pool model through the local gateway.
  if (model.startsWith("cpa/")) return cpaLabel(model.slice(4));
  if (cpaPool && model && !model.startsWith("chatgpt-web/")) return cpaLabel(model);
  if (!model.startsWith("chatgpt-web/")) return model;
  if (model === "chatgpt-web/high") return "ChatGPT Web High";
  // A tier reads as ChatGPT names it ("light" is ChatGPT's Instant); a saved Luna/Think route keeps its own name.
  return `WebGPT ${webTier(model)?.label ?? model.slice("chatgpt-web/".length).split("-").map(part => part[0]?.toUpperCase() + part.slice(1)).join(" ")}`;
}

export function harnessLabel(harnessId: string, harnesses: AoHarness[]): string {
  return harnesses.find(item => item.id === harnessId)?.label
    ?? (harnessId === NATIVE_HARNESS ? "Native Codex" : harnessId.replace(/^ao:/, ""));
}

export function teamForMission(mission: AoMission, saved: AoTeam | null): AoTeam {
  if (mission.team) {
    const draft = structuredClone(mission.team);
    if (saved?.id === draft.id) draft.revision = saved.revision;
    draft.worker_limit = mission.worker_limit || draft.worker_limit;
    draft.nodes = draft.nodes.map(role => {
      const actual = mission.nodes.find(node => (node.template_role_id || node.id) === role.id);
      return actual ? { ...role, route: structuredClone(actual.route),
        settings: structuredClone(actual.settings || role.settings || emptyRoleSettings()) } : role;
    });
    return draft;
  }
  const roleIds = new Map(mission.nodes.map(node => [node.id, node.template_role_id || node.id]));
  return { id: saved?.id || crypto.randomUUID(), workspace_id: mission.workspace_id, name: saved?.name || "Workspace team",
    revision: saved?.revision || 0, worker_limit: mission.worker_limit || 3,
    nodes: mission.nodes.map(node => ({ id: roleIds.get(node.id)!, task_id: "", role: node.role, route: { ...node.route },
      parents: node.parents.map(id => roleIds.get(id)!), state: "pending", x: node.x, y: node.y, positioned: node.positioned === true,
      settings: { ...emptyRoleSettings(), ...node.settings, name: node.settings?.name || ROLE_LABELS[node.role] },
    })) };
}

export function defaultTeam(workspaceId: string, worker: AoRoute): AoTeam {
  return { id: crypto.randomUUID(), workspace_id: workspaceId, name: "Workspace team", revision: 0, worker_limit: 3,
    nodes: [
      { id: "lead", task_id: "", role: "planner", parents: [], x: 0, y: 0, state: "pending", route: WEB_ROUTE, settings: starterSettings("planner", "Orchestrator", "planning") },
      { id: "worker", task_id: "", role: "worker", parents: ["lead"], x: 0, y: 1, state: "pending", route: worker, settings: starterSettings("worker", "Worker", "implementation") },
      { id: "review", task_id: "", role: "reviewer", parents: ["worker"], x: 0, y: 2, state: "pending", route: WEB_ROUTE, settings: starterSettings("reviewer", "Reviewer", "review") },
    ] };
}

/**
 * The models a picker lists for `harness`. Every harness also lists the WebGPT models; choosing one
 * moves the card to Native Codex, the only harness WebGPT runs on (workerRoute). `agentsOnly` (the
 * Subagents page, whose subagents run on AO agents only) lists the harness's own models alone.
 */
export async function pickerModels(harness: string, loadModels: AoModelLoader, agentsOnly = false): Promise<AoModelCatalog> {
  const web = harness === NATIVE_HARNESS || agentsOnly ? Promise.resolve([] as string[])
    : loadModels(NATIVE_HARNESS).then(items => (Array.isArray(items) ? items : items.models).filter(isWebModel), () => [] as string[]);
  const [items, webItems] = await Promise.all([loadModels(harness), web]);
  const catalog = Array.isArray(items) ? { models: items } : items;
  return { ...catalog, models: [...new Set([...catalog.models, ...webItems])].filter(model => !agentsOnly || !isWebModel(model)) };
}

/** The agents a model several of them run is put on, after the card's own agent: Native Codex last. */
const PICKER_ORDER = [DEFAULT_WORKER_HARNESS, "ao:codex", "ao:opencode"];
/** One model in the card's list, with every agent that runs it and what each says it takes. */
export type PickerChoice = { model: string; harnesses: string[]; capabilities: Record<string, AoModelCapabilities | undefined> };

/**
 * One model list across every installed agent, as the Subagents page has it: one agent's list
 * alone left out Antigravity's Gemini models unless that agent was picked first. Each model is
 * listed once, with the agents that run it, the card's own agent first. Native Codex adds its
 * WebGPT models; its CPA pool ids (bare names) only when the card is on it, or they'd repeat every
 * "cpa/" model.
 */
export function pickerChoices(current: string, catalogs: ReadonlyArray<{ harness: string; catalog: AoModelCatalog }>): PickerChoice[] {
  const rank = (harness: string) => harness === current ? -1 : harness === NATIVE_HARNESS ? PICKER_ORDER.length + 1
    : PICKER_ORDER.includes(harness) ? PICKER_ORDER.indexOf(harness) : PICKER_ORDER.length;
  const byModel = new Map<string, PickerChoice>();
  for (const { harness, catalog } of [...catalogs].sort((a, b) => rank(a.harness) - rank(b.harness))) {
    for (const model of catalog.models) {
      if (!model || model === AGENT_DEFAULT_MODEL) continue;
      if (harness === NATIVE_HARNESS && current !== NATIVE_HARNESS && !isWebModel(model)) continue;
      const choice = byModel.get(model) ?? { model, harnesses: [], capabilities: {} };
      if (!choice.harnesses.includes(harness)) choice.harnesses.push(harness);
      choice.capabilities[harness] = catalog.capabilities?.[model];
      byModel.set(model, choice);
    }
  }
  return [...byModel.values()];
}

/** A list row: the group it sits under (who serves it) and the model's own name. */
export function pickerRow(model: string, harness: string, harnesses: AoHarness[]): { group: string; name: string } {
  if (isWebModel(model)) return { group: "Web GPT", name: modelLabel(model.replace(/^cpa\//, "")) };
  const short = modelShortLabel(model, harness === NATIVE_HARNESS);
  if (short.group) return { group: short.group.replace(/ · CPA$/, "").replace(/^CPA$/, "Other"), name: short.name };
  return { group: harnessLabel(harness, harnesses), name: prettyModelName(model) };
}

const effortName = (effort: string) => effort ? effort[0].toUpperCase() + effort.slice(1) : effort;

/**
 * A card's model: one button with the model's logo that opens the list of every agent's models,
 * then its effort and context window as two slim boxes, offered only where the model takes them.
 * A model more than one agent runs shows those agents' logos to switch between; the picked model
 * otherwise runs on the card's agent, or on the first agent that lists it. Shared by the role
 * editor, the Team page's cards and the New mission and Add worker sheets.
 */
export function HarnessPicker({ route, harnesses, loadModels, onChange, disabled = false, hideModel = false, agentsOnly = false }: {
  route: AoRoute; harnesses: AoHarness[]; disabled?: boolean; hideModel?: boolean; hidePermissionNote?: boolean; agentsOnly?: boolean;
  /** Kept for callers; the list always shows names only. */
  compact?: boolean;
  loadModels: AoModelLoader;
  onChange: (route: AoRoute) => void;
}) {
  const harness = route.harness_id;
  const native = harness === NATIVE_HARNESS;
  // Every runnable agent's list, the card's own agent always among them, and Native Codex's for
  // WebGPT (the Subagents page, agents only, leaves Native Codex out).
  const agents = [...new Set([harness, ...harnesses.filter(item => item.runnable).map(item => item.id), NATIVE_HARNESS])]
    .filter(id => !agentsOnly || id !== NATIVE_HARNESS);
  const agentsKey = agents.join(",");
  const [catalogs, setCatalogs] = useState<Array<{ harness: string; catalog: AoModelCatalog }> | null>(null);
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    setNotice("");
    void Promise.allSettled(agents.map(id => loadModels(id).then(items => ({ harness: id, catalog: Array.isArray(items) ? { models: items } : items }))))
      .then(results => {
        if (!live) return;
        const loaded = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
        for (const { catalog } of loaded) rememberCpaProviders(catalog.capabilities);
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        // Only the card's own agent failing is worth a word: the others just add fewer models.
        if (failed && !loaded.some(item => item.harness === harness)) setNotice(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
        setCatalogs(loaded);
      });
    return () => { live = false; };
  }, [agentsKey, loadModels]);
  const choices = catalogs ? pickerChoices(harness, catalogs) : null;
  const catalogOf = (id: string) => catalogs?.find(item => item.harness === id)?.catalog;
  // Capabilities only from the card's own agent once it answered: another agent's never authorize it.
  const own = catalogOf(harness);
  const listed = own?.capabilities;
  const capability = listed?.[route.model];
  const scores = Object.assign({}, ...(catalogs ?? []).map(item => item.catalog.scores ?? {})) as Record<string, ModelScoreHint>;
  // A saved model the card's agent no longer lists: say so, and offer the same model elsewhere.
  const missing = !native && Boolean(own?.models.length) && Boolean(route.model) && route.model !== AGENT_DEFAULT_MODEL && !own!.models.includes(route.model);
  const { efforts, nativeMax, context, fullLimit, presets, fixed } = routeTuning(route, capability);
  const webEffort = native && isWebModel(route.model);
  const pick = (model: string, agent?: string) => {
    const choice = choices?.find(item => item.model === model);
    const next = agent ?? (choice && !choice.harnesses.includes(harness) ? choice.harnesses[0] : harness);
    onChange(withTuning(workerRoute(next, model, nativePermission(route)), route, catalogOf(next)?.capabilities));
    setOpen(false); setQuery("");
  };
  // What is being typed stays local until it is a whole number in range: a half-typed "1" of
  // "1000000" would otherwise reach the route (and a saved team's autosave) and be refused.
  const [contextDraft, setContextDraft] = useState<string | null>(null);
  const inRange = (tokens: number) => Boolean(context) && Number.isSafeInteger(tokens) && tokens >= context!.min && (context!.max === undefined || tokens <= context!.max);
  const typeContext = (text: string) => {
    setContextDraft(text);
    const tokens = parseTokens(text);
    if (!text.trim()) { if (route.context_window !== undefined) { const next = { ...route }; delete next.context_window; onChange(next); } }
    else if (tokens !== null && inRange(tokens) && tokens !== route.context_window) onChange({ ...route, context_window: tokens });
  };
  const settleContext = () => {
    const text = contextDraft;
    setContextDraft(null);
    if (text === null || !text.trim() || !context) return;
    const tokens = parseTokens(text);
    if (tokens === null) return;
    const settled = Math.max(context.min, context.max !== undefined ? Math.min(context.max, tokens) : tokens);
    if (settled !== route.context_window) onChange({ ...route, context_window: settled });
  };
  const presetsId = `context-presets-${harness}-${route.model}`.replace(/[^\w-]/g, "-");
  const chosen = route.model && route.model !== AGENT_DEFAULT_MODEL ? pickerRow(route.model, harness, harnesses).name : "";
  const runners = choices?.find(item => item.model === route.model)?.harnesses ?? [];
  const search = query.trim().toLowerCase();
  const groups = new Map<string, PickerChoice[]>();
  for (const choice of choices ?? []) {
    const row = pickerRow(choice.model, choice.harnesses[0], harnesses);
    if (search && !`${choice.model} ${row.name} ${row.group}`.toLowerCase().includes(search)) continue;
    groups.set(row.group, [...groups.get(row.group) ?? [], choice]);
  }
  // The why of a disabled or limited box is in its tooltip, not printed under it.
  const effortTitle = webEffort ? "Reasoning effort" : capability?.effortReason || (efforts ? efforts.length ? "Reasoning effort" : "This model has no effort setting" : "Model capabilities unknown");
  const contextTitle = fixed ? capability?.contextReason || "WebGPT's window is the Codex bridge's"
    : native ? `Context window in tokens (4,096 to ${nativeMax.toLocaleString("en-US")})`
    : capability?.contextReason || (context ? context.kind === "compaction" ? "Client compaction threshold in tokens, not the model context limit"
      : `Client context budget in tokens${capability?.contextLimit ? `, up to ${tokensLabel(capability.contextLimit)}` : ""}` : "This agent can't set a context window");
  return <div className="ao-route-picker ao-wide">
    <div className="ao-route-bar">
      {!hideModel ? <button type="button" className={`ao-route-model${missing ? " is-warning" : ""}`} aria-label="Model" aria-haspopup="listbox" aria-expanded={open}
        title={route.model ? [modelLabel(route.model, native && !isWebModel(route.model)), route.model].join("\n") : undefined}
        disabled={disabled} onClick={() => setOpen(value => !value)}>
        {chosen ? <ModelLogo model={route.model} label={chosen} size={14} /> : null}
        <span>{chosen || (choices === null ? "Loading…" : "Choose a model")}</span>
        <i className="ao-route-caret" aria-hidden="true" />
      </button> : null}
      {runners.length > 1 ? <span className="ao-route-agents" role="radiogroup" aria-label="Runs on">
        {runners.map(id => <button key={id} type="button" role="radio" aria-checked={id === harness} aria-label={harnessLabel(id, harnesses)}
          title={harnessLabel(id, harnesses)} disabled={disabled} onClick={() => { if (id !== harness) pick(route.model, id); }}>
          <HarnessLogo harnessId={id} label={harnessLabel(id, harnesses)} size={14} /></button>)}
      </span> : null}
      {efforts?.length || route.effort !== undefined ? <select className="ao-route-effort" aria-label="Reasoning effort" title={effortTitle}
        value={route.effort ?? ""} disabled={disabled || !efforts?.length}
        aria-invalid={!webEffort && Boolean(route.effort) && Boolean(efforts) && !efforts?.includes(route.effort!)}
        onChange={event => { const next = { ...route }; if (event.target.value) next.effort = event.target.value; else delete next.effort; onChange(next); }}>
        <option value="">Effort</option>
        {!webEffort && route.effort && !efforts?.includes(route.effort) ? <option value={route.effort} disabled>{effortName(route.effort)} (not offered)</option> : null}
        {(efforts ?? []).map(effort => <option key={effort} value={effort}>{effortName(effort)}</option>)}
      </select> : null}
      {context || fixed || route.context_window !== undefined ? <>
        {/* Typed freely: 272000, 272,000, 272k or 1m; the list offers sizes the model takes. */}
        <input className="ao-route-context" type="text" inputMode="numeric" aria-label="Context window" title={contextTitle}
          list={presets.length ? presetsId : undefined} disabled={disabled || !context || Boolean(fixed)}
          placeholder={fixed ? contextText(fixed) : fullLimit ? contextText(fullLimit) : "Context"}
          value={contextDraft ?? (route.context_window !== undefined ? contextText(route.context_window) : "")}
          aria-invalid={contextDraft !== null && contextDraft.trim() !== "" && !inRange(parseTokens(contextDraft) ?? Number.NaN)
            || !native && Boolean(context) && route.context_window !== undefined && !inRange(route.context_window)}
          onChange={event => typeContext(event.target.value)}
          // Leaving the field settles a value outside the model's range to the nearest limit.
          onBlur={settleContext} />
        {presets.length ? <datalist id={presetsId}>{presets.map(tokens => <option key={tokens} value={contextText(tokens)} />)}</datalist> : null}
      </> : null}
      {/* A CPA model on Native Codex can hold an effort it does not take, behind a disabled select. */}
      {(!native || !webEffort && route.effort !== undefined) && (route.effort !== undefined || route.context_window !== undefined)
        ? <button type="button" className="ao-route-reset" aria-label="Model defaults" title="Clear effort and context window" disabled={disabled}
          onClick={() => { const next = { ...route }; delete next.effort; delete next.context_window; onChange(next); }}>↺</button> : null}
    </div>
    {open && !hideModel ? <div className="ao-route-list" role="listbox" aria-label="Models">
      {(choices?.length ?? 0) > 8 ? <input type="search" className="ao-route-search" aria-label="Search models" placeholder="Search"
        value={query} onChange={event => setQuery(event.target.value)} /> : null}
      {choices === null ? <p className="ao-route-empty" role="status">Loading…</p> : [...groups].map(([group, items]) => <div key={group} className="ao-route-group" role="group" aria-label={group}>
        <h4><GroupLogo group={group} />{group}</h4>
        {items.map(choice => {
          const row = pickerRow(choice.model, choice.harnesses[0], harnesses);
          const badge = scoreBadge(scores[choice.model]);
          return <button key={choice.model} type="button" role="option" aria-selected={choice.model === route.model} className="ao-route-option" data-model={choice.model}
            title={[modelLabel(choice.model, choice.harnesses[0] === NATIVE_HARNESS && !isWebModel(choice.model)), choice.model,
              capabilityText(choice.capabilities[choice.harnesses[0]], choice.harnesses[0] === NATIVE_HARNESS && isWebModel(choice.model))].filter(Boolean).join("\n")}
            disabled={disabled} onClick={() => pick(choice.model)}>
            <ModelLogo model={choice.model} label={row.name} size={14} /><span>{row.name}</span>{badge ? <small>{badge}</small> : null}
          </button>;
        })}
      </div>)}
      {choices !== null && !groups.size ? <p className="ao-route-empty" role="status">No models</p> : null}
    </div> : null}
    {missing ? <p className="ao-hint" role="status">Not on this agent.
      {sameModelElsewhere(route.model, own?.models ?? []).map(other => <button key={other} type="button" className="button-secondary ao-score-pick" disabled={disabled}
        onClick={() => pick(other, harness)}>Use {modelLabel(other)}</button>)}</p> : null}
    {notice ? <p className="ao-hint" role="status">{notice}</p> : null}
  </div>;
}

export function AgentOrchestratorRoleEditor({ node, mission, draft, harnesses, loadModels, busy = false, change, apply, status, discard, taskName, template = false, activity }: {
  node: AoNode; mission: AoMission; draft: AoTeam; harnesses: AoHarness[]; busy?: boolean; status?: string; template?: boolean; activity?: Record<string, ChatActivity>;
  loadModels: AoModelLoader;
  change: (team: AoTeam, immediate?: boolean) => void; apply?: () => void; discard: () => void; taskName: (id: string) => string;
}) {
  const [tab, setTab] = useState<"settings" | "output" | "history">(!template && ["running", "reserved"].includes(node.state) ? "output" : "settings");
  const roleId = node.template_role_id || node.id;
  const role = draft.nodes.find(role => role.id === roleId);
  const settings = { ...emptyRoleSettings(), ...role?.settings };
  const jobs = mission.nodes.filter(job => (job.template_role_id || job.id) === roleId);
  const [jobId, setJobId] = useState(node.id);
  const job = jobs.find(job => job.id === jobId) || jobs[0] || node;
  const live = activity?.[`${mission.id}:${job.id}`];
  const working = !template && ["running", "reserved"].includes(job.state);
  const progress = working ? chatWorkingDetail(job, live, Date.now()).detail : "";
  let immediateChange = false;
  const updateRole = (patch: Partial<AoNode>) => change({ ...draft, nodes: draft.nodes.map(item => item.id === roleId ? { ...item, ...patch } : item) }, immediateChange);
  const updateSettings = (patch: Partial<RoleSettings>) => updateRole({ settings: { ...settings, ...patch } });
  // Starter text the user has not edited follows the card's role; edited text stays.
  const followsStarter = (kind: AoNode["role"]) => {
    const starter = starterSettings(kind, settings.name, settings.specialty);
    return (!settings.instructions || settings.instructions === starter.instructions)
      && (!settings.expected_output || settings.expected_output === starter.expected_output);
  };
  const roleDefaults = (kind: AoNode["role"]) => {
    const { instructions, expected_output } = starterSettings(kind, settings.name, settings.specialty);
    return { instructions, expected_output };
  };
  const changeKind = (kind: AoNode["role"]) => {
    // Every role may run on any harness and model, so changing the role keeps its route.
    if (role && (template || kind !== "retry" && role.role !== "retry")) {
      updateRole({ role: kind, settings: { ...settings, role_name: "", ...(followsStarter(role.role) ? roleDefaults(kind) : {}) } });
    }
  };
  // A custom role works as a worker under the name the user typed; names already used in this
  // team are offered again.
  const customRoles = [...new Set(draft.nodes.map(item => item.settings?.role_name?.trim() || "").filter(Boolean))];
  const roleValue = settings.role_name !== undefined && settings.role_name !== "" ? `custom:${settings.role_name}` : role?.role ?? "worker";
  const [typingRole, setTypingRole] = useState(false);
  const pickRole = (value: string) => {
    if (!role || (!template && role.role === "retry")) return;
    if (value === "custom:") { setTypingRole(true); updateRole({ role: "worker", settings: { ...settings, role_name: settings.role_name || "" } }); return; }
    setTypingRole(false);
    if (value.startsWith("custom:")) updateRole({ role: "worker", settings: { ...settings, role_name: value.slice(7) } });
    else changeKind(value as AoNode["role"]);
  };
  return <div className="ao-role-inspector" aria-label="Role inspector">
    {working ? <p className="ao-hint ao-role-live" role="status">{progress || "Working. Waiting for the first update…"}</p> : null}
    {!template ? <div className="ao-inspector-tabs" role="tablist" aria-label="Role details">
      {(["settings", "output", "history"] as const).map(name => <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}
    </div> : null}
    {template || tab === "settings" ? role ? <form onSubmit={event => { event.preventDefault(); if (template) apply?.(); }}
      onChangeCapture={event => { const target = event.target as HTMLElement; immediateChange = target.tagName === "SELECT" || target.getAttribute("type") === "checkbox"; }}>
      <div className="ao-field-row">
        <label>Name<input maxLength={96} value={settings.name} onChange={event => updateSettings({ name: event.target.value })} /></label>
        <label>Role<select value={typingRole ? "custom:" : roleValue} disabled={!template && role.role === "retry"} title={!template ? "Set up Retry roles on the Orchestrator Team page before starting a chat" : undefined} onChange={event => pickRole(event.target.value)}>
          <option value="planner">Orchestrator</option><option value="approver">Command approver</option><option value="worker">Worker</option>
          <option value="sub_reviewer">Sub-reviewer</option><option value="reviewer">Main reviewer</option><option value="retry" disabled={(!template && role.role !== "retry") || (role.role !== "retry" && draft.nodes.some(item => item.role === "retry"))}>Retry</option>
          {role.role === "review_split" ? <option value="review_split">Main reviewer · split</option> : null}
          {customRoles.map(name => <option key={name} value={`custom:${name}`}>{name}</option>)}
          <option value="custom:">Custom role…</option>
        </select></label>
      </div>
      {typingRole || (settings.role_name !== undefined && settings.role_name !== "" && !customRoles.includes(settings.role_name.trim()))
        ? <label>Custom role<input autoFocus maxLength={48} placeholder="e.g. Security auditor" value={settings.role_name ?? ""}
          onChange={event => updateSettings({ role_name: event.target.value })} onBlur={() => setTypingRole(false)} /></label> : null}
      <div className="ao-field-row">
        <HarnessPicker route={role.route} harnesses={harnesses} loadModels={loadModels} onChange={route => updateRole({ route })} />
      </div>
      <label>Focus<select value={settings.specialty} onChange={event => updateSettings({ specialty: event.target.value })}>
        <option value="">Custom</option>{SPECIALTIES.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label>Instructions<textarea aria-label="Instructions" rows={4} maxLength={4096} value={settings.instructions} onChange={event => updateSettings({ instructions: event.target.value })} /></label>
      {!followsStarter(role.role) || !settings.instructions
        ? <button type="button" className="ao-role-defaults" title="Reset instructions and expected output to the role's defaults"
          onClick={() => updateSettings(roleDefaults(role.role))}>Use role defaults</button> : null}
      <details className="ao-more">
        <summary>More</summary>
        <label>Expected output<textarea aria-label="Expected output" rows={3} maxLength={2048} value={settings.expected_output} onChange={event => updateSettings({ expected_output: event.target.value })} /></label>
        <label>Working directory<input placeholder="Workspace root" maxLength={512} value={settings.working_directory} onChange={event => updateSettings({ working_directory: event.target.value })} /></label>
      </details>
      {template ? <div className="ao-inspector-actions" title="The team saves itself for new chats. Existing chats keep their team.">
        <span role="status">Changes save automatically</span>
      </div> : <div className="ao-inspector-actions" title="Changes apply to this mission once its current work stops">
        <span role="status">{status || "Changes apply automatically"}</span>
        <button className="button-secondary" type="button" onClick={discard}>Reset to saved</button>
      </div>}
    </form> : <p className="ao-hint">Not linked to the saved team. Results stay available.</p> : null}
    {!template && tab === "output" ? <div>
      {jobs.length > 1 ? <label>Task<select value={job.id} onChange={event => setJobId(event.target.value)}>{jobs.map(item => <option key={item.id} value={item.id}>{taskName(item.task_id)}</option>)}</select></label> : null}
      {job.receipt?.error ? <p role="alert">{job.receipt.error}</p> : null}
      {job.receipt?.verdict ? <p className="ao-chip-line"><span className="ao-chip">{job.receipt.verdict}</span></p> : null}
      {live?.error && live.error !== job.receipt?.error ? <p role="alert">{live.error}</p> : null}
      <pre aria-label="Role output">{job.receipt?.answer || live?.output || (working ? "Waiting for output…" : "No output yet.")}</pre>
    </div> : null}
    {!template && tab === "history" ? <div>{jobs.map(item => <section key={item.id} className="ao-attempt-history">
      <strong>{taskName(item.task_id)}</strong>
      {[...(item.history || []), ...(item.receipt ? [item.receipt] : [])].map((receipt, index) => <details key={receipt.request_key || index}>
        <summary>#{index + 1} · {receipt.status}</summary>
        <dl><dt>Model</dt><dd>{receipt.route?.model || item.route.model}</dd><dt>Session</dt><dd>{receipt.thread_id || "—"}</dd><dt>Turn</dt><dd>{receipt.turn_id || "—"}</dd></dl>
        {receipt.error ? <p role="alert">{receipt.error}</p> : null}<pre>{receipt.answer || "No final output"}</pre>
      </details>)}
      {!item.receipt && !item.history?.length ? <p className="ao-hint">Not started</p> : null}
    </section>)}</div> : null}
  </div>;
}
