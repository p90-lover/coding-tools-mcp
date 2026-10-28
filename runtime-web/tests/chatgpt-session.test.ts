import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR,
  activateChatGptEffortMenu,
  detectChatGptAccountCapabilities,
  selectChatGptModelFromList,
} from "../src/chatgpt-session";

test("composer and effort selectors exclude unrelated editable fields and menu buttons", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument(`<body><form>
    <div contenteditable="true" id="unrelated-editor"></div>
    <textarea placeholder="Search" id="search"></textarea>
    <textarea name="prompt-textarea" placeholder="Temporary chat" id="composer-fallback"></textarea>
    <button aria-haspopup="menu" id="attachments"></button>
    <div data-testid="prompt-textarea" id="composer-testid"></div>
    <div id="prompt-textarea"></div>
    <div contenteditable="true" data-lexical-editor="true" id="composer-lexical"></div>
    <div contenteditable="true" role="textbox" aria-label="Ask ChatGPT" id="composer-accessible"></div>
    <button aria-haspopup="menu" data-tone="neutral" id="effort"></button>
    <button aria-haspopup="menu" data-testid="model-switcher-dropdown-button" id="model"></button>
    <button aria-haspopup="menu" aria-label="Select ChatGPT model" id="current-model"></button>
    <button aria-haspopup="menu" aria-label="選擇模型" data-codex-intelligence-trigger="true" id="translated-model"></button>
    <div data-model-picker-power-slider id="power-container"><span role="slider" id="power-slider"></span></div>
    <div data-model-reasoning-effort-slider id="legacy-container"><span role="slider" id="legacy-slider"></span></div>
    <span role="slider" id="unrelated-volume-slider"></span>
  </form></body>`);
  const matches = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.id);
  expect(matches(CHATGPT_COMPOSER_SELECTOR)).toEqual(["composer-fallback", "composer-testid", "prompt-textarea", "composer-lexical", "composer-accessible"]);
  expect(matches(CHATGPT_EFFORT_CONTROL_SELECTOR)).toEqual(["effort", "model", "current-model", "translated-model"]);
  expect(matches(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR)).toEqual(["power-container", "legacy-container"]);
  expect(matches(CHATGPT_EFFORT_SLIDER_SELECTOR)).toEqual(["power-slider", "legacy-slider"]);
});

test("effort activation binds the owned menu after the control opens", async () => {
  let opened = false;
  const ownedMenu = { isVisible: async () => opened };
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return opened ? "radix-effort-menu" : null;
      if (name === "aria-expanded") return opened ? "true" : "false";
      if (name === "data-state") return opened ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      expect(options).toEqual({ force: true, timeout: 1 });
      opened = true;
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[id="radix-effort-menu"]') return ownedMenu;
      return hiddenSurface;
    },
    keyboard: { press: async () => {} },
  };

  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("click");
  expect(activation.menu).toBe(ownedMenu as never);
});

test.each(["aria-expanded", "data-state"])("effort activation does not bind a closing menu (%s)", async attribute => {
  let opened = false;
  let clicks = 0;
  // Escape closes the control immediately, but the outgoing menu remains visible
  // through its exit animation. Its stale range must not authorize a new selection.
  const surface = {
    filter() { return this; }, last() { return this; }, locator() { return this; },
    isVisible: async () => true,
  };
  const control = {
    getAttribute: async (name: string) => name === attribute
      ? attribute === "aria-expanded" ? String(opened) : opened ? "open" : "closed"
      : null,
    click: async () => { clicks++; opened = true; },
  };
  const page = { locator: () => surface, keyboard: { press: async () => {} } };
  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("click");
  expect(clicks).toBe(1);
});

test("effort activation retries one ghost click with a primary pointerdown", async () => {
  let ghostOpen = false;
  let pointerOpened = false;
  const events: unknown[] = [];
  const ownedMenu = { isVisible: async () => pointerOpened };
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return pointerOpened ? "radix-effort-menu" : null;
      if (name === "aria-expanded") return ghostOpen ? "true" : "false";
      if (name === "data-state") return ghostOpen ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      events.push(["click", options]);
      ghostOpen = true;
    },
    dispatchEvent: async (name: string, detail: unknown) => {
      events.push([name, detail]);
      ghostOpen = true;
      pointerOpened = true;
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[id="radix-effort-menu"]') return ownedMenu;
      return hiddenSurface;
    },
    keyboard: {
      press: async (key: string) => {
        events.push(["keyboard", key]);
        ghostOpen = false;
      },
    },
  };

  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("pointerdown");
  expect(activation.menu).toBe(ownedMenu as never);
  expect(events).toEqual([
    ["click", { force: true, timeout: 1 }],
    ["keyboard", "Escape"],
    ["pointerdown", { button: 0, buttons: 1, pointerType: "mouse", isPrimary: true }],
  ]);
});

test("effort activation fails closed when neither event exposes a structural surface", async () => {
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async () => null,
    click: async () => {},
    dispatchEvent: async () => {},
  };
  const page = {
    locator: () => hiddenSurface,
    keyboard: { press: async () => {} },
  };

  await expect(activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 }))
    .rejects.toThrow("did not expose its owned menu or structural slider");
});

test("a complete authenticated composer with no effort selector is Luna-only", async () => {
  const effortButton = {
    last() { return this; },
    isVisible: async () => false,
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composer = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composer,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
});

test("a transient effort control does not turn a Luna-only account into Sol", async () => {
  let visibilityReads = 0;
  const effortButton = {
    last() { return this; },
    isVisible: async () => {
      visibilityReads += 1;
      return visibilityReads === 1;
    },
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composers = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composers,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
  expect(visibilityReads).toBe(2);
});

function reasoningPicker(options: { max?: string; delay?: number; missing?: boolean; locked?: boolean } = {}) {
  let value = 0;
  const keys: string[] = [];
  const hidden = {
    filter() { return this; }, last() { return this; }, getByText() { return this; },
    isVisible: async () => false,
    waitFor: ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  };
  const sliderControl = { press: async (key: string) => { keys.push(key); value += key === "ArrowRight" ? 1 : -1; } };
  const slider = {
    isVisible: async () => false, // Live DOM: aria-hidden=true, zero-width semantic span.
    filter: () => { throw new Error("Semantic input must not be visibility-filtered"); },
    waitFor: async ({ state }: { state: string }) => { expect(state).toBe("attached"); },
    getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": options.max ?? "4", "aria-valuenow": String(value), "aria-hidden": "true" })[name] ?? null,
    locator: () => sliderControl,
  };
  const container = {
    filter() { return this; }, last() { return this; },
    locator: () => slider,
    isVisible: async () => true,
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      if (options.missing) throw new Error("effort container never hydrated");
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    },
  };
  const control = {
    last() { return this; }, waitFor: async () => {}, isVisible: async () => true,
    getAttribute: async (name: string) => name === "aria-expanded" ? "true" : null,
  };
  const composer = { filter() { return this; }, last() { return this; }, locator: () => ({ locator: () => control }) };
  const modelRows = { count: async () => 3, first() { return this; }, waitFor: async () => {}, nth: () => { throw new Error("Model rows are not effort choices"); } };
  // The older picker: no model header row, so effort is set on its slider.
  const noToggle = { count: async () => 0 };
  const menu = { filter() { return this; }, last() { return this; }, isVisible: async () => true,
    locator: (selector: string) => selector === CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR ? noToggle : modelRows,
    getByText: () => ({ count: async () => options.locked ? 1 : 0 }) };
  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composer;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return container;
      return hidden;
    },
    keyboard: { press: async () => {} },
  };
  return { page, composer, keys, value: () => value };
}

test.each([0, 50])("capabilities wait for the visible container and read its hidden semantic input (delay=%s)", async delay => {
  const fixture = reasoningPicker({ delay });
  await expect(detectChatGptAccountCapabilities(fixture.page as never)).resolves.toEqual({ solAvailable: true, proAvailable: true });
});

test("an absent effort slider cannot turn three model rows into a saved non-Pro capability", async () => {
  const fixture = reasoningPicker({ missing: true });
  await expect(detectChatGptAccountCapabilities(fixture.page as never)).rejects.toThrow("never hydrated");
});

test("the authoritative three-step range is non-Pro; a malformed range fails closed", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "2" }).page as never)).resolves.toEqual({ solAvailable: true, proAvailable: false });
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "bad" }).page as never)).rejects.toThrow("model controls are unavailable");
});

test("a five-step picker with locked access does not advertise Pro or Extra High", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ locked: true }).page as never))
    .resolves.toEqual({ solAvailable: true, proAvailable: false });
});

test("Pro selection changes the hidden slider through its visible owner, never through model rows", async () => {
  const fixture = reasoningPicker({ delay: 50 });
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(...args: unknown[]): Promise<unknown>;
  }).selectModelAndEffort;
  await select.call({ activeComposer: async () => fixture.composer }, fixture.page, "gpt-5.6-sol", "max", { localToolsEnabled: false, solAvailable: true, proAvailable: true });
  expect(fixture.keys).toEqual(["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]);
  expect(fixture.value()).toBe(4);
});

/**
 * The current picker as captured live on 2026-10-29: a header row that swaps the Power slider for
 * the model list, and model rows whose order may change. Clicks act as ChatGPT does: the header
 * opens the list; a row (only in the list) makes that model explicit and returns to the slider.
 */
function modelListPicker(options: { models?: string[]; locked?: string; clickIgnored?: boolean } = {}) {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const models = ["Default", ...(options.models ?? ["GPT-6.1 Sol", "GPT-6 Sol", "GPT-6 Astra", "GPT-5.6 Sol"])];
  const state = { view: "simple", chosen: "Default", sliderKeys: 0, clicks: [] as string[] };
  const row = (name: string) => `<div role="menuitemradio" aria-checked="${name === state.chosen}"`
    + `${name === options.locked ? ' aria-describedby="locked-note"' : ""}><div data-menu-row-content="true">`
    + (name === "Default" ? "<div><span>Default</span><span><span>Recommended set of models</span></span></div>" : `<span>${name}</span>`)
    + "</div></div>";
  const render = () => createDocument(`<body><div role="menu" id="menu"><div data-model-picker-view="${state.view}">`
    + `<div data-explicit-model="${state.chosen !== "Default"}"><div role="menuitem" aria-label="Select model" data-model-picker-view-toggle="true">`
    + `<div data-menu-row-content="true"><span>6 Sol</span><span>6 High</span></div></div></div>`
    + '<div data-model-picker-power-slider=""><span role="slider" aria-valuemin="0" aria-valuemax="5" aria-valuenow="1"></span></div>'
    + `<div><div data-menu-section-label="true">Select model</div><span id="locked-note">Locked, opens access options</span>${models.map(row).join("")}</div>`
    + "</div></div></body>").getElementById("menu")!;
  const locator = (selector: string, index?: number): Record<string, unknown> => {
    const elements = () => {
      const found = Array.from(render().querySelectorAll(selector));
      return index === undefined ? found : found.slice(index, index + 1);
    };
    return {
      filter: () => locator(selector, index),
      nth: (n: number) => locator(selector, n),
      count: async () => elements().length,
      evaluateAll: async (fn: (items: Element[]) => unknown) => fn(elements()),
      click: async () => {
        if (selector === CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR) { state.clicks.push("header"); state.view = "advanced"; return; }
        if (state.view !== "advanced") throw new Error("model rows are inert outside the list");
        const name = elements()[0]!.querySelector("[data-menu-row-content]")!.textContent!.trim();
        state.clicks.push(name);
        if (!options.clickIgnored) { state.chosen = name; state.view = "simple"; }
      },
    };
  };
  const menu = {
    filter() { return this; }, last() { return this; }, isVisible: async () => true,
    locator: (selector: string) => locator(selector),
    evaluate: async (fn: (root: Element, arg: string) => unknown, arg: string) => fn(render(), arg),
    getByText: () => ({ count: async () => 0 }),
  };
  return { menu, state };
}

test("GPT-6 Sol is picked by its exact name from the list, wherever it sits, and the slider is not touched", async () => {
  const picker = modelListPicker();
  await selectChatGptModelFromList(picker.menu as never);
  expect(picker.state.clicks).toEqual(["header", "GPT-6 Sol"]);
  expect(picker.state.chosen).toBe("GPT-6 Sol");
  expect(picker.state.view).toBe("simple");
});

test("each failed step stops the pick instead of choosing another model", async () => {
  const missing = modelListPicker({ models: ["GPT-6.1 Sol", "GPT-6 Astra"] });
  await expect(selectChatGptModelFromList(missing.menu as never, undefined, 50))
    .rejects.toThrow('0 rows named "GPT-6 Sol"');
  expect(missing.state.clicks).toEqual(["header"]);

  const locked = modelListPicker({ locked: "GPT-6 Sol" });
  await expect(selectChatGptModelFromList(locked.menu as never, undefined, 50))
    .rejects.toThrow("locked or out of usage");
  expect(locked.state.chosen).toBe("Default");

  const ignored = modelListPicker({ clickIgnored: true });
  await expect(selectChatGptModelFromList(ignored.menu as never, undefined, 50))
    .rejects.toThrow("did not become the picker's chosen model");
});

test("a picker with a model list reports Sol without Pro, never reading its cross-model slider", async () => {
  const fixture = reasoningPicker();
  const picker = modelListPicker();
  const page = { ...fixture.page, locator: (selector: string) => selector === CHATGPT_EFFORT_MENU_SELECTOR ? picker.menu : fixture.page.locator(selector) };
  await expect(detectChatGptAccountCapabilities(page as never)).resolves.toEqual({ solAvailable: true, proAvailable: false });
});

test("a turn on the current picker picks GPT-6 Sol and never presses the slider, whatever effort was asked", async () => {
  const fixture = reasoningPicker();
  const picker = modelListPicker();
  const pressed: string[] = [];
  const page = {
    ...fixture.page,
    locator: (selector: string) => selector === CHATGPT_EFFORT_MENU_SELECTOR ? picker.menu : fixture.page.locator(selector),
    keyboard: { press: async (key: string) => { pressed.push(key); } },
  };
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(...args: unknown[]): Promise<unknown>;
  }).selectModelAndEffort;
  await select.call({ activeComposer: async () => fixture.composer }, page, "gpt-5.6-sol", "max", { localToolsEnabled: false, solAvailable: true, proAvailable: true });
  expect(picker.state.clicks).toEqual(["header", "GPT-6 Sol"]);
  expect(fixture.keys).toEqual([]);
  expect(pressed).toEqual(["Escape"]);
});
