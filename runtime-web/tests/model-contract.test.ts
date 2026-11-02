import { expect, test } from "bun:test";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, resolveChatGptWebTurnCapabilities } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

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
