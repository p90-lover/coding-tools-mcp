import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR } from "../src/chatgpt-session";
import { CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR } from "../src/chatgpt-ui/model-picker";

test("an already-ready effort control has no unconditional pre-activation delay", async () => {
  const neverVisible = new Promise<void>(() => {});
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    waitFor: async () => await neverVisible,
    isVisible: async () => false,
  };
  const sliderControl = {
    press: async () => {
      throw new Error("the already-selected effort must not move");
    },
  };
  const slider = {
    waitFor: async () => {},
    getAttribute: async (name: string) => ({
      "aria-valuemin": "0",
      "aria-valuemax": "4",
      "aria-valuenow": "2",
    })[name] ?? null,
    locator: (selector: string) => {
      expect(selector).toBe("xpath=ancestor::*[@role='menuitem'][1]");
      return sliderControl;
    },
  };
  let menuOpen = false;
  let activationClicks = 0;
  let firstActivationAt: number | undefined;
  const sliderContainer = {
    // Five unlocked ticks (Instant through Pro). The passing tick read takes the array; the
    // availability read takes the range and locks from the same DOM revision.
    evaluate: async () => Object.assign(["false", "false", "false", "false", "false"],
      { min: "0", max: "4", value: "2", locks: ["false", "false", "false", "false", "false"] }),
    filter() { return this; },
    last() { return this; },
    isVisible: async () => menuOpen,
    waitFor: async () => {
      expect(menuOpen).toBeTrue();
    },
    locator: (selector: string) => {
      expect(selector).toBe('[role="slider"]');
      return slider;
    },
  };
  const effortMenu = {
    isVisible: async () => menuOpen,
    // The older picker: no model header row, so effort is set on its slider.
    locator: (selector: string) => {
      expect(selector).toBe(CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR);
      return { count: async () => 0 };
    },
  };
  const effortControl = {
    last() { return this; },
    waitFor: async () => {},
    getAttribute: async (name: string) => ({
      "aria-controls": "effort-menu",
      "aria-expanded": menuOpen ? "true" : "false",
      "data-state": menuOpen ? "open" : "closed",
    })[name] ?? null,
    click: async () => {
      firstActivationAt ??= performance.now();
      activationClicks += 1;
      menuOpen = true;
    },
    dispatchEvent: async () => {
      throw new Error("the ready effort control must not require pointerdown fallback");
    },
    filter: () => effortControl,
    first: () => effortControl,
    innerText: async () => "High",
  };
  const composerForm = {
    locator: () => effortControl,
  };
  const composer = {
    locator: () => composerForm,
  };
  let escapePresses = 0;
  const page = {
    url: () => "https://chatgpt.com/",
    locator: (selector: string) => {
      if (selector === '[role="dialog"]' || selector === '[role="alert"], [role="dialog"]') {
        return hiddenSurface;
      }
      if (selector === '[id="effort-menu"]') return effortMenu;
      // The worker accepts both the reasoning-effort slider and the newer model-picker power slider.
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return sliderContainer;
      throw new Error(`Unexpected locator: ${selector}`);
    },
    keyboard: {
      press: async (key: string) => {
        expect(key).toBe("Escape");
        escapePresses += 1;
        menuOpen = false;
      },
    },
  } as unknown as Page;
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: Page,
      modelId: string,
      reasoning: string,
      capabilities: { localToolsEnabled: boolean; solAvailable: boolean; proAvailable: boolean },
    ): Promise<{ displayLabel: string; uiEffortIndex: number | null }>;
  }).selectModelAndEffort;

  const startedAt = performance.now();
  const mode = await selectModelAndEffort.call({
    activeComposer: async () => composer,
    // Upstream re-reads the selected effort afterwards; this test times only the activation.
    assertSelectedEffort: async () => {},
  }, page, "gpt-5.6-sol", "high", {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: true,
  });
  // Upstream deliberately settles and reopens the menu after selecting to prove the choice
  // survived the commit; only the wait before the first activation must have no fixed delay.
  const elapsedMs = (firstActivationAt ?? Number.POSITIVE_INFINITY) - startedAt;

  expect(mode).toMatchObject({ displayLabel: "High", uiEffortIndex: 2 });
  // Upstream's model-family check may reopen the menu once to confirm an explicit GPT-5.6 row.
  expect(activationClicks).toBeGreaterThanOrEqual(1);
  expect(activationClicks).toBeLessThanOrEqual(2);
  expect(escapePresses).toBe(activationClicks); // every menu it opened is closed again
  expect(menuOpen).toBeFalse();
  // The fake page performs no I/O. Crossing this bound means model selection inserted a fixed wait.
  expect(elapsedMs).toBeLessThan(200);
});
