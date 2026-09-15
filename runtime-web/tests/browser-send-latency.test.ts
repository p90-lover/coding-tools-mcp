import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import type { CodexProviderConfig } from "../src/types";

test("an already-enabled ChatGPT send control has no unconditional settle delay", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://send-latency-${Date.now()}-${Math.random()}`,
    chatgptWeb: {
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      storageStatePath: `/tmp/send-latency-${Date.now()}-${Math.random()}.json`,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as {
    activeComposer(page: Page): Promise<unknown>;
    waitForSubmissionAcceptedWithRecovery(): Promise<string>;
    sendAttachedPrompt(
      page: Page,
      baseline: unknown,
      capture?: (checkpoint: string) => Promise<void>,
      signal?: AbortSignal,
    ): Promise<string>;
  };
  const hiddenLocator = {
    filter() { return this; },
    last() { return this; },
    getByText() { return this; },
    isVisible: async () => false,
  };
  const page = {
    isClosed: () => false,
    locator: () => hiddenLocator,
  } as unknown as Page;
  let enabledChecks = 0;
  const sendButton = {
    waitFor: async () => {},
    isEnabled: async () => {
      enabledChecks += 1;
      return true;
    },
    press: async () => {},
  };
  worker.activeComposer = async () => ({
    locator: () => ({ getByTestId: () => sendButton }),
  });
  worker.waitForSubmissionAcceptedWithRecovery = async () => "user_turn";

  const startedAt = performance.now();
  await expect(worker.sendAttachedPrompt(page, {})).resolves.toBe("user_turn");
  const elapsedMs = performance.now() - startedAt;

  expect(enabledChecks).toBe(1);
  // The fake page performs no I/O. Crossing this bound means the send path inserted a fixed wait.
  expect(elapsedMs).toBeLessThan(200);
});
