import { describe, expect, test } from "bun:test";
import {
  declineChatGptWorkModeOffer,
  ensureChatGptChatMode,
  isChatGptWorkComposer,
  throwIfChatGptWorkMode,
} from "../src/adapters/chatgpt-web/browser-worker";

// ChatGPT's Chat | Work switch as seen live (2026-10-20): a [role=group][aria-label="Composer
// mode"] with two buttons carrying aria-pressed; Work's composer is labelled "Work with ChatGPT".
interface State {
  switchVisible: boolean;
  pressed: "Chat" | "Work";
  stuckInWork?: boolean;
  offer?: { buttons: string[] };
  label: string;
  clicks: string[];
}

function fakePage(state: State) {
  const self = <T extends object>(value: T) => Object.assign(value, { filter: () => value, last: () => value, first: () => value });
  const modeSwitch = self({
    isVisible: async () => state.switchVisible,
    getByRole: (_role: string, { name }: { name: RegExp }) => self({
      getAttribute: async () => (name.test(state.pressed) ? "true" : "false"),
      click: async () => {
        const button = name.test("Chat") ? "Chat" : "Work";
        state.clicks.push(button);
        if (!state.stuckInWork) state.pressed = button;
      },
    }),
  });
  const offer = self({
    isVisible: async () => Boolean(state.offer),
    getByRole: (_role: string, { name }: { name: RegExp }) => {
      const label = state.offer?.buttons.find(button => name.test(button));
      return self({
        isVisible: async () => Boolean(label),
        click: async () => { state.clicks.push(`offer:${label}`); state.offer = undefined; },
      });
    },
  });
  const composer = self({ getAttribute: async () => state.label });
  return {
    locator: (selector: string) => selector.includes("Composer mode") ? modeSwitch
      : selector.includes('[role="dialog"]') ? offer
      : composer,
  } as never;
}

const state = (overrides: Partial<State> = {}): State => ({
  switchVisible: true, pressed: "Chat", label: "Ask ChatGPT", clicks: [], ...overrides,
});

describe("Web GPT turns stay in Chat mode, never Work (Codex quota)", () => {
  test("a new chat opened in Work is switched to Chat before anything is typed", async () => {
    const work = state({ pressed: "Work" });
    expect(await ensureChatGptChatMode(fakePage(work))).toBe(true);
    expect(work.pressed).toBe("Chat");
    expect(work.clicks).toEqual(["Chat"]);
    const chat = state();
    expect(await ensureChatGptChatMode(fakePage(chat))).toBe(false);
    expect(chat.clicks).toEqual([]);
    // No switch on the page (a conversation, or an account without Work): nothing to do.
    expect(await ensureChatGptChatMode(fakePage(state({ switchVisible: false, pressed: "Work" })))).toBe(false);
  });

  test("a switch that stays on Work stops the turn instead of running on Codex quota", async () => {
    await expect(ensureChatGptChatMode(fakePage(state({ pressed: "Work", stuckInWork: true })), 200))
      .rejects.toMatchObject({ code: "chatgpt_work_mode" });
  });

  test("ChatGPT's offer to move the chat to Work is declined before it applies itself", async () => {
    const offered = state({ offer: { buttons: ["Switch to Work", "Not now"] } });
    expect(await declineChatGptWorkModeOffer(fakePage(offered))).toBe(true);
    expect(offered.clicks).toEqual(["offer:Not now"]);
    // Without a decline action there is nothing safe to click.
    expect(await declineChatGptWorkModeOffer(fakePage(state({ offer: { buttons: ["Switch to Work"] } })))).toBe(false);
  });

  test("during a turn, a chat already moved to Work stops the turn; Chat carries on", async () => {
    await expect(throwIfChatGptWorkMode(fakePage(state({ label: "Work with ChatGPT" }))))
      .rejects.toMatchObject({ code: "chatgpt_work_mode" });
    await throwIfChatGptWorkMode(fakePage(state()));
    // A pending offer is declined first, so the chat never reaches Work.
    const offered = state({ offer: { buttons: ["Maybe later"] } });
    await throwIfChatGptWorkMode(fakePage(offered));
    expect(offered.clicks).toEqual(["offer:Maybe later"]);
    expect(await isChatGptWorkComposer(undefined)).toBe(false);
  });
});
