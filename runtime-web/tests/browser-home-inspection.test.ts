import { expect, spyOn, test } from "bun:test";
import * as session from "../src/chatgpt-session";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

const HOME = "https://chatgpt.com/";
const TEMPORARY = "https://chatgpt.com/?temporary-chat=true";
const methods = ChatGptBrowserWorker.prototype as unknown as {
  inspectSessionExclusive(this: object, detectCapabilities: boolean): Promise<{
    authenticated: boolean; newChat: boolean; url: string; solAvailable?: boolean;
  }>;
  prepareChatSurface(this: object, page: object): Promise<unknown>;
  smokeTestExclusive(this: object): Promise<unknown>;
};

for (const useSavedChats of [false, true]) {
  for (const detectCapabilities of [false, true]) {
    for (const initial of [HOME, TEMPORARY]) {
      test(`account inspection leaves normal home: tasks saved=${useSavedChats}, capabilities=${detectCapabilities}, initial=${initial}`, async () => {
        let url = initial;
        const page = { url: () => url };
        const calls: unknown[][] = [];
        const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: false };
        const detect = spyOn(session, "detectChatGptAccountCapabilities")
          .mockImplementation(async () => capabilities as never);
        const worker = {
          config: { useSavedChats },
          ensurePage: async () => page,
          prepareChatSurface: async (actual: object, diagnostic: unknown, saved: boolean) => {
            expect(actual).toBe(page);
            expect(diagnostic).toBeUndefined();
            calls.push(["prepare", saved]);
            url = saved ? HOME : TEMPORARY;
          },
        };
        try {
          const result = await methods.inspectSessionExclusive.call(worker, detectCapabilities);
          expect(calls).toEqual([["prepare", true]]);
          expect(result).toEqual({ authenticated: true, newChat: true, url: HOME,
            ...(detectCapabilities ? capabilities : {}) });
          expect(detect).toHaveBeenCalledTimes(detectCapabilities ? 1 : 0);
          expect(worker.config.useSavedChats).toBe(useSavedChats);
        } finally {
          detect.mockRestore();
        }
      });
    }
  }
}

for (const useSavedChats of [false, true]) {
  test(`task preparation still honors saved-chat privacy=${useSavedChats}`, async () => {
    let url = "about:blank";
    const visits: string[] = [];
    const stopped = new Error("stop before reading or submitting a real composer");
    const worker = {
      config: { useSavedChats },
      activeComposer: async () => { throw stopped; },
    };
    const page = { url: () => url, goto: async (target: string) => { visits.push(target); url = target; } };
    await expect(methods.prepareChatSurface.call(worker, page)).rejects.toBe(stopped);
    expect(visits).toEqual([useSavedChats ? HOME : TEMPORARY]);
    expect(worker.config.useSavedChats).toBe(useSavedChats);
  });
}

test("the smoke prompt remains temporary rather than creating a saved conversation", async () => {
  const page = {};
  const stopped = new Error("stop before the smoke prompt is submitted");
  const calls: unknown[][] = [];
  const worker = {
    config: { useSavedChats: true },
    ensurePage: async () => page,
    prepareChatSurface: async (actual: object, diagnostic: unknown, saved: boolean) => {
      calls.push([actual, diagnostic, saved]);
      throw stopped;
    },
  };
  await expect(methods.smokeTestExclusive.call(worker)).rejects.toBe(stopped);
  expect(calls).toEqual([[page, undefined, false]]);
});

test("failed account inspection is not reported as authenticated", async () => {
  const failure = new Error("ChatGPT session is signed out");
  const worker = {
    ensurePage: async () => ({}),
    prepareChatSurface: async () => { throw failure; },
  };
  await expect(methods.inspectSessionExclusive.call(worker, false)).rejects.toBe(failure);
});
