import { expect, test } from "bun:test";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, resolveChatGptWebTurnCapabilities } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";
import { defaultConfig } from "../src/config";
import { routeChatGptWebRequest } from "../src/server";
import { requireChatGptWebModelRoute, resolveChatGptWebContextLimits, resolveChatGptWebMessageTokenBudget, resolveChatGptWebStagingTokenBudget } from "../src/chatgpt-web-models";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateTokens } from "../src/lib/token-estimate";
import { resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { augmentNativeModelCatalog } from "../src/model-catalog";

test.each([
  ["chatgpt-web/extra-high", "low", false, "xhigh"],
  ["chatgpt-web/gpt-6-sol", "xhigh", false, "xhigh"],
  ["chatgpt-web/gpt-6-sol", "xhigh", true, "xhigh"],
  ["chatgpt-web/pro", "low", false, "max"],
  ["chatgpt-web/gpt-6-pro", "max", true, "max"],
  ["chatgpt-web/high", "low", true, "high"],
] as const)("owned native %s admits its exact effort without borrowing the panel's Pro budget", (model, reasoning, globalPro, effort) => {
  const config = { ...defaultConfig("browser-only"), browserHost: "launcher" as const,
    browserHostDescriptorPath: "G:/fixture/launcher.json", extraHighAvailable: true, proAvailable: globalPro };
  const parsed: CodexParsedRequest = { modelId: model, stream: false,
    context: { messages: [{ role: "user", content: "Verify this task without repeating completed work.", timestamp: 1 }] },
    options: { reasoning }, _rawBody: { client_metadata: { "x-codex-turn-metadata": {
      thread_id: "01a06c66-0000-7ae1-9108-69b5f70e0671", turn_id: "01a06c66-0000-7ae1-9108-69b5f70e0672",
    } } } };
  const route = routeChatGptWebRequest(parsed, config);
  const capabilities = resolveChatGptWebTurnCapabilities(parsed, {
    localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: globalPro,
  }, config);
  expect(route.adapterEffort).toBe(effort);
  expect(capabilities.proAvailable).toBeFalse();
  expect(resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities))
    .toMatchObject({ effort, localTools: false });
  expect(resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, capabilities, parsed._chatgptModelFamily))
    .toMatchObject({ contextWindow: 90_000, autoCompactTokenLimit: 68_085 });
  expect(resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_MODEL_ID, effort, capabilities)).toBe(81_807);
  expect(resolveChatGptWebStagingTokenBudget(CHATGPT_WEB_MODEL_ID, "low", capabilities)).toBe(23_807);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: 2 });
  const stages = compiledChatGptWebMessages(compiled).slice(0, -1);
  expect(resolveChatGptWebMultipartStagingMode(parsed.modelId, capabilities,
    Math.max(...stages.map(text => estimateTokens(text))), Math.max(...stages.map(text => text.length))).effort).toBe("low");
});

test("shared native launcher catalog keeps model identities while advertising the unknown account's conservative budget", () => {
  const config = { ...defaultConfig("full"), browserHost: "launcher" as const,
    browserHostDescriptorPath: "G:/fixture/launcher.json", extraHighAvailable: true, proAvailable: true };
  const native = { models: [{ slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, tool_mode: "code_mode_only",
    supported_reasoning_levels: [{ effort: "high", description: "High" }] }] };
  const models = augmentNativeModelCatalog(native, config).models as Array<Record<string, unknown>>;
  for (const slug of ["chatgpt-web/gpt-6-sol", "chatgpt-web/gpt-6-pro", "chatgpt-web/pro"]) {
    expect(models.find(model => model.slug === slug)).toMatchObject({ context_window: 90_000, auto_compact_token_limit: 68_085 });
  }
  expect(models.find(model => model.slug === "chatgpt-web/gpt-6-pro")).toMatchObject({
    default_reasoning_level: "max", supported_reasoning_levels: [{ effort: "max", description: "GPT-6 Pro (Web)" }],
  });
  const managed = augmentNativeModelCatalog(native, { ...config, browserHost: "managed-chrome" }).models as Array<Record<string, unknown>>;
  expect(managed.find(model => model.slug === "chatgpt-web/gpt-6-pro"))
    .toMatchObject({ context_window: 112_193, auto_compact_token_limit: 81_059 });
  const bigger = augmentNativeModelCatalog(native, { ...config, experimentalBiggerContext: true }).models as Array<Record<string, unknown>>;
  expect(bigger.find(model => model.slug === "chatgpt-web/gpt-6-sol"))
    .toMatchObject({ context_window: 120_000, auto_compact_token_limit: 93_840 });
  expect(bigger.find(model => model.slug === "chatgpt-web/gpt-6-pro"))
    .toMatchObject({ context_window: 270_000, auto_compact_token_limit: 204_255 });
});

test("conservative upper-tier estimates never admit an unavailable managed or manual model", () => {
  const configured = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const parsed: CodexParsedRequest = { modelId: CHATGPT_WEB_MODEL_ID, stream: false,
    context: { messages: [] }, options: { reasoning: "max" },
    _rawBody: { client_metadata: { "x-codex-turn-metadata": { thread_id: "01a06c66-0000-7ae1-9108-69b5f70e0671" } } } };
  for (const browser of [{ browserHost: "managed-chrome" as const },
    { browserHost: "launcher" as const, browserHostDescriptorPath: "G:/fixture/launcher.json", browserInteractionMode: "manual" as const }]) {
    const capabilities = resolveChatGptWebTurnCapabilities(parsed, configured, browser);
    expect(capabilities).toBe(configured);
    expect(resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_MODEL_ID, "max", capabilities)).toBe(81_807);
    expect(() => resolveChatGptWebModelMode(parsed.modelId, "max", capabilities)).toThrow("Pro effort is not available");
    expect(() => compileChatGptWebPrompt(parsed, capabilities)).toThrow("Pro effort is not available");
  }
});

test("named families reject unavailable tiers instead of substituting another model", () => {
  const plus = { solAvailable: true, extraHighAvailable: false, proAvailable: false };
  for (const family of ["5.6", "6"]) {
    expect(() => requireChatGptWebModelRoute(`chatgpt-web/gpt-${family}-pro`, plus, "max")).toThrow();
    expect(() => requireChatGptWebModelRoute(`chatgpt-web/gpt-${family}-sol`, plus, "xhigh")).toThrow();
    expect(() => requireChatGptWebModelRoute(`chatgpt-web/gpt-${family}-sol`, { ...plus, solAvailable: false }, "high")).toThrow();
  }
  expect(requireChatGptWebModelRoute("chatgpt-web/pro", plus).slug).toBe("chatgpt-web/high");
});

test("legacy Pro capability admits both upper efforts without conflating Extra High with Pro", () => {
  const configured = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: true };
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", configured).effort).toBe("xhigh");
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", configured).effort).toBe("max");
  expect(requireChatGptWebModelRoute("chatgpt-web/gpt-6-sol", configured, "xhigh").adapterEffort).toBe("xhigh");
});

test("a persisted-looking admission flag cannot bypass managed account route checks", () => {
  const config = { ...defaultConfig("browser-only"), browserHost: "managed-chrome" as const,
    proAvailable: false, extraHighAvailable: false, deferUpperTierAdmission: true };
  const parsed: CodexParsedRequest = { modelId: "chatgpt-web/gpt-6-pro", stream: false,
    context: { messages: [] }, options: { reasoning: "max" } };
  expect(() => routeChatGptWebRequest(parsed, config)).toThrow();
});

test("the browser adapter maps fixed routed efforts to the visible ChatGPT modes", () => {
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities)).toMatchObject({
    displayLabel: "Instant",
    uiEffortIndex: 0,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "medium", capabilities)).toMatchObject({
    uiEffortIndex: 1,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", capabilities)).toMatchObject({
    uiEffortIndex: 2,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", capabilities)).toMatchObject({
    uiEffortIndex: 3,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", capabilities)).toMatchObject({
    uiEffortIndex: 4,
    localTools: true,
  });
});

test("capabilities gate tools and Pro-only efforts explicitly without changing the selected model", () => {
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  })).toMatchObject({ localTools: false });
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
  })).toThrow("Pro effort is not available");
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", {
    localToolsEnabled: true,
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
  })).toThrow("Extra High effort is not available");
  expect(() => resolveChatGptWebModelMode("unknown", "high", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  })).toThrow("model is not supported");
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "turbo", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  })).toThrow("effort is not supported");
});

test("only an owned native launcher thread defers the current account's capability gates", () => {
  const configured = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const browser = { browserHost: "launcher" as const, browserHostDescriptorPath: "G:/fixture/launcher.json" };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID, stream: false, context: { messages: [] }, options: { reasoning: "xhigh" },
    _rawBody: { client_metadata: { "x-codex-turn-metadata": { thread_id: "01a06c66-0000-7ae1-9108-69b5f70e0671" } } },
  };
  const capabilities = resolveChatGptWebTurnCapabilities(parsed, configured, browser);
  expect(resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities))
    .toMatchObject({ effort: "xhigh", localTools: false });
  expect(configured.proAvailable).toBeFalse();
  for (const context of [undefined, { browserHost: "managed-chrome" as const },
    { ...browser, browserHostDescriptorPath: " " }, { ...browser, browserInteractionMode: "manual" as const }]) {
    expect(resolveChatGptWebTurnCapabilities(parsed, configured, context)).toBe(configured);
  }
  for (const threadId of [undefined, "", "dev_thread_example", "not-a-thread", 42]) {
    const legacy = { ...parsed, _rawBody: { client_metadata: { "x-codex-turn-metadata": { thread_id: threadId } } } };
    expect(resolveChatGptWebTurnCapabilities(legacy, configured, browser)).toBe(configured);
  }
  const unknown = { ...parsed, modelId: "unknown" };
  expect(resolveChatGptWebTurnCapabilities(unknown, configured, browser)).toBe(configured);
  expect(() => resolveChatGptWebModelMode(unknown.modelId, "xhigh", capabilities)).toThrow("model is not supported");
  const high = { ...parsed, options: { reasoning: "high" } };
  expect(resolveChatGptWebTurnCapabilities(high, configured, browser)).toEqual(configured);
  const luna = { ...parsed, modelId: CHATGPT_WEB_LUNA_MODEL_ID, options: { reasoning: "medium" } };
  expect(resolveChatGptWebModelMode(luna.modelId, luna.options.reasoning, resolveChatGptWebTurnCapabilities(luna, configured, browser)))
    .toMatchObject({ effort: "medium", displayLabel: "Think", localTools: false });
});

test("Luna-only capability binds the default model without a UI effort selector", () => {
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "low", {
    localToolsEnabled: true,
    solAvailable: false,
    extraHighAvailable: false, proAvailable: false,
  })).toEqual({
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    effort: "low",
    displayLabel: "Luna",
    uiEffortIndex: null,
    thinkEnabled: false,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "medium", {
    localToolsEnabled: true,
    solAvailable: false,
    extraHighAvailable: false, proAvailable: false,
  })).toEqual({
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    effort: "medium",
    displayLabel: "Think",
    uiEffortIndex: null,
    thinkEnabled: true,
    localTools: true,
  });
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", {
    localToolsEnabled: false,
    solAvailable: false,
    extraHighAvailable: false, proAvailable: false,
  })).toThrow("Luna-only account");
});
