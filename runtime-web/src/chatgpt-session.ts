import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";
import { parseChatGptEffortTicks, type ChatGptEffortSnapshot } from "./chatgpt-account-capabilities";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_SAVED_CHAT_URL = "https://chatgpt.com/";
/** A saved conversation's own page; only these may be continued by a retained turn. */
export const CHATGPT_SAVED_CONVERSATION_PATH = /^\/c\/[0-9a-f-]{36}$/;

/** ChatGPT refuses connectors in Temporary Chat, so task turns default to a saved new chat. */
export function chatGptNewChatUrl(useSavedChats: boolean): string {
  return useSavedChats ? CHATGPT_SAVED_CHAT_URL : CHATGPT_TEMPORARY_CHAT_URL;
}
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="textbox"]',
  'textarea[name="prompt-textarea"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  // The current picker's trigger; unlike its aria-label, this attribute is not translated.
  'button[data-codex-intelligence-trigger="true"][aria-haspopup="menu"]',
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  'button[aria-label="Select ChatGPT model"][aria-haspopup="menu"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = '[data-model-reasoning-effort-slider], [data-model-picker-power-slider]';
export const CHATGPT_EFFORT_SLIDER_SELECTOR = '[data-model-reasoning-effort-slider] [role="slider"], [data-model-picker-power-slider] [role="slider"]';
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
/** The picker's header row ("6 Sol · 6 High ›"): it swaps the Power slider for the model list. */
export const CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR = "[data-model-picker-view-toggle]";
/**
 * GPT-6's row in ChatGPT's model list, by plan: "GPT-6 Sol" on Plus, "6" on Team and Pro (both seen
 * live 2026-10-29). Every other model is billed on top (Codex quota or money), so turns run on GPT-6
 * only. On Plus "Default" the Power slider walks across models; with GPT-6 chosen it only sets
 * GPT-6's own effort: 3 stops on Plus (up to 6 High), 5 on Team (6 Instant, Medium, High, Extra High, Pro).
 */
export const CHATGPT_TURN_MODEL_NAMES: readonly string[] = ["GPT-6 Sol", "6"];
/** Every stop of GPT-6's own slider is labelled "6 <effort>" ("6 Extra High, 4 of 5."). */
export const CHATGPT_TURN_STOP_PREFIX = "6";
const MODEL_PICK_STEP_TIMEOUT_MS = 10_000;
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"], form button[aria-label="Stop"]';
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"], .turn-action-controls button[aria-label="Copy"]';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  // The exchange exists when the user's prompt mounts; require its assistant subtree,
  // including an empty reasoning shell or a rich-only reply.
  '[data-turn-key]:has([data-conversation-role="assistant"])',
  '[data-turn-key]:has([data-message-author-role="assistant"])',
  '[data-turn-key]:has([data-markdown-text-style="assistant-message"])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
  '[data-turn-key]:has([data-user-message-bubble])',
].join(", ");

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

export interface ChatGptEffortActivation {
  method: "already-open" | "click" | "pointerdown";
  menu: Locator;
  sliderContainer: Locator;
  slider: Locator;
}

export function chatGptEffortSlider(page: Page): { sliderContainer: Locator; slider: Locator } {
  const sliderContainer = page.locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR).filter({ visible: true }).last();
  // The current picker keeps ARIA values on a zero-width, aria-hidden semantic input.
  // Its visible container proves the active surface; the input proves the effort range.
  return { sliderContainer, slider: sliderContainer.locator('[role="slider"]') };
}

function effortMenuSelectorForId(menuId: string): string {
  return `[id=${JSON.stringify(menuId)}]`;
}

export async function chatGptEffortMenuForControl(page: Page, control: Locator): Promise<Locator> {
  const menuId = await control.getAttribute("aria-controls").catch(() => null);
  if (menuId) return page.locator(effortMenuSelectorForId(menuId));
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
}

async function visibleEffortSurface(
  page: Page,
  control: Locator,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  // The exit animation keeps a closed menu's slider visible after Escape. Read the
  // owner state first: selecting that outgoing range races its removal from the DOM.
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "false" || state === "closed") return undefined;
  const menu = await chatGptEffortMenuForControl(page, control);
  const surface = chatGptEffortSlider(page);
  if (await menu.isVisible().catch(() => false) || await surface.sliderContainer.isVisible().catch(() => false)) {
    return { menu, ...surface };
  }
  return undefined;
}

async function waitForEffortSurface(
  page: Page,
  control: Locator,
  timeoutMs: number,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const surface = await visibleEffortSurface(page, control);
    if (surface) return surface;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
  } while (true);
}

async function clearGhostEffortState(page: Page, control: Locator): Promise<void> {
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "true" || state === "open") {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export async function activateChatGptEffortMenu(
  page: Page,
  control: Locator,
  options: { settleMs?: number } = {},
): Promise<ChatGptEffortActivation> {
  const openSurface = await visibleEffortSurface(page, control);
  if (openSurface) return { method: "already-open", ...openSurface };

  const settleMs = options.settleMs ?? 3_000;
  await clearGhostEffortState(page, control);
  await control.click({ force: true, timeout: Math.max(1, settleMs) });
  const clickedSurface = await waitForEffortSurface(page, control, settleMs);
  if (clickedSurface) return { method: "click", ...clickedSurface };

  await clearGhostEffortState(page, control);
  await control.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  const pointerSurface = await waitForEffortSurface(page, control, settleMs);
  if (pointerSurface) return { method: "pointerdown", ...pointerSurface };
  throw new Error(
    "ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown",
  );
}

/** Whether this open picker has a model list (its header row swaps to it). */
export async function chatGptPickerHasModelList(menu: Locator): Promise<boolean> {
  return await menu.locator(CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR).count() > 0;
}

async function waitForPickerState(
  menu: Locator,
  check: (root: Element, modelName: string) => boolean,
  modelName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await menu.evaluate(check, modelName).catch(() => false)) return true;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  return false;
}

/**
 * Picks GPT-6 in the open picker as a person would: the header row, then the first of `modelNames`
 * found in the list, matched by its exact name because the list's order and contents change by plan.
 * Each step is checked and any surprise throws, so a turn stops instead of running on a model it did
 * not pick. Returns the row's name. The slider is left for selectChatGptPickerStop.
 */
export async function selectChatGptModelFromList(
  menu: Locator,
  modelNames: readonly string[] = CHATGPT_TURN_MODEL_NAMES,
  timeoutMs: number = MODEL_PICK_STEP_TIMEOUT_MS,
): Promise<string> {
  const toggles = menu.locator(CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR).filter({ visible: true });
  const toggleCount = await toggles.count();
  if (toggleCount !== 1) throw new Error(`the model picker shows ${toggleCount} model header rows, not 1`);
  await toggles.click({ timeout: timeoutMs });
  const listShown = await waitForPickerState(
    menu,
    root => root.querySelector("[data-model-picker-view]")?.getAttribute("data-model-picker-view") === "advanced",
    "",
    timeoutMs,
  );
  if (!listShown) throw new Error("the model list did not open from the picker's header row");

  const rows = await menu.locator('[role="menuitemradio"]').evaluateAll(items => items.map(item => ({
    name: item.querySelector("[data-menu-row-content]")?.textContent?.trim() ?? "",
    // A locked or used-up model carries "Locked…" / "Usage limit reached" through aria-describedby.
    blocked: item.getAttribute("aria-disabled") === "true" || item.hasAttribute("aria-describedby"),
  })));
  let index: number | undefined;
  let modelName = "";
  for (const candidate of modelNames) {
    const matches = rows.flatMap((row, rowIndex) => (row.name === candidate ? [rowIndex] : []));
    if (matches.length > 1) {
      throw new Error(`the model list has ${matches.length} rows named "${candidate}" (rows: ${rows.map(row => row.name).join(", ")})`);
    }
    if (matches.length === 1) {
      index = matches[0]!;
      modelName = candidate;
      break;
    }
  }
  if (index === undefined) {
    throw new Error(`the model list has no row named ${modelNames.map(name => `"${name}"`).join(" or ")} (rows: ${rows.map(row => row.name).join(", ")})`);
  }
  if (rows[index]!.blocked) throw new Error(`"${modelName}" is locked or out of usage in the model list`);
  await menu.locator('[role="menuitemradio"]').nth(index).click({ timeout: timeoutMs });

  // Chosen: the picker returns to its slider view with only that row checked. data-explicit-model
  // is no proof: it stays "false" when the row is already the account's default ("6" on Team).
  const chosen = await waitForPickerState(menu, (root, name) => {
    const view = root.querySelector("[data-model-picker-view]")?.getAttribute("data-model-picker-view");
    const checked = Array.from(root.querySelectorAll('[role="menuitemradio"][aria-checked="true"]'),
      item => item.querySelector("[data-menu-row-content]")?.textContent?.trim());
    return view === "simple" && checked.length === 1 && checked[0] === name;
  }, modelName, timeoutMs);
  // The composer's label is no proof either: at Instant it reads "6 Instant", without the model's name.
  if (!chosen) throw new Error(`"${modelName}" did not become the picker's chosen model`);
  return modelName;
}

interface ChatGptPickerStop {
  min: number;
  max: number;
  value: number;
  label: string;
}

/** The slider's ARIA position and ChatGPT's status line for it ("6 High, 3 of 5."), when they agree. */
async function readChatGptPickerStop(menu: Locator): Promise<ChatGptPickerStop | undefined> {
  const raw = await menu.evaluate(root => ({
    min: root.querySelector('[data-model-picker-power-slider] [role="slider"]')?.getAttribute("aria-valuemin") ?? null,
    max: root.querySelector('[data-model-picker-power-slider] [role="slider"]')?.getAttribute("aria-valuemax") ?? null,
    value: root.querySelector('[data-model-picker-power-slider] [role="slider"]')?.getAttribute("aria-valuenow") ?? null,
    status: root.querySelector('[role="status"]')?.textContent?.trim() ?? "",
  })).catch(() => undefined);
  if (!raw) return undefined;
  const min = safeIntegerAttribute(raw.min);
  const max = safeIntegerAttribute(raw.max);
  const value = safeIntegerAttribute(raw.value);
  const status = /^(.+), (\d+) of (\d+)\.?$/.exec(raw.status);
  if (min === undefined || max === undefined || value === undefined || !status) return undefined;
  // The status line trails the thumb for a frame; a reading counts once both name the same stop.
  if (Number(status[2]) !== value - min + 1 || Number(status[3]) !== max - min + 1) return undefined;
  return { min, max, value, label: status[1]! };
}

/**
 * Moves the open picker's slider to the stop labelled exactly `label` ("6 High"), one key at a time,
 * reading ChatGPT's own status line at every stop. Positions differ by plan, and on Plus "Default"
 * the upper positions are other models, so a stop is only ever chosen by its label. Throws, leaving
 * the turn unsent, when the slider has no such stop or moves other than one stop per key.
 */
export async function selectChatGptPickerStop(
  menu: Locator,
  slider: Locator,
  label: string,
  timeoutMs: number = MODEL_PICK_STEP_TIMEOUT_MS,
): Promise<void> {
  const settled = async (accept: (stop: ChatGptPickerStop) => boolean): Promise<ChatGptPickerStop> => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const stop = await readChatGptPickerStop(menu);
      if (stop && accept(stop)) return stop;
      if (Date.now() >= deadline) throw new Error("the effort slider and its status line did not settle on one stop");
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
  };
  const control = slider.locator("xpath=ancestor::*[@role='menuitem'][1]");
  let stop = await settled(() => true);
  const step = async (key: "ArrowLeft" | "ArrowRight") => {
    const before = stop.value;
    await control.press(key, { timeout: timeoutMs });
    stop = await settled(next => next.value !== before);
    const expected = before + (key === "ArrowRight" ? 1 : -1);
    if (stop.value !== expected) throw new Error(`the effort slider moved from stop ${before} to ${stop.value} on one ${key}`);
  };
  if (stop.label === label) return;
  while (stop.value > stop.min) await step("ArrowLeft");
  const seen = [stop.label];
  while (stop.label !== label) {
    if (stop.value >= stop.max) throw new Error(`the effort slider has no "${label}" stop (stops: ${seen.join(", ")})`);
    await step("ArrowRight");
    seen.push(stop.label);
  }
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null,
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin);
  const max = safeIntegerAttribute(rawMax);
  const value = safeIntegerAttribute(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

/**
 * Which slider positions the account may choose, read without moving the slider. Only the ticks
 * carry both data-locked and data-selected (the slider root has data-locked too); a locked tick
 * is an upsell, not a choice. Undefined when the ticks do not match the ARIA range exactly.
 */
export async function readChatGptEffortSnapshot(
  sliderContainer: Locator,
  state: ChatGptEffortSliderState,
): Promise<ChatGptEffortSnapshot | undefined> {
  const locks = await sliderContainer.evaluate(container => Array.from(
    container.querySelectorAll("[data-locked][data-selected]"),
    tick => tick.getAttribute("data-locked"),
  ));
  return parseChatGptEffortTicks(locks, state.max - state.min + 1);
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(
    CHATGPT_COMPOSER_SELECTOR,
  );
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("temporary-chat") !== "true") {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

/**
 * A turn must start on an empty new chat of the configured kind. The saved-chat home has no
 * temporary-chat parameter at all; any /c/ path is an existing (possibly the user's) conversation.
 */
export async function assertNewChatPage(page: Page, useSavedChats: boolean): Promise<void> {
  const url = new URL(page.url());
  const temporaryParam = url.searchParams.get("temporary-chat");
  if (url.origin !== new URL(CHATGPT_SAVED_CHAT_URL).origin || url.pathname !== "/"
    || (useSavedChats ? temporaryParam !== null : temporaryParam !== "true")) {
    throw new Error(`ChatGPT left the new ${useSavedChats ? "saved" : "Temporary"} Chat surface (${page.url()})`);
  }
}

/** The /c/<uuid> path of a saved conversation page, or undefined for any other page. */
export function chatGptSavedConversationPath(pageUrl: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    if (url.origin !== new URL(CHATGPT_SAVED_CHAT_URL).origin) return undefined;
    return CHATGPT_SAVED_CONVERSATION_PATH.test(url.pathname) ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a retained turn may type into this page. A saved task chat lives on /c/<uuid> without
 * the temporary flag; a Temporary Chat keeps the flag, and losing it means the page now shows one
 * of the user's own saved conversations. The launcher separately pins the exact /c/ path.
 */
export function chatGptRetainedConversationPage(pageUrl: string, useSavedChats: boolean): boolean {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return false; }
  if (url.origin !== new URL(CHATGPT_SAVED_CHAT_URL).origin) return false;
  const temporary = url.searchParams.get("temporary-chat") === "true";
  return useSavedChats
    ? !url.searchParams.has("temporary-chat") && CHATGPT_SAVED_CONVERSATION_PATH.test(url.pathname)
    : temporary;
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: {
    selectorTimeoutMs?: number;
    stableAbsenceMs?: number;
    /** Receives the slider's tick reading; a failed reading never fails the probe. */
    onEffortSnapshot?: (snapshot: ChatGptEffortSnapshot) => void;
  } = {},
): Promise<ChatGptWebAccountCapabilities> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers.last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false);
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers.count().then(count => count === 1).catch(() => false);
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false);
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  try {
    const { menu, sliderContainer, slider } = await activateChatGptEffortMenu(page, effortButton);
    // The current picker: turns run on GPT-6, picked from its list as here. Its own slider has 3 stops
    // on Plus (up to 6 High) and 5 on Team and Pro (up to 6 Pro); a turn still checks each stop's label.
    // On Plus "Default" the slider spans models (6 stops), so it is only read after the pick.
    if (await chatGptPickerHasModelList(menu)) {
      try {
        await selectChatGptModelFromList(menu);
      } catch {
        return { solAvailable: true, proAvailable: false };
      }
      const gpt6 = parseChatGptEffortSliderState(
        await slider.getAttribute("aria-valuemin"),
        await slider.getAttribute("aria-valuemax"),
        await slider.getAttribute("aria-valuenow"),
      );
      return { solAvailable: true, proAvailable: gpt6 !== undefined && gpt6.max - gpt6.min + 1 >= 5 };
    }
    const timeout = options.selectorTimeoutMs ?? 70_000;
    // Model radio rows can hydrate before the effort control. They carry no evidence
    // of the account's reasoning range, so an absent slider must fail, not cache false.
    await sliderContainer.waitFor({ state: "visible", timeout });
    await slider.waitFor({ state: "attached", timeout });
    const state = parseChatGptEffortSliderState(
      await slider.getAttribute("aria-valuemin"),
      await slider.getAttribute("aria-valuemax"),
      await slider.getAttribute("aria-valuenow"),
    );
    if (!state) {
      throw new Error(
        "ChatGPT model controls are unavailable. Reload ChatGPT and run Repair again.",
        { cause: new Error("ChatGPT effort slider exposed an invalid ARIA range") },
      );
    }
    if (options.onEffortSnapshot) {
      try {
        const snapshot = await readChatGptEffortSnapshot(sliderContainer, state);
        if (snapshot) options.onEffortSnapshot(snapshot);
      } catch {
        // The tick reading only refreshes the model-list hint; the probe's own answer stands.
      }
    }
    const lockedAccess = await menu.getByText("Locked, opens access options", { exact: true }).count();
    return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5 && lockedAccess === 0 };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
