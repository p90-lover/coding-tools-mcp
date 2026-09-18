import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

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
  const sliderContainer = {
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
      activationClicks += 1;
      menuOpen = true;
    },
    dispatchEvent: async () => {
      throw new Error("the ready effort control must not require pointerdown fallback");
    },
  };
  const composerForm = {
    locator: () => effortControl,
  };
  const composer = {
    locator: () => composerForm,
  };
  let escapePresses = 0;
  const page = {
    locator: (selector: string) => {
      if (selector === '[role="dialog"]' || selector === '[role="alert"], [role="dialog"]') {
        return hiddenSurface;
      }
      if (selector === '[id="effort-menu"]') return effortMenu;
      if (selector === '[data-model-reasoning-effort-slider]') return sliderContainer;
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
  }, page, "gpt-5.6-sol", "high", {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: true,
  });
  const elapsedMs = performance.now() - startedAt;

  expect(mode).toMatchObject({ displayLabel: "High", uiEffortIndex: 2 });
  expect(activationClicks).toBe(1);
  expect(escapePresses).toBe(1);
  expect(menuOpen).toBeFalse();
  // The fake page performs no I/O. Crossing this bound means model selection inserted a fixed wait.
  expect(elapsedMs).toBeLessThan(200);
});
