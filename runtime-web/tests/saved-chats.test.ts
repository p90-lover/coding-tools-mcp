import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptBrowserWorker,
  chatGptTemporaryChatConnectorRefusalError,
  chatGptTemporaryChatRefusesConnector,
  resolveBrowserConfig,
} from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import {
  assertNewChatPage,
  CHATGPT_COMPOSER_SELECTOR,
  chatGptNewChatUrl,
  chatGptRetainedConversationPage,
  chatGptSavedConversationPath,
} from "../src/chatgpt-session";

const SAVED_CONVERSATION = "https://chatgpt.com/c/0f8e2a5c-6b1d-4c3e-9a7b-1d2e3f4a5b6c";

const pageAt = (url: string) => ({ url: () => url }) as never;

test("new chat URLs and the new-chat assertion follow the chat mode exactly", async () => {
  expect(chatGptNewChatUrl(true)).toBe("https://chatgpt.com/");
  expect(chatGptNewChatUrl(false)).toBe("https://chatgpt.com/?temporary-chat=true");

  await assertNewChatPage(pageAt("https://chatgpt.com/"), true);
  await assertNewChatPage(pageAt("https://chatgpt.com/?temporary-chat=true"), false);
  for (const [url, saved] of [
    // The other mode's home is not this mode's empty new chat.
    ["https://chatgpt.com/?temporary-chat=true", true],
    ["https://chatgpt.com/", false],
    // Any flag value, even false, is present and therefore not a saved new chat.
    ["https://chatgpt.com/?temporary-chat=false", true],
    ["https://chatgpt.com/?temporary-chat=false", false],
    // An existing conversation is never a new chat, in either mode.
    [SAVED_CONVERSATION, true],
    [`${SAVED_CONVERSATION}?temporary-chat=true`, false],
    // Exact origin only.
    ["https://chat.openai.com/", true],
    ["http://chatgpt.com/", true],
    ["https://chatgpt.com.evil.test/?temporary-chat=true", false],
  ] as const) {
    await expect(assertNewChatPage(pageAt(url), saved)).rejects.toThrow("left the new");
  }
});

test("a retained turn types only into its own kind of conversation page", () => {
  expect(chatGptSavedConversationPath(SAVED_CONVERSATION)).toBe(new URL(SAVED_CONVERSATION).pathname);
  expect(chatGptSavedConversationPath("https://chatgpt.com/c/not-a-uuid")).toBeUndefined();
  expect(chatGptSavedConversationPath("https://chatgpt.com/g/g-abc/c/0f8e2a5c-6b1d-4c3e-9a7b-1d2e3f4a5b6c")).toBeUndefined();

  expect(chatGptRetainedConversationPage(SAVED_CONVERSATION, true)).toBeTrue();
  // A saved task chat that now shows the history home, a project, or a Temporary Chat has moved.
  expect(chatGptRetainedConversationPage("https://chatgpt.com/", true)).toBeFalse();
  expect(chatGptRetainedConversationPage(`${SAVED_CONVERSATION}?temporary-chat=true`, true)).toBeFalse();
  expect(chatGptRetainedConversationPage("https://chatgpt.com/c/short", true)).toBeFalse();
  // A Temporary Chat page that lost its flag now shows one of the user's saved chats.
  expect(chatGptRetainedConversationPage("https://chatgpt.com/?temporary-chat=true", false)).toBeTrue();
  expect(chatGptRetainedConversationPage(`${SAVED_CONVERSATION}?temporary-chat=true`, false)).toBeTrue();
  expect(chatGptRetainedConversationPage(SAVED_CONVERSATION, false)).toBeFalse();
  expect(chatGptRetainedConversationPage("not a url", true)).toBeFalse();
});

test("worker config defaults to saved chats and keeps an explicit Temporary Chat choice", () => {
  const base = { adapter: "chatgpt-web" as const, baseUrl: "https://chatgpt.com" };
  expect(resolveBrowserConfig({ ...base, chatgptWeb: {} }).useSavedChats).toBeTrue();
  expect(resolveBrowserConfig({ ...base, chatgptWeb: { useSavedChats: true } }).useSavedChats).toBeTrue();
  expect(resolveBrowserConfig({ ...base, chatgptWeb: { useSavedChats: false } }).useSavedChats).toBeFalse();
});

function chatSurfacePage(initialUrl: string, onboardingVisible = true) {
  let url = initialUrl;
  const navigations: string[] = [];
  let onboardingClicks = 0;
  const composer = { count: async () => 1, nth: () => composer, isVisible: async () => true };
  const button = {
    last: () => button,
    isVisible: async () => true,
    click: async () => { onboardingClicks += 1; },
  };
  const dialog = {
    filter: () => dialog,
    last: () => dialog,
    isVisible: async () => onboardingVisible,
    getByRole: () => button,
    waitFor: async () => {},
  };
  const hidden = { filter: () => hidden, last: () => hidden, isVisible: async () => false };
  const page = {
    url: () => url,
    goto: async (next: string) => { url = next; navigations.push(next); },
    locator: (selector: string) => selector === CHATGPT_COMPOSER_SELECTOR
      ? composer
      : selector === '[role="dialog"]' ? dialog : hidden,
  };
  return { page, composer, navigations, onboardingClicks: () => onboardingClicks };
}

for (const saved of [false, true]) test(`chat surface preparation opens the ${saved ? "saved" : "Temporary"} new chat`, async () => {
  const prepare = (ChatGptBrowserWorker.prototype as unknown as {
    prepareChatSurface(page: unknown, capture: unknown, useSavedChats: boolean): Promise<unknown>;
  }).prepareChatSurface;
  const fixture = chatSurfacePage(SAVED_CONVERSATION);
  const checkpoints: string[] = [];
  await expect(prepare.call(
    { activeComposer: async () => fixture.composer },
    fixture.page,
    async (checkpoint: string) => { checkpoints.push(checkpoint); },
    saved,
  )).resolves.toBe(fixture.composer);
  // A previous conversation is never reused: the surface always starts on an empty new chat.
  expect(fixture.navigations).toEqual([chatGptNewChatUrl(saved)]);
  // The Temporary Chat onboarding dialog is dismissed only where it belongs.
  expect(fixture.onboardingClicks()).toBe(saved ? 0 : 1);
  expect(checkpoints).toContain(saved ? "saved-chat-navigation-complete" : "temporary-chat-navigation-complete");
  expect(checkpoints.includes("temporary-chat-onboarding-dismissed")).toBe(!saved);
});

test("chat surface preparation does not re-navigate an already fresh document", async () => {
  const prepare = (ChatGptBrowserWorker.prototype as unknown as {
    prepareChatSurface(page: unknown, capture: unknown, useSavedChats: boolean): Promise<unknown>;
  }).prepareChatSurface;
  const fixture = chatSurfacePage("https://chatgpt.com/", false);
  await prepare.call({ activeComposer: async () => fixture.composer }, fixture.page, undefined, true);
  expect(fixture.navigations).toEqual([]);
});

test("ChatGPT's Temporary Chat connector refusal becomes an actionable error", async () => {
  const pageWith = (visible: number) => ({
    getByText: (pattern: RegExp) => {
      expect(pattern.test("Coding Tools Native2 is unavailable in this temporary chat")).toBeTrue();
      expect(pattern.test("Coding Tools Native2 is unavailable right now")).toBeFalse();
      return { filter: () => ({ count: async () => visible }) };
    },
  }) as never;
  expect(await chatGptTemporaryChatRefusesConnector(pageWith(1))).toBeTrue();
  expect(await chatGptTemporaryChatRefusesConnector(pageWith(0))).toBeFalse();
  // A broken probe is not evidence of a refusal.
  expect(await chatGptTemporaryChatRefusesConnector({ getByText: () => { throw new Error("detached"); } } as never)).toBeFalse();

  const error = chatGptTemporaryChatConnectorRefusalError("Coding Tools Native2");
  expect(error).toMatchObject({ code: "connector_not_found", retryable: false });
  expect(error.message).toContain('"Save chats in ChatGPT"');
  expect(error.message).toContain("--saved-chats");
});

test("a refused mention fails at once instead of waiting out every trigger attempt", async () => {
  const timeout = new Error("menu absent");
  timeout.name = "TimeoutError";
  let attempts = 0;
  const composer = { fill: async () => {}, focus: async () => {}, pressSequentially: async () => {} };
  const page = {
    // Saved-chat URL: no personalization preflight, straight to the mention.
    url: () => "https://chatgpt.com/",
    getByText: (value: unknown) => value instanceof RegExp
      ? { filter: () => ({ count: async () => 1 }) }
      : ({ exactConnectorLabel: true }),
    locator: () => ({ filter: () => ({ waitFor: async () => { attempts += 1; throw timeout; } }) }),
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: (checkpoint: string) => Promise<void>): Promise<unknown>;
  }).selectConnector;
  const checkpoints: string[] = [];
  await expect(selectConnector.call({
    config: { appName: "Coding Tools Native2" },
    activeComposer: async () => composer,
    connectorIsSelected: async () => false,
    clearChatGptComposerState: async () => { checkpoints.push("cleared"); },
  }, page, async checkpoint => { checkpoints.push(checkpoint); })).rejects.toThrow("Save chats in ChatGPT");
  expect(attempts).toBe(1);
  expect(checkpoints).toContain("connector-temporary-chat-refused");
  // The typed mention is still cleaned up before the error leaves.
  expect(checkpoints.at(-1)).toBe("cleared");
});

function retainedTurnWorker(useSavedChats: boolean, diagnostics: string) {
  const actions: string[] = [];
  const reached = new Error("fixture reached effort selection");
  const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Coding Tools Native2", browserDiagnosticsPath: diagnostics, useSavedChats },
    runStage: async (_trace: string, _name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => (
      action(new AbortController().signal)
    ),
    prepareChatSurface: async () => { actions.push("prepare"); },
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => {
      actions.push("effort");
      resolveChatGptWebModelMode(model, effort, capabilities);
      throw reached;
    },
    attachPrompt: async () => { actions.push("type"); },
    attachPromptWithCompactionRetry: async () => { actions.push("type"); },
  });
  const turn = {
    traceId: "retained_conversation_fixture",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities,
    prepare: async () => { throw new Error("a retained turn uses its continuation prompt"); },
    prepareResume: async () => ({ text: "Continue", images: [], release: () => {} }),
  };
  return { worker, turn, actions, reached };
}

for (const [useSavedChats, url, reusable] of [
  [true, SAVED_CONVERSATION, true],
  // The user opened their own history in the retained tab: never type there.
  [true, "https://chatgpt.com/c/11111111-2222-4333-8444-555555555555?temporary-chat=true", false],
  [true, "https://chatgpt.com/", false],
  [false, `${SAVED_CONVERSATION}?temporary-chat=true`, true],
  [false, SAVED_CONVERSATION, false],
] as const) test(`a retained ${useSavedChats ? "saved" : "temporary"} turn checks its page before typing (${url})`, async () => {
  const diagnostics = mkdtempSync(join(tmpdir(), "retained-conversation-"));
  const { worker, turn, actions, reached } = retainedTurnWorker(useSavedChats, diagnostics);
  const page = { url: () => url, evaluate: async () => ({}), isClosed: () => false };
  try {
    const result = worker.runBrowserTurn(turn, undefined, page, true);
    if (reusable) {
      await expect(result).rejects.toBe(reached);
      expect(actions).toEqual(["effort"]);
    } else {
      await expect(result).rejects.toThrow("The retained ChatGPT conversation is no longer available");
      expect(actions).toEqual([]);
    }
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});

test("the smoke turn stays in Temporary Chat even when task chats are saved", async () => {
  const diagnostics = mkdtempSync(join(tmpdir(), "smoke-temporary-"));
  const { worker, turn, reached } = retainedTurnWorker(true, diagnostics);
  const modes: boolean[] = [];
  worker.prepareChatSurface = async (_page: unknown, _capture: unknown, saved: boolean) => { modes.push(saved); };
  const page = { url: () => "https://chatgpt.com/?temporary-chat=true", evaluate: async () => ({}), isClosed: () => false };
  try {
    const fresh = { ...turn, prepare: turn.prepareResume };
    await expect(worker.runBrowserTurn({ ...fresh, temporaryChat: true }, undefined, page)).rejects.toBe(reached);
    await expect(worker.runBrowserTurn(fresh, undefined, page)).rejects.toBe(reached);
    expect(modes).toEqual([false, true]);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});
