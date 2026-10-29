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
  selectChatGptPickerStop,
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

/** Each model's own slider stops, as ChatGPT's status line names them (captured live 2026-10-29). */
const PLUS_STOPS: Record<string, string[]> = {
  // Plus "Default" walks across models; everything past 6 High is billed to the Codex quota.
  Default: ["6 Instant", "6 High", "6.1 Sol Light", "6.1 Sol Medium", "6 Astra Medium", "6 Astra Extra High"],
  "GPT-6 Sol": ["6 Instant", "6 Medium", "6 High"],
};
const TEAM_STOPS: Record<string, string[]> = {
  "6": ["6 Instant", "6 Medium", "6 High", "6 Extra High", "6 Pro"],
  "GPT-5.6 Sol": ["5.6 Sol Light", "5.6 Sol High"],
};

/**
 * The current picker on Plus or Team: a header row that swaps the Power slider for the model list,
 * model rows whose names and order change by plan, and a slider whose stops belong to the chosen
 * model. Clicks act as ChatGPT does: the header opens the list; a row (only in the list) chooses
 * that model and returns to the slider. On Team "6" is the default, so it never reads as explicit.
 */
function modelListPicker(options: { plan?: "plus" | "team"; models?: string[]; locked?: string; clickIgnored?: boolean; jumpy?: boolean } = {}) {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const team = options.plan === "team";
  const stopsByModel = team ? TEAM_STOPS : PLUS_STOPS;
  const defaultModel = team ? "6" : "Default";
  const models = team
    ? options.models ?? ["6", "GPT-5.6 Sol"]
    : ["Default", ...(options.models ?? ["GPT-6.1 Sol", "GPT-6 Sol", "GPT-6 Astra", "GPT-5.6 Sol"])];
  const state = { view: "simple", chosen: defaultModel, value: team ? 3 : 1, keys: [] as string[], clicks: [] as string[] };
  const stops = () => stopsByModel[state.chosen] ?? ["Other Light", "Other High"];
  const row = (name: string) => `<div role="menuitemradio" aria-checked="${name === state.chosen}"`
    + `${name === options.locked ? ' aria-describedby="locked-note"' : ""}><div data-menu-row-content="true">`
    + (name === "Default" ? "<div><span>Default</span><span><span>Recommended set of models</span></span></div>" : `<span>${name}</span>`)
    + "</div></div>";
  const render = () => createDocument(`<body><div role="menu" id="menu"><div data-model-picker-view="${state.view}">`
    + `<div data-explicit-model="${state.chosen !== defaultModel}"><div role="menuitem" aria-label="Select model" data-model-picker-view-toggle="true">`
    + `<div data-menu-row-content="true"><span>${stops()[state.value]}</span></div></div></div>`
    + `<div data-model-picker-power-slider=""><span role="slider" aria-valuemin="0" aria-valuemax="${stops().length - 1}" aria-valuenow="${state.value}"></span></div>`
    + `<div role="status">${stops()[state.value]}, ${state.value + 1} of ${stops().length}.</div>`
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
        if (options.clickIgnored) return;
        if (name !== state.chosen) state.value = 0;
        state.chosen = name;
        state.view = "simple";
      },
    };
  };
  const menu = {
    filter() { return this; }, last() { return this; }, isVisible: async () => true,
    locator: (selector: string) => locator(selector),
    evaluate: async (fn: (root: Element, arg: string) => unknown, arg: string) => fn(render(), arg),
    getByText: () => ({ count: async () => 0 }),
  };
  const sliderControl = {
    press: async (key: string) => {
      state.keys.push(key);
      const next = state.value + (key === "ArrowRight" ? 1 : -1) * (options.jumpy ? 2 : 1);
      state.value = Math.max(0, Math.min(stops().length - 1, next));
    },
  };
  const slider = {
    isVisible: async () => false,
    waitFor: async () => {},
    getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": String(stops().length - 1), "aria-valuenow": String(state.value) })[name] ?? null,
    locator: () => sliderControl,
  };
  const container = { filter() { return this; }, last() { return this; }, locator: () => slider, isVisible: async () => true, waitFor: async () => {} };
  /** A page whose effort menu and slider are this picker; everything else is the older fixture's. */
  const pageOver = (fixture: ReturnType<typeof reasoningPicker>, pressed: string[] = []) => ({
    ...fixture.page,
    locator: (selector: string) => selector === CHATGPT_EFFORT_MENU_SELECTOR ? menu
      : selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR ? container : fixture.page.locator(selector),
    keyboard: { press: async (key: string) => { pressed.push(key); } },
  });
  return { menu, slider, state, pageOver, label: () => stops()[state.value] };
}

test("GPT-6 Sol is picked by its exact name on Plus, wherever it sits in the list", async () => {
  const picker = modelListPicker();
  await expect(selectChatGptModelFromList(picker.menu as never)).resolves.toBe("GPT-6 Sol");
  expect(picker.state.clicks).toEqual(["header", "GPT-6 Sol"]);
  expect(picker.state.chosen).toBe("GPT-6 Sol");
  expect(picker.state.view).toBe("simple");
  expect(picker.state.keys).toEqual([]);
});

test("on Team the GPT-6 row is \"6\", and it counts as chosen though ChatGPT keeps it non-explicit", async () => {
  const picker = modelListPicker({ plan: "team" });
  await expect(selectChatGptModelFromList(picker.menu as never)).resolves.toBe("6");
  expect(picker.state.clicks).toEqual(["header", "6"]);
  expect(picker.state.chosen).toBe("6");
});

test("each failed step stops the pick instead of choosing another model", async () => {
  const missing = modelListPicker({ models: ["GPT-6.1 Sol", "GPT-6 Astra"] });
  await expect(selectChatGptModelFromList(missing.menu as never, undefined, 50))
    .rejects.toThrow('no row named "GPT-6 Sol" or "6"');
  expect(missing.state.clicks).toEqual(["header"]);

  const locked = modelListPicker({ locked: "GPT-6 Sol" });
  await expect(selectChatGptModelFromList(locked.menu as never, undefined, 50))
    .rejects.toThrow("locked or out of usage");
  expect(locked.state.chosen).toBe("Default");

  const ignored = modelListPicker({ clickIgnored: true });
  await expect(selectChatGptModelFromList(ignored.menu as never, undefined, 50))
    .rejects.toThrow("did not become the picker's chosen model");
});

test("a stop is found by its label, whatever its position, and only moves one stop per key", async () => {
  const team = modelListPicker({ plan: "team" });
  await selectChatGptPickerStop(team.menu as never, team.slider as never, "6 Pro");
  expect(team.label()).toBe("6 Pro");
  expect(team.state.keys.slice(-1)).toEqual(["ArrowRight"]);

  const already = modelListPicker({ plan: "team" });
  await selectChatGptPickerStop(already.menu as never, already.slider as never, "6 Extra High");
  expect(already.state.keys).toEqual([]);

  // Plus GPT-6 Sol stops at 6 High: asking for Pro fails on its last stop, never past it.
  const plus = modelListPicker();
  await selectChatGptModelFromList(plus.menu as never);
  await expect(selectChatGptPickerStop(plus.menu as never, plus.slider as never, "6 Pro", 50))
    .rejects.toThrow('no "6 Pro" stop (stops: 6 Instant, 6 Medium, 6 High)');
  expect(plus.state.chosen).toBe("GPT-6 Sol");

  const jumpy = modelListPicker({ plan: "team", jumpy: true });
  await expect(selectChatGptPickerStop(jumpy.menu as never, jumpy.slider as never, "6 Pro", 50))
    .rejects.toThrow("moved from stop");
});

test("the account probe reads GPT-6's own slider: Plus has no Extra High or Pro, Team has both", async () => {
  const plus = modelListPicker();
  await expect(detectChatGptAccountCapabilities(plus.pageOver(reasoningPicker()) as never))
    .resolves.toEqual({ solAvailable: true, proAvailable: false });
  expect(plus.state.chosen).toBe("GPT-6 Sol");

  const team = modelListPicker({ plan: "team" });
  await expect(detectChatGptAccountCapabilities(team.pageOver(reasoningPicker()) as never))
    .resolves.toEqual({ solAvailable: true, proAvailable: true });
  expect(team.state.chosen).toBe("6");
});

const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
  selectModelAndEffort(...args: unknown[]): Promise<unknown>;
}).selectModelAndEffort;

test.each([
  ["team", "max", "6", "6 Pro"],
  ["team", "xhigh", "6", "6 Extra High"],
  ["plus", "high", "GPT-6 Sol", "6 High"],
  ["plus", "low", "GPT-6 Sol", "6 Instant"],
] as const)("a %s turn at %s picks %s and lands on %s", async (plan, effort, model, label) => {
  const fixture = reasoningPicker();
  const picker = modelListPicker({ plan });
  const pressed: string[] = [];
  await selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture, pressed),
    "gpt-5.6-sol", effort, { localToolsEnabled: false, solAvailable: true, proAvailable: plan === "team" });
  expect(picker.state.clicks).toEqual(["header", model]);
  expect(picker.label()).toBe(label);
  expect(fixture.keys).toEqual([]);
  expect(pressed).toEqual(["Escape"]);
});

test("a Plus turn asked for Pro stops with a model-pick error and never leaves GPT-6", async () => {
  const fixture = reasoningPicker();
  const picker = modelListPicker();
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", "max", { localToolsEnabled: false, solAvailable: true, proAvailable: true }))
    .rejects.toMatchObject({ code: "chatgpt_model_pick_failed", retryable: false });
  expect(picker.state.chosen).toBe("GPT-6 Sol");
  expect(picker.label()).toBe("6 High");
});
