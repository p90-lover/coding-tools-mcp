import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode, resolveChatGptWebTurnCapabilities } from "../src/adapters/chatgpt-web/model";
import { availableChatGptWebModelRoutes, requireChatGptWebModelRoute } from "../src/chatgpt-web-models";
import { chatGptEffortTierAvailability, type ChatGptEffortSnapshot } from "../src/chatgpt-account-capabilities";
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
function modelListPicker(options: { plan?: "plus" | "team"; models?: string[]; defaultModel?: string; stops?: string[]; locked?: string; disabled?: string; lockedStops?: string[]; statusOffset?: number; afterKey?: () => void; clickIgnored?: boolean; jumpy?: boolean } = {}) {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const team = options.plan === "team";
  const stopsByModel = team ? TEAM_STOPS : PLUS_STOPS;
  const defaultModel = options.defaultModel ?? (team ? "6" : "Default");
  const models = team
    ? options.models ?? ["6", "GPT-5.6 Sol"]
    : ["Default", ...(options.models ?? ["GPT-6.1 Sol", "GPT-6 Sol", "GPT-6 Astra", "GPT-5.6 Sol"])];
  const state = { view: "simple", chosen: defaultModel, value: team ? 3 : 1, keys: [] as string[], clicks: [] as string[] };
  const stops = () => options.stops ?? stopsByModel[state.chosen] ?? ["Other Light", "Other High"];
  const row = (name: string) => `<div role="menuitemradio" aria-checked="${name === state.chosen}"`
    + `${name === options.disabled ? ' aria-disabled="true"' : ""}`
    + `${name === options.locked ? ' aria-describedby="locked-note"' : ""}><div data-menu-row-content="true">`
    + (name === "Default" ? "<div><span>Default</span><span><span>Recommended set of models</span></span></div>" : `<span>${name}</span>`)
    + "</div></div>";
  const render = () => createDocument(`<body><div role="menu" id="menu"><div data-model-picker-view="${state.view}">`
    + `<div data-explicit-model="${state.chosen !== defaultModel}"><div role="menuitem" aria-label="Select model" data-model-picker-view-toggle="true">`
    + `<div data-menu-row-content="true"><span>${stops()[state.value]}</span></div></div></div>`
    + `<div data-model-picker-power-slider=""><span role="slider" aria-valuemin="0" aria-valuemax="${stops().length - 1}" aria-valuenow="${state.value}"></span>`
    + stops().map((label, index) => `<span data-locked="${options.lockedStops?.includes(label) ?? false}" data-selected="${index === state.value}"></span>`).join("") + "</div>"
    + `<div role="status">${stops()[state.value]}, ${state.value + 1 + (options.statusOffset ?? 0)} of ${stops().length}.</div>`
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
      options.afterKey?.();
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
  const missing = modelListPicker({ models: ["GPT-6.1 Sol", "GPT-6 Astra", "GPT-5.6 Sol"] });
  await expect(selectChatGptModelFromList(missing.menu as never, undefined, 50))
    .rejects.toThrow('no row named "GPT-6 Sol" or "6" or "GPT-6"');
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
  const observed = await selectChatGptPickerStop(already.menu as never, already.slider as never, "6 Extra High");
  expect(already.label()).toBe("6 Extra High");
  expect(observed.effortSnapshot).toBeDefined();
  expect(already.state.keys.length).toBeLessThanOrEqual(12);

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

const PLAIN_STOPS = ["Instant", "Medium", "High", "Extra High", "Pro"];
const PLAIN_EFFORTS = [["low", "Instant"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra High"], ["max", "Pro"]] as const;

test.each([["xhigh", "Extra High", "missing"], ["max", "Pro", "missing"],
  ["xhigh", "Extra High", "locked"], ["max", "Pro", "locked"]] as const)(
  "native account deferral still rejects %s (%s) when that stop is %s", async (effort, label, state) => {
    const fixture = reasoningPicker();
    const picker = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6",
      stops: state === "missing" ? PLAIN_STOPS.filter(name => name !== label) : PLAIN_STOPS,
      lockedStops: state === "locked" ? [label] : [] });
    const capabilities = resolveChatGptWebTurnCapabilities({
      modelId: "gpt-5.6-sol", stream: false, context: { messages: [] }, options: { reasoning: effort },
      _rawBody: { client_metadata: { "x-codex-turn-metadata": { thread_id: "01a06c66-0000-7ae1-9108-69b5f70e0671" } } },
    }, { localToolsEnabled: false, solAvailable: true, proAvailable: false },
    { browserHost: "launcher", browserHostDescriptorPath: "G:/fixture/launcher.json" });
    const operation = selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
      "gpt-5.6-sol", effort, capabilities);
    await expect(operation).rejects.toMatchObject({ code: "chatgpt_model_pick_failed", retryable: false });
    await expect(operation).rejects.toThrow(state === "missing" ? `no "6 ${label}" stop` : `"6 ${label}" stop is locked`);
  },
);

test.each(PLAIN_EFFORTS)("plain GPT-6 %s selects exactly %s", async (effort, label) => {
  const fixture = reasoningPicker();
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6", stops: PLAIN_STOPS });
  const mode = await selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", effort, { localToolsEnabled: false, solAvailable: true, proAvailable: true });
  expect(mode).toMatchObject({ effort, displayLabel: label });
  expect(picker.state.clicks).toEqual(["header", "GPT-6"]);
  expect(picker.state.chosen).toBe("GPT-6");
  expect(picker.label()).toBe(label);
});

test.each(PLAIN_EFFORTS)("plain GPT-6 missing %s never substitutes another choice", async (effort, label) => {
  const fixture = reasoningPicker();
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6",
    stops: PLAIN_STOPS.filter(stop => stop !== label) });
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", effort, { localToolsEnabled: false, solAvailable: true, proAvailable: true }))
    .rejects.toMatchObject({ code: "chatgpt_model_pick_failed", retryable: false });
  expect(picker.state.chosen).toBe("GPT-6");
  expect(picker.label()).not.toBe(label);
});

test.each([["high", "High"], ["max", "Pro"]] as const)("plain GPT-6 locked %s is not a selected choice", async (effort, label) => {
  const fixture = reasoningPicker();
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6",
    stops: PLAIN_STOPS, lockedStops: [label] });
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", effort, { localToolsEnabled: false, solAvailable: true, proAvailable: true }))
    .rejects.toThrow(`"6 ${label}" stop is locked`);
});

test.each(["plain", "legacy"])("plain GPT-6 labels never authorize the wrong model family (%s)", async kind => {
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-5.6 Sol",
    stops: kind === "plain" ? PLAIN_STOPS : PLAIN_STOPS.map(label => `6 ${label}`) });
  await expect(selectChatGptPickerStop(picker.menu as never, picker.slider as never, "6 High", 50))
    .rejects.toThrow("GPT-6 model selection");
  expect(picker.state.keys).toEqual([]);
});

test("plain GPT-6 disabled model rows cannot fall back to GPT-5.6", async () => {
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6",
    stops: PLAIN_STOPS, disabled: "GPT-6" });
  await expect(selectChatGptModelFromList(picker.menu as never, undefined, 50)).rejects.toThrow("locked or out of usage");
  expect(picker.state.clicks).toEqual(["header"]);
});

test.each(["model", "effort"])("plain GPT-6 final verification rejects %s drift after diagnostics", async drift => {
  const fixture = reasoningPicker();
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6",
    stops: PLAIN_STOPS.map(label => `6 ${label}`) });
  let changed = false;
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", "high", { localToolsEnabled: false, solAvailable: true, proAvailable: true }, async (checkpoint: string) => {
      if (checkpoint === "effort-selected") {
        changed = true;
        if (drift === "model") picker.state.chosen = "GPT-5.6 Sol";
        else picker.state.value = 3; // Extra High must never count as High.
      }
    })).rejects.toMatchObject({ code: "chatgpt_model_pick_failed", retryable: false });
  expect(changed).toBe(true);
});

test("plain GPT-6 model drift after a slider key stops before another choice", async () => {
  const fixture = reasoningPicker();
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6",
    stops: PLAIN_STOPS, afterKey: () => { picker.state.chosen = "GPT-5.6 Sol"; } });
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", "high", { localToolsEnabled: false, solAvailable: true, proAvailable: true }))
    .rejects.toThrow("GPT-6 model selection");
  expect(picker.state.keys).toHaveLength(1);
});

test("plain GPT-6 status disagreement and multi-step jumps fail closed", async () => {
  const inconsistent = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6", stops: PLAIN_STOPS, statusOffset: 1 });
  await expect(selectChatGptPickerStop(inconsistent.menu as never, inconsistent.slider as never, "6 High", 50))
    .rejects.toThrow("did not settle");
  expect(inconsistent.state.keys).toEqual([]);
  const jumpy = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6", stops: PLAIN_STOPS, jumpy: true });
  await expect(selectChatGptPickerStop(jumpy.menu as never, jumpy.slider as never, "6 Pro", 50)).rejects.toThrow("moved from stop");
});

test.each(["available", "locked", "locked both", "missing"])("plain GPT-6 capability probe preserves upper-tier admission and exact Pro cache (%s)", async state => {
  const stops = state === "missing" ? ["Instant", "Medium", "High", "Extra High", "Extra High"] : PLAIN_STOPS;
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6", stops,
    lockedStops: state === "locked both" ? ["Extra High", "Pro"] : state === "locked" ? ["Pro"] : [] });
  const snapshots: unknown[] = [];
  await expect(detectChatGptAccountCapabilities(picker.pageOver(reasoningPicker()) as never,
    { onEffortSnapshot: snapshot => { snapshots.push(snapshot); } }))
    .resolves.toEqual({ solAvailable: true, proAvailable: state === "available" || state === "locked" });
  expect(snapshots).toHaveLength(state === "missing" ? 0 : 1);
  if (state !== "missing") expect(snapshots[0]).toMatchObject({ ticks: [{ locked: false }, { locked: false }, { locked: false }, { locked: state === "locked both" }, { locked: state !== "available" }] });
});

test.each(["plain", "legacy", "reordered", "missing Pro"])("probe admission preserves actual Extra High while Pro is unavailable (%s)", async scenario => {
  const names = scenario === "reordered" ? ["Instant", "Medium", "High", "Pro", "Extra High"]
    : scenario === "missing Pro" ? PLAIN_STOPS.slice(0, 4) : PLAIN_STOPS;
  const stops = scenario === "legacy" ? names.map(name => `6 ${name}`) : names;
  const picker = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6", stops,
    lockedStops: [scenario === "legacy" ? "6 Pro" : "Pro"] });
  const fixture = reasoningPicker();
  const snapshots: ChatGptEffortSnapshot[] = [];
  const capabilities = await detectChatGptAccountCapabilities(picker.pageOver(fixture) as never,
    { onEffortSnapshot: snapshot => { snapshots.push(snapshot); } });
  const route = requireChatGptWebModelRoute("chatgpt-web/extra-high", capabilities);
  expect(route.slug).toBe("chatgpt-web/extra-high");
  const workerCapabilities = { ...capabilities, localToolsEnabled: false };
  expect(resolveChatGptWebModelMode(route.backendModel, route.adapterEffort, workerCapabilities))
    .toMatchObject({ effort: "xhigh", displayLabel: "Extra High" });
  expect(snapshots).toHaveLength(1);
  expect(chatGptEffortTierAvailability(snapshots[0]!)).toEqual([true, true, true, true, false]);
  expect(availableChatGptWebModelRoutes(capabilities, chatGptEffortTierAvailability(snapshots[0]!)).map(model => model.slug))
    .toEqual(["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high"]);
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    route.backendModel, route.adapterEffort, workerCapabilities)).resolves.toMatchObject({ effort: "xhigh", displayLabel: "Extra High" });
  expect(picker.label()).toBe(scenario === "legacy" ? "6 Extra High" : "Extra High");
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    route.backendModel, "max", workerCapabilities))
    .rejects.toThrow(scenario === "missing Pro" ? 'no "6 Pro" stop' : '"6 Pro" stop is locked');
});

test.each(["missing", "locked"])("an available Pro never substitutes for unavailable Extra High (%s)", async state => {
  const picker = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6",
    stops: state === "missing" ? PLAIN_STOPS.filter(name => name !== "Extra High") : PLAIN_STOPS,
    lockedStops: state === "locked" ? ["Extra High"] : [] });
  const fixture = reasoningPicker();
  const snapshots: ChatGptEffortSnapshot[] = [];
  const capabilities = await detectChatGptAccountCapabilities(picker.pageOver(fixture) as never,
    { onEffortSnapshot: snapshot => { snapshots.push(snapshot); } });
  const route = requireChatGptWebModelRoute("chatgpt-web/extra-high", capabilities);
  const workerCapabilities = { ...capabilities, localToolsEnabled: false };
  expect(resolveChatGptWebModelMode(route.backendModel, route.adapterEffort, workerCapabilities).effort).toBe("xhigh");
  expect(chatGptEffortTierAvailability(snapshots[0]!)).toEqual([true, true, true, false, true]);
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    route.backendModel, route.adapterEffort, workerCapabilities))
    .rejects.toThrow(state === "missing" ? 'no "6 Extra High" stop' : '"6 Extra High" stop is locked');
});

test.each(["locked Instant", "missing Instant", "already Pro"])("Pro capability does not require an unrelated effort (%s)", async scenario => {
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6",
    stops: scenario === "missing Instant" ? PLAIN_STOPS.filter(label => label !== "Instant") : PLAIN_STOPS,
    lockedStops: scenario === "locked Instant" ? ["Instant"] : [] });
  if (scenario === "already Pro") picker.state.value = 4;
  const snapshots: unknown[] = [];
  await expect(detectChatGptAccountCapabilities(picker.pageOver(reasoningPicker()) as never,
    { onEffortSnapshot: snapshot => { snapshots.push(snapshot); } }))
    .resolves.toEqual({ solAvailable: true, proAvailable: true });
  expect(picker.state.chosen).toBe("GPT-6");
  expect(picker.label()).toBe("Pro");
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ ticks: [{ locked: scenario !== "already Pro" }, { locked: false }, { locked: false }, { locked: false }, { locked: false }] });
});

test.each([
  ["plain", "high", "High", "already"], ["plain", "high", "High", "after step"],
  ["plain", "max", "Pro", "already"], ["plain", "max", "Pro", "after step"],
  ["legacy", "high", "High", "already"], ["legacy", "high", "High", "after step"],
  ["legacy", "max", "Pro", "already"], ["legacy", "max", "Pro", "after step"],
] as const)("duplicate requested effort rejects a %s %s turn (%s, %s)", async (style, effort, label, start) => {
  const fixture = reasoningPicker();
  const labels = label === "High" ? ["Instant", "Medium", "High", "High", "Pro"] : ["Instant", "Medium", "High", "Pro", "Pro"];
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6",
    stops: style === "legacy" ? labels.map(name => `6 ${name}`) : labels });
  picker.state.value = start === "after step" ? 0 : label === "High" ? 3 : 4;
  const operation = selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", effort, { localToolsEnabled: false, solAvailable: true, proAvailable: true });
  await expect(operation).rejects.toMatchObject({ code: "chatgpt_model_pick_failed", retryable: false });
  await expect(operation).rejects.toThrow(`has 2 "6 ${label}" stops`);
});

test.each(["plain", "legacy"])("duplicate requested Pro cannot advertise capability or cache (%s)", async style => {
  const labels = ["Instant", "Medium", "High", "Pro", "Pro"];
  const picker = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6",
    stops: style === "legacy" ? labels.map(name => `6 ${name}`) : labels });
  picker.state.value = 4;
  const snapshots: unknown[] = [];
  await expect(detectChatGptAccountCapabilities(picker.pageOver(reasoningPicker()) as never,
    { onEffortSnapshot: snapshot => { snapshots.push(snapshot); } })).rejects.toThrow('has 2 "6 Pro" stops');
  expect(snapshots).toEqual([]);
});

test("a unique High tolerates unrelated duplicate Pro but suppresses ambiguous semantic cache", async () => {
  const fixture = reasoningPicker();
  const picker = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6",
    stops: ["Instant", "Medium", "High", "Pro", "Pro"] });
  picker.state.value = 4;
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", "high", { localToolsEnabled: false, solAvailable: true, proAvailable: true }))
    .resolves.toMatchObject({ effort: "high", displayLabel: "High" });
  expect(picker.state.keys.length).toBeLessThanOrEqual(24);
  picker.state.keys.length = 0;
  picker.state.value = 4;
  const selected = await selectChatGptPickerStop(picker.menu as never, picker.slider as never, "6 High", 50);
  expect(selected.effortSnapshot).toBeUndefined();
  expect(picker.label()).toBe("High");
  expect(picker.state.keys.length).toBeLessThanOrEqual(12);
});

test("a range beyond five positions is never scanned for an effort", async () => {
  const picker = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6", stops: [...PLAIN_STOPS, "Pro"] });
  await expect(selectChatGptPickerStop(picker.menu as never, picker.slider as never, "6 High", 50)).rejects.toThrow("did not settle");
  expect(picker.state.keys).toEqual([]);
});

test("a semantic stop changing on revisit fails instead of overwriting its observation", async () => {
  const fixture = reasoningPicker();
  const labels = [...PLAIN_STOPS];
  let changed = false;
  const picker = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6", stops: labels,
    afterKey: () => { if (!changed) { labels[3] = "Medium"; changed = true; } } });
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", "high", { localToolsEnabled: false, solAvailable: true, proAvailable: true }))
    .rejects.toThrow("changed a stop's meaning");
});

test("a duplicate High introduced during diagnostics is rejected before submission", async () => {
  const fixture = reasoningPicker();
  const labels = [...PLAIN_STOPS];
  const picker = modelListPicker({ plan: "team", models: ["GPT-6"], defaultModel: "GPT-6", stops: labels });
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", "high", { localToolsEnabled: false, solAvailable: true, proAvailable: true }, async (checkpoint: string) => {
      if (checkpoint === "effort-selected") labels[3] = "High";
    })).rejects.toThrow('has 2 "6 High" stops');
});

test('the current "GPT-6" row is selected exactly and a High turn verifies "6 High"', async () => {
  const fixture = reasoningPicker();
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6",
    stops: ["6 Instant", "6 Medium", "6 High", "6 Extra High", "6 Pro"] });
  const pressed: string[] = [];
  await selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture, pressed),
    "gpt-5.6-sol", "high", { localToolsEnabled: false, solAvailable: true, proAvailable: true });
  expect(picker.state.clicks).toEqual(["header", "GPT-6"]);
  expect(picker.state.chosen).toBe("GPT-6");
  expect(picker.label()).toBe("6 High");
  expect(fixture.keys).toEqual([]);
  expect(pressed).toEqual(["Escape"]);
});

test('the current "GPT-6" row cannot substitute another effort for a missing "6 High"', async () => {
  const fixture = reasoningPicker();
  const picker = modelListPicker({ plan: "team", models: ["GPT-6", "GPT-5.6 Sol"], defaultModel: "GPT-6",
    stops: ["6 Instant", "6 Medium", "6 Extra High", "6 Pro"] });
  await expect(selectModelAndEffort.call({ activeComposer: async () => fixture.composer }, picker.pageOver(fixture),
    "gpt-5.6-sol", "high", { localToolsEnabled: false, solAvailable: true, proAvailable: true }))
    .rejects.toMatchObject({ code: "chatgpt_model_pick_failed", retryable: false });
  expect(picker.state.chosen).toBe("GPT-6");
  expect(picker.state.clicks).toEqual(["header", "GPT-6"]);
  expect(picker.label()).not.toBe("6 High");
});

test.each([
  ["team", "max", "6", "6 Pro"],
  ["team", "xhigh", "6", "6 Extra High"],
  ["team", "low", "6", "6 Instant"],
  ["team", "medium", "6", "6 Medium"],
  ["team", "high", "6", "6 High"],
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
