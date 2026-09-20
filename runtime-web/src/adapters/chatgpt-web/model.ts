import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_GPT55_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  type ChatGptWebModelPin,
} from "../../chatgpt-web-models";

export const CHATGPT_WEB_MODEL_ID = CHATGPT_WEB_BACKEND_MODEL;
export const CHATGPT_WEB_LUNA_MODEL_ID = CHATGPT_WEB_LUNA_BACKEND_MODEL;
export const CHATGPT_WEB_GPT55_MODEL_ID = CHATGPT_WEB_GPT55_BACKEND_MODEL;

export interface ChatGptWebCapabilities {
  localToolsEnabled: boolean;
  solAvailable: boolean;
  proAvailable: boolean;
  gpt55Available?: boolean;
  solPinAvailable?: boolean;
}

export interface ChatGptWebModelMode {
  modelId: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  displayLabel: "Luna" | "Think" | "Instant" | "Medium" | "High" | "Extra High" | "Pro";
  uiEffortIndex: 0 | 1 | 2 | 3 | 4 | null;
  thinkEnabled: boolean;
  localTools: boolean;
  webPin: ChatGptWebModelPin | undefined;
}

function solFamilyMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
  webPin: ChatGptWebModelPin | undefined,
  defaultEffort: "medium" | "high",
): ChatGptWebModelMode {
  if (!capabilities.solAvailable) {
    throw new Error("ChatGPT Sol modes are not available for this Luna-only account");
  }
  const effort = reasoning ?? defaultEffort;
  const pin = webPin ?? (modelId === CHATGPT_WEB_GPT55_MODEL_ID ? "gpt-5.5" : "latest");
  const allowExtraHigh = pin !== "gpt-5.5";
  const allowPro = pin === "latest";
  switch (effort) {
    case "low":
      return { modelId, effort, displayLabel: "Instant", uiEffortIndex: 0, thinkEnabled: false, localTools: capabilities.localToolsEnabled, webPin: pin };
    case "medium":
      return { modelId, effort, displayLabel: "Medium", uiEffortIndex: 1, thinkEnabled: false, localTools: capabilities.localToolsEnabled, webPin: pin };
    case "high":
      return { modelId, effort, displayLabel: "High", uiEffortIndex: 2, thinkEnabled: false, localTools: capabilities.localToolsEnabled, webPin: pin };
    case "xhigh":
      if (!allowExtraHigh) {
        throw new Error("ChatGPT Extra High effort is not available on the GPT-5.5 pin");
      }
      if (!capabilities.proAvailable) throw new Error("ChatGPT Extra High effort is not available for this account");
      return { modelId, effort, displayLabel: "Extra High", uiEffortIndex: 3, thinkEnabled: false, localTools: capabilities.localToolsEnabled, webPin: pin };
    case "max":
      if (!allowPro) {
        throw new Error(
          pin === "sol"
            ? "ChatGPT Pro effort is not available on the GPT-5.6 Sol pin; use Web Latest"
            : "ChatGPT Pro effort is not available on the GPT-5.5 pin; use Web Latest",
        );
      }
      if (!capabilities.proAvailable) throw new Error("ChatGPT Pro effort is not available for this account");
      return { modelId, effort, displayLabel: "Pro", uiEffortIndex: 4, thinkEnabled: false, localTools: capabilities.localToolsEnabled, webPin: pin };
    default:
      throw new Error(`ChatGPT web effort is not supported: ${effort}`);
  }
}

export function resolveChatGptWebModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
  webPin?: ChatGptWebModelPin,
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
      webPin: undefined,
    };
  }
  if (modelId === CHATGPT_WEB_GPT55_MODEL_ID) {
    return solFamilyMode(modelId, reasoning, capabilities, webPin ?? "gpt-5.5", "medium");
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT web model is not supported: ${modelId}`);
  }
  return solFamilyMode(modelId, reasoning, capabilities, webPin, "high");
}
