export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
export const CHATGPT_WEB_BACKEND_MODEL = "gpt-5.6-sol";
export const CHATGPT_WEB_LUNA_BACKEND_MODEL = "gpt-5.6-luna";
export const CHATGPT_WEB_GPT55_BACKEND_MODEL = "gpt-5.5";
/** Internal adapter identity for a turn whose ChatGPT model is selected by the user in the launcher. */
export const CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL = "chatgpt-web-zero-risk";
/** Internal adapter identity for the explicitly enabled, Pro-sized Zero Risk context profile. */
export const CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL = "chatgpt-web-zero-risk-pro";

export type ChatGptWebAutomaticBackendModel =
  | typeof CHATGPT_WEB_BACKEND_MODEL
  | typeof CHATGPT_WEB_LUNA_BACKEND_MODEL
  | typeof CHATGPT_WEB_GPT55_BACKEND_MODEL;
export type ChatGptWebModelPin = "latest" | "sol" | "gpt-5.5";
export type ChatGptWebBackendModel =
  | ChatGptWebAutomaticBackendModel
  | ChatGptWebZeroRiskBackendModel;
export type ChatGptWebZeroRiskBackendModel =
  | typeof CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
  | typeof CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;

export type ChatGptWebCodexEffort = "low" | "medium" | "high" | "xhigh" | "ultra";
export type ChatGptWebAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Measured Plus browser transport windows, including the fixed hidden ChatGPT platform reserve.
 * Codex compacts the visible task at the lower explicit threshold before the next browser turn is
 * compiled. The remaining headroom is owned by ChatGPT's product prompt and Codex Native schemas.
 */
export const CHATGPT_WEB_INSTANT_CONTEXT_WINDOW = 41_000;
export const CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT = 32_000;
/**
 * Zero Risk keeps one visible ChatGPT conversation across sequential Codex turns. Its fixed route
 * therefore uses the requested three-turn compaction interval without enabling Bigger Context's
 * automatic multipart transport; the user still pastes exactly one incremental prompt per turn.
 */
export const CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW = CHATGPT_WEB_INSTANT_CONTEXT_WINDOW * 3;
export const CHATGPT_WEB_ZERO_RISK_AUTO_COMPACT_TOKEN_LIMIT = CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT * 3;
export const CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW = 90_000;
export const CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT = 80_000;
export const CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT = 211_256;
export const CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT = 1_048_572;
/** Hidden ChatGPT product prompt and Codex Native schema reserve included in usage estimates. */
export const CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192;
/** Reserve for each attachment in the final browser message; inert stages carry no images. */
export function chatGptWebImageTokenReserve(detail?: string): number {
  return detail === "original" ? 8_192 : 4_096;
}
/** Pro-account usable browser windows and separately measured one-message boundaries. */
export const CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT = 95_000;
export const CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT = 103_000;
export const CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT = 104_000;
// Browser message maxima are inclusive, while the context preflight treats its ceiling as an
// exclusive upper bound. The extra token preserves the last accepted payload exactly.
export const CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
export const CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
/**
 * Zero Risk Pro keeps the same three-turn manual conversation budget as the default profile, but
 * sizes each turn from the measured ChatGPT Pro boundary. The launcher cannot verify that the user
 * actually selected Pro, so this profile is exposed only through an explicit user setting.
 */
export const CHATGPT_WEB_ZERO_RISK_PRO_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW * 3;
export const CHATGPT_WEB_ZERO_RISK_PRO_AUTO_COMPACT_TOKEN_LIMIT =
  CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT * 3;
export const CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT = 545_000;
export const CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT = 1_045_000;
export const CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT = 1_635_000;
/**
 * The underlying Luna model owns this context window. ChatGPT Free's much smaller browser request
 * envelope is enforced separately at the browser boundary; rolling checkpoints keep completed
 * history out of later browser requests without asking Codex to compact its canonical history.
 */
export const CHATGPT_WEB_LUNA_CONTEXT_WINDOW = 1_050_000;
export const CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER = 3;

export interface ChatGptWebContextLimits {
  contextWindow: number;
  effectiveContextWindowPercent: number;
  autoCompactTokenLimit: number;
}

export interface ChatGptWebTransportLimits {
  browserMessageTokenLimit?: number;
  browserComposerCharLimit?: number;
}

export function isChatGptWebZeroRiskBackendModel(
  model: string,
): model is ChatGptWebZeroRiskBackendModel {
  return model === CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
    || model === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;
}

function contextLimits(
  contextWindow: number,
  autoCompactTokenLimit: number,
): ChatGptWebContextLimits {
  return {
    contextWindow,
    // Codex reports this effective window in its context indicator. Align it with the practical
    // pre-compaction budget instead of exposing an unreachable underlying model window.
    effectiveContextWindowPercent: Math.round((autoCompactTokenLimit / contextWindow) * 100),
    autoCompactTokenLimit,
  };
}

/** Resolve the product limit for the selected visible ChatGPT mode. */
export function resolveChatGptWebContextLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebContextLimits {
  if (isChatGptWebZeroRiskBackendModel(backendModel)) {
    if (capabilities.experimentalBiggerContext) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    if (backendModel === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL) {
      return contextLimits(
        CHATGPT_WEB_ZERO_RISK_PRO_CONTEXT_WINDOW,
        CHATGPT_WEB_ZERO_RISK_PRO_AUTO_COMPACT_TOKEN_LIMIT,
      );
    }
    return contextLimits(
      CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
      CHATGPT_WEB_ZERO_RISK_AUTO_COMPACT_TOKEN_LIMIT,
    );
  }
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    // Luna carries continuity through a private checkpoint on every completed browser turn. Codex
    // internally clamps this field to 90% of the model window, but the reported active usage is the
    // bounded payload actually sent to ChatGPT and therefore stays far below that threshold.
    return contextLimits(CHATGPT_WEB_LUNA_CONTEXT_WINDOW, CHATGPT_WEB_LUNA_CONTEXT_WINDOW);
  }

  let limits: ChatGptWebContextLimits;
  if (capabilities.proAvailable) {
    const contextWindow = effort === "low"
      ? CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW
      : effort === "max"
        ? CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW
        : CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW;
    limits = contextLimits(contextWindow, CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT);
  } else if (effort === "low") {
    limits = contextLimits(
      CHATGPT_WEB_INSTANT_CONTEXT_WINDOW,
      CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT,
    );
  } else if (effort === "medium" || effort === "high") {
    limits = contextLimits(
      CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW,
      CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT,
    );
  } else {
    throw new Error(`ChatGPT Plus context limit is not defined for unavailable effort: ${effort}`);
  }
  if (!capabilities.experimentalBiggerContext) return limits;
  return contextLimits(
    limits.contextWindow * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
    limits.autoCompactTokenLimit * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  );
}

/** Resolve limits of one visible ChatGPT composer message, independently of model context. */
export function resolveChatGptWebTransportLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebTransportLimits {
  if (isChatGptWebZeroRiskBackendModel(backendModel)) return {};
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) return {};
  if (!capabilities.proAvailable) {
    if (effort === "low") {
      return { browserComposerCharLimit: CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT };
    }
    if (effort === "medium" || effort === "high") {
      return { browserComposerCharLimit: CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT };
    }
    throw new Error(`ChatGPT Plus transport limit is not defined for unavailable effort: ${effort}`);
  }
  if (effort === "low") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT,
    };
  }
  if (effort === "max") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT,
    };
  }
  return {
    browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
    browserComposerCharLimit: CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT,
  };
}

/**
 * Visible text that fits one ordinary input after its hidden reserve and images. This is derived
 * from the existing context contract, not a new measured browser limit or a compaction trigger.
 * Bigger Context expands the transaction, never this per-message budget.
 */
export function isChatGptWebPaidBackendModel(
  model: string,
): model is typeof CHATGPT_WEB_BACKEND_MODEL | typeof CHATGPT_WEB_GPT55_BACKEND_MODEL {
  return model === CHATGPT_WEB_BACKEND_MODEL || model === CHATGPT_WEB_GPT55_BACKEND_MODEL;
}

export function resolveChatGptWebMessageTokenBudget(
  backendModel: typeof CHATGPT_WEB_BACKEND_MODEL | typeof CHATGPT_WEB_GPT55_BACKEND_MODEL,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
  imageTokens = 0,
): number {
  const { contextWindow } = resolveChatGptWebContextLimits(
    backendModel, effort, { ...capabilities, experimentalBiggerContext: false },
  );
  const { browserMessageTokenLimit } = resolveChatGptWebTransportLimits(backendModel, effort, capabilities);
  return Math.max(0, Math.min(
    contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - imageTokens - 1,
    browserMessageTokenLimit ?? Infinity,
  ));
}

interface ChatGptWebModelRouteBase {
  slug: string;
  displayName: string;
  description: string;
  codexEffort: ChatGptWebCodexEffort;
  requiresPro: boolean;
}

export interface ChatGptWebAutomaticModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "automatic";
  backendModel: ChatGptWebAutomaticBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
  /** ChatGPT composer model chip. Latest leaves ChatGPT's auto/latest selection in place. */
  webPin?: ChatGptWebModelPin;
  /** When true, Codex reasoning_effort chooses the ChatGPT effort control instead of the slug. */
  honorRequestEffort?: boolean;
  /** Adapter efforts this pin may use. Pro (`max`) is omitted unless the pin itself supports it. */
  allowedAdapterEfforts?: readonly ChatGptWebAdapterEffort[];
  /** Hide Instant/Deep/Extra/Pro duplicate rows from /v1/models and the Desktop catalog. */
  catalogVisible?: boolean;
  requiresGpt55?: boolean;
  requiresSolPin?: boolean;
}

export interface ChatGptWebZeroRiskModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "manual";
  backendModel: ChatGptWebZeroRiskBackendModel;
  /** Technical protocol value only; Zero Risk must not use it to choose the ChatGPT model. */
  adapterEffort: "low";
}

export type ChatGptWebModelRoute = ChatGptWebAutomaticModelRoute | ChatGptWebZeroRiskModelRoute;

export interface ChatGptWebAccountCapabilities {
  solAvailable: boolean;
  proAvailable: boolean;
  experimentalBiggerContext?: boolean;
  browserInteractionMode?: "automatic" | "manual";
  zeroRiskProEnabled?: boolean;
  /** Proven by scanning ChatGPT model-chip labels during setup/repair. */
  gpt55Available?: boolean;
  /** Proven by scanning ChatGPT model-chip labels during setup/repair. */
  solPinAvailable?: boolean;
}

export const CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE: ChatGptWebZeroRiskModelRoute = {
  slug: "chatgpt-web/zero-risk",
  displayName: "ChatGPT Web — Zero Risk",
  description: "Zero Risk keeps model selection and prompt submission under your control while preserving the native Codex harness.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
};

export const CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE: ChatGptWebZeroRiskModelRoute = {
  slug: "chatgpt-web/zero-risk-pro",
  displayName: "ChatGPT Web — Zero Risk Pro",
  description: "Explicit Pro-sized Zero Risk context; select ChatGPT Pro manually for every turn.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: true,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/luna",
  displayName: "ChatGPT Web — Luna",
  description: "ChatGPT Web Luna for accounts without the Sol model selector.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
};

export const CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE: ChatGptWebModelRoute = {
  slug: "chatgpt-web/think",
  displayName: "ChatGPT Web — Think",
  description: "ChatGPT Web Think for Luna-only accounts.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  // The backend model remains Luna. This internal adapter effort distinguishes the explicit
  // Think route after Codex has selected its separate catalog row.
  adapterEffort: "medium",
  requiresPro: false,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
];

/**
 * Codex Desktop always renders an Effort control next to `display_name`. Keep Instant / Deep /
 * Extra / Pro out of Web titles so the picker shows one row per ChatGPT model pin. Desktop maps
 * the top effort id `pro` to the Pro menu item; do not advertise `max` on chatgpt-web/* rows or
 * the menu shows Maximum instead of Pro. Adapter routing still binds ChatGPT Pro as `max`
 * (Codex protocol `ultra`).
 */
export type ChatGptWebPickerEffort = "low" | "medium" | "high" | "xhigh" | "pro";

export const CHATGPT_WEB_PICKER_REASONING_LEVELS: ReadonlyArray<{
  effort: ChatGptWebPickerEffort;
  description: string;
}> = [
  { effort: "low", description: "Instant" },
  { effort: "medium", description: "Medium" },
  { effort: "high", description: "High" },
  { effort: "xhigh", description: "Extra High" },
  { effort: "pro", description: "Pro" },
];

export function adapterEffortToPickerEffort(
  effort: ChatGptWebAdapterEffort | ChatGptWebCodexEffort,
): ChatGptWebPickerEffort {
  if (effort === "max" || effort === "ultra") return "pro";
  return effort;
}

export function pickerEffortToAdapterEffort(effort: ChatGptWebPickerEffort): ChatGptWebAdapterEffort {
  return effort === "pro" ? "max" : effort;
}

export function chatgptWebPickerDefaultEffort(route: ChatGptWebModelRoute): ChatGptWebPickerEffort {
  return adapterEffortToPickerEffort(route.adapterEffort);
}

export function chatgptWebGpt55Enabled(capabilities: ChatGptWebAccountCapabilities): boolean {
  return capabilities.solAvailable && capabilities.gpt55Available !== false;
}

export function chatgptWebSolPinEnabled(capabilities: ChatGptWebAccountCapabilities): boolean {
  return capabilities.solAvailable && capabilities.solPinAvailable !== false;
}

function automaticRoute(route: ChatGptWebModelRoute): ChatGptWebAutomaticModelRoute | undefined {
  return route.interactionMode === "automatic" ? route : undefined;
}

export function resolveChatGptWebAllowedAdapterEfforts(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): readonly ChatGptWebAdapterEffort[] {
  const automatic = automaticRoute(route);
  const configured = automatic?.allowedAdapterEfforts ?? [route.adapterEffort];
  if (route.interactionMode === "manual") return configured;
  if (automatic?.honorRequestEffort !== true) return configured;
  return configured.filter(effort => (
    (effort !== "xhigh" && effort !== "max") || capabilities.proAvailable
  ));
}

export function resolveChatGptWebCatalogEffort(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebAdapterEffort {
  const allowed = resolveChatGptWebAllowedAdapterEfforts(route, capabilities);
  if (allowed.includes("max")) return "max";
  if (allowed.includes("xhigh")) return "xhigh";
  if (allowed.includes("high")) return "high";
  if (allowed.includes("medium")) return "medium";
  return allowed[0] ?? route.adapterEffort;
}

export function chatgptWebPickerReasoningLevelsForRoute(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): Array<{ effort: ChatGptWebPickerEffort; description: string }> {
  const automatic = automaticRoute(route);
  if (automatic?.honorRequestEffort !== true) {
    return [{
      effort: chatgptWebPickerDefaultEffort(route),
      description: route.displayName,
    }];
  }
  const allowed = new Set(
    resolveChatGptWebAllowedAdapterEfforts(route, capabilities).map(adapterEffortToPickerEffort),
  );
  return CHATGPT_WEB_PICKER_REASONING_LEVELS.filter(level => allowed.has(level.effort));
}

export function resolveChatGptWebRoutedAdapterEffort(
  route: ChatGptWebModelRoute,
  requested: string | undefined,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebAdapterEffort {
  if (route.interactionMode === "manual") return route.codexEffort;
  const automatic = automaticRoute(route)!;
  if (automatic.honorRequestEffort !== true) return automatic.adapterEffort;
  const allowed = resolveChatGptWebAllowedAdapterEfforts(route, capabilities);
  const normalized = requested === "ultra" || requested === "pro" ? "max" : requested;
  if (normalized && (allowed as readonly string[]).includes(normalized)) {
    return normalized as ChatGptWebAdapterEffort;
  }
  if (normalized) {
    throw new Error(`${route.displayName} does not support ${normalized} effort`);
  }
  return automatic.adapterEffort;
}

export const CHATGPT_WEB_LATEST_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/latest",
  displayName: "Web Latest",
  description: "ChatGPT Web latest/auto. Pro effort uses GPT-6 Pro; other efforts fall back to GPT-5.6 Sol.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_BACKEND_MODEL,
  webPin: "latest",
  honorRequestEffort: true,
  allowedAdapterEfforts: ["low", "medium", "high", "xhigh", "max"],
  catalogVisible: true,
  codexEffort: "high",
  adapterEffort: "high",
  requiresPro: false,
};

export const CHATGPT_WEB_SOL_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/sol",
  displayName: "Web GPT-5.6 Sol",
  description: "Pins ChatGPT Web to GPT-5.6 Sol. Effort stays on the Codex effort bar; Pro is omitted because ChatGPT maps Pro to GPT-6 Pro.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_BACKEND_MODEL,
  webPin: "sol",
  honorRequestEffort: true,
  allowedAdapterEfforts: ["low", "medium", "high", "xhigh"],
  catalogVisible: true,
  codexEffort: "medium",
  adapterEffort: "medium",
  requiresPro: false,
  requiresSolPin: true,
};

export const CHATGPT_WEB_GPT55_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/gpt-5.5",
  displayName: "Web GPT-5.5",
  description: "Pins ChatGPT Web to GPT-5.5 when the ChatGPT model menu exposes that chip.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_GPT55_BACKEND_MODEL,
  webPin: "gpt-5.5",
  honorRequestEffort: true,
  allowedAdapterEfforts: ["low", "medium", "high"],
  catalogVisible: true,
  codexEffort: "medium",
  adapterEffort: "medium",
  requiresPro: false,
  requiresGpt55: true,
};

/** Picker-visible Sol-account Web rows. Effort is on the effort bar, not the title. */
export const CHATGPT_WEB_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  CHATGPT_WEB_LATEST_MODEL_ROUTE,
  CHATGPT_WEB_SOL_MODEL_ROUTE,
  CHATGPT_WEB_GPT55_MODEL_ROUTE,
];

/**
 * Legacy Instant/Deep/Extra/Pro slugs remain request-enabled so existing Codex configs keep
 * working. They are omitted from /v1/models and the Desktop catalog.
 */
export const CHATGPT_WEB_LEGACY_EFFORT_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/light",
    displayName: "Web Latest",
    description: "Legacy Instant slug. Prefer chatgpt-web/latest with reasoning.effort=low.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    webPin: "latest",
    catalogVisible: false,
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/medium",
    displayName: "Web Latest",
    description: "Legacy Medium slug. Prefer chatgpt-web/latest with reasoning.effort=medium.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    webPin: "latest",
    catalogVisible: false,
    codexEffort: "medium",
    adapterEffort: "medium",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/high",
    displayName: "Web Latest",
    description: "Legacy High slug. Prefer chatgpt-web/latest with reasoning.effort=high.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    webPin: "latest",
    catalogVisible: false,
    codexEffort: "high",
    adapterEffort: "high",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/extra-high",
    displayName: "Web Latest",
    description: "Legacy Extra High slug. Prefer chatgpt-web/latest with reasoning.effort=xhigh.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    webPin: "latest",
    catalogVisible: false,
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresPro: true,
  },
  {
    slug: "chatgpt-web/pro",
    displayName: "Web Latest",
    description: "Legacy Pro slug. Prefer chatgpt-web/latest with reasoning.effort=pro.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    webPin: "latest",
    catalogVisible: false,
    codexEffort: "ultra",
    adapterEffort: "max",
    requiresPro: true,
  },
];

const ROUTE_ALIASES: ReadonlyArray<readonly [string, ChatGptWebModelRoute]> = [
  ["chatgpt-web/gpt-5.6-sol", CHATGPT_WEB_SOL_MODEL_ROUTE],
  ["chatgpt-web/5.5", CHATGPT_WEB_GPT55_MODEL_ROUTE],
];

const routesBySlug = new Map<string, ChatGptWebModelRoute>([
  [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.slug, CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE],
  [CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE.slug, CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE],
  ...CHATGPT_WEB_LUNA_MODEL_ROUTES.map(route => [route.slug, route] as const),
  ...CHATGPT_WEB_MODEL_ROUTES.map(route => [route.slug, route] as const),
  ...CHATGPT_WEB_LEGACY_EFFORT_ROUTES.map(route => [route.slug, route] as const),
  ...ROUTE_ALIASES,
]);

export function isChatGptWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

export function availableChatGptWebModelRoutes(
  capabilities: ChatGptWebAccountCapabilities,
): readonly ChatGptWebModelRoute[] {
  if (capabilities.browserInteractionMode === "manual") {
    if (capabilities.experimentalBiggerContext) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    return capabilities.zeroRiskProEnabled
      ? [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE]
      : [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE];
  }
  if (!capabilities.solAvailable) return CHATGPT_WEB_LUNA_MODEL_ROUTES;
  const routes: ChatGptWebModelRoute[] = [CHATGPT_WEB_LATEST_MODEL_ROUTE];
  if (chatgptWebSolPinEnabled(capabilities)) routes.push(CHATGPT_WEB_SOL_MODEL_ROUTE);
  if (chatgptWebGpt55Enabled(capabilities)) routes.push(CHATGPT_WEB_GPT55_MODEL_ROUTE);
  return routes;
}

export function requireChatGptWebModelRoute(
  modelId: string,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebModelRoute {
  if (capabilities.browserInteractionMode === "manual" && capabilities.experimentalBiggerContext) {
    throw new Error("Zero Risk does not support Bigger Context");
  }
  const route = routesBySlug.get(modelId);
  if (!route) throw new Error(`ChatGPT web model is not enabled: ${modelId}`);
  if (capabilities.browserInteractionMode === "manual") {
    if (route.interactionMode !== "manual") {
      throw new Error(`${route.displayName} is not available while Zero Risk is enabled`);
    }
    if (route === CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE && !capabilities.zeroRiskProEnabled) {
      throw new Error(`${route.displayName} is not enabled in Zero Risk model settings`);
    }
    return route;
  }
  if (route.interactionMode === "manual") {
    throw new Error(`${route.displayName} is only available while Zero Risk is enabled`);
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    if (capabilities.solAvailable) {
      throw new Error(`${route.displayName} is only available for Luna-only accounts`);
    }
    return route;
  }
  if (!capabilities.solAvailable) {
    throw new Error(`${route.displayName} is not available for this Luna-only account`);
  }
  if (route.requiresPro && !capabilities.proAvailable) {
    throw new Error(`${route.displayName} is not available for this account`);
  }
  if (route.requiresSolPin && !chatgptWebSolPinEnabled(capabilities)) {
    throw new Error(`${route.displayName} is not available because ChatGPT did not expose a GPT-5.6 Sol model chip`);
  }
  if (route.requiresGpt55 && !chatgptWebGpt55Enabled(capabilities)) {
    throw new Error(`${route.displayName} is not available because ChatGPT did not expose a GPT-5.5 model chip`);
  }
  return route;
}
