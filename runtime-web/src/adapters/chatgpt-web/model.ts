import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  CHATGPT_WEB_MODEL_ROUTES,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

export const CHATGPT_WEB_MODEL_ID = CHATGPT_WEB_BACKEND_MODEL;
export const CHATGPT_WEB_LUNA_MODEL_ID = CHATGPT_WEB_LUNA_BACKEND_MODEL;

export interface ChatGptWebCapabilities {
  localToolsEnabled: boolean;
  solAvailable: boolean;
  proAvailable: boolean;
}

/** The launcher's current account is not authoritative for a native thread's bound account. */
export function resolveChatGptWebTurnCapabilities(
  parsed: CodexParsedRequest,
  configured: ChatGptWebCapabilities,
  browser: CodexProviderConfig["chatgptWeb"],
): ChatGptWebCapabilities {
  const identity = extractChatGptTurnIdentity(parsed);
  if (browser?.browserHost !== "launcher" || !browser.browserHostDescriptorPath?.trim()
    || browser.browserInteractionMode === "manual"
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity.threadId ?? "")) return configured;
  const luna = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID || CHATGPT_WEB_LUNA_MODEL_ROUTES.some(route => route.slug === parsed.modelId);
  const sol = parsed.modelId === CHATGPT_WEB_MODEL_ID || CHATGPT_WEB_MODEL_ROUTES.some(route => route.slug === parsed.modelId);
  if (!luna && !sol) return configured;
  const upperTier = parsed.modelId === "chatgpt-web/extra-high" || parsed.modelId === "chatgpt-web/pro"
    || (parsed.modelId === CHATGPT_WEB_MODEL_ID && (parsed.options.reasoning === "xhigh" || parsed.options.reasoning === "max"));
  // Preserve the requested family and tier; its owned page still proves the exact model and stop.
  return { ...configured, solAvailable: sol, proAvailable: sol && (configured.proAvailable || upperTier) };
}

export interface ChatGptWebModelMode {
  modelId: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  displayLabel: "Luna" | "Think" | "Instant" | "Medium" | "High" | "Extra High" | "Pro";
  uiEffortIndex: 0 | 1 | 2 | 3 | 4 | null;
  thinkEnabled: boolean;
  localTools: boolean;
}

export function resolveChatGptWebModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    if (capabilities.solAvailable) {
      throw new Error("ChatGPT Luna is not available while the account exposes the Sol model selector");
    }
    const effort = reasoning ?? "low";
    if (effort !== "low" && effort !== "medium") {
      throw new Error(`ChatGPT Luna mode is not supported: ${effort}`);
    }
    const thinkEnabled = effort === "medium";
    return {
      modelId,
      effort,
      displayLabel: thinkEnabled ? "Think" : "Luna",
      uiEffortIndex: null,
      thinkEnabled,
      localTools: capabilities.localToolsEnabled,
    };
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT web model is not supported: ${modelId}`);
  }
  if (!capabilities.solAvailable) {
    throw new Error("ChatGPT Sol modes are not available for this Luna-only account");
  }
  const effort = reasoning ?? "high";
  switch (effort) {
    case "low":
      return { modelId, effort, displayLabel: "Instant", uiEffortIndex: 0, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "medium":
      return { modelId, effort, displayLabel: "Medium", uiEffortIndex: 1, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "high":
      return { modelId, effort, displayLabel: "High", uiEffortIndex: 2, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "xhigh":
      if (!capabilities.proAvailable) throw new Error("ChatGPT Extra High effort is not available for this account");
      return { modelId, effort, displayLabel: "Extra High", uiEffortIndex: 3, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "max":
      if (!capabilities.proAvailable) throw new Error("ChatGPT Pro effort is not available for this account");
      return { modelId, effort, displayLabel: "Pro", uiEffortIndex: 4, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    default:
      throw new Error(`ChatGPT web effort is not supported: ${effort}`);
  }
}
