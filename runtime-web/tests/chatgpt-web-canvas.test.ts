import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { chromium, type BrowserContext, type Route } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { defaultChromeExecutable } from "../src/config";

const chrome = defaultChromeExecutable();
const browserTest = test.skipIf(!existsSync(chrome));

async function canvasFixture(run: (page: any, snapshot: () => Promise<any>, cache: { fullScans?: number; cacheHits?: number }) => Promise<void>) {
  const temporaryRoot = resolve(import.meta.dir, "../../aiTemp/rich-canvas-tests");
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, "canvas-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(join(directory, "profile"), { executablePath: chrome, headless: true });
    await context.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body:
      '<!doctype html><article id="owned"><div class="chart-widget-container" aria-label="Revenue">'
      + '<canvas width="64" height="32"></canvas></div><button data-testid="copy-turn-action-button">Copy</button></article>',
    }));
    const page = await context.newPage();
    await page.goto("https://chatgpt.com/c/owned-canvas-fixture");
    const cache: { fullScans?: number; cacheHits?: number } = {};
    const snapshot = () => (ChatGptBrowserWorker.prototype as any).responseDomSnapshot.call({}, page.locator("#owned"), cache);
    await run(page, snapshot, cache);
  } finally {
    await context?.close();
    if (!resolve(directory).startsWith(temporaryRoot + sep)) throw new Error("Unexpected canvas-test cleanup path");
    rmSync(directory, { recursive: true, force: true });
  }
}

browserTest("Chromium animated canvas needs fresh model generation and settles as a source view", async () => {
  await canvasFixture(async (page, snapshot, cache) => {
    const paint = (color: string) => page.locator("canvas").evaluate((canvas: HTMLCanvasElement, fill: string) => {
      const context = canvas.getContext("2d")!;
      context.fillStyle = fill;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, color);
    await paint("#111111");
    const before = await snapshot();
    const initialHtml = await page.locator("#owned").innerHTML();
    const beforeKey = before.richContentKey;
    await paint("#eeeeee");
    expect(await page.locator("#owned").innerHTML()).toBe(initialHtml);
    const after = await snapshot();
    expect(cache.fullScans).toBe(1);
    expect(cache.cacheHits).toBe(1);
    expect(after.richOutput).toEqual(before.richOutput);
    expect(after.richContentKey).toBe(beforeKey);
    expect(before.richContentKey).toBe(beforeKey);
    const state = { responsePresent: true, running: false, currentText: after.visibleText,
      currentRichContent: after.richContentKey, currentHtml: after.fullHtml, completionActionVisible: true,
      externalToolCallsInFlight: false };
    const oldReply = new ChatGptCompletionTracker(5, 10);
    oldReply.observeToolBatch(1, "");
    expect(oldReply.update(state, 0)).toBeFalse();
    await paint("#113355");
    expect(oldReply.update({ ...state, currentRichContent: (await snapshot()).richContentKey }, 5)).toBeFalse();
    await paint("#224466");
    expect(() => oldReply.update(state, 10)).toThrow(expect.objectContaining({ code: "browser_rich_preview_unreadable", retryable: false }));

    const animated = new ChatGptCompletionTracker(5, 10);
    for (const [index, color] of ["#223344", "#556677"].entries()) {
      await paint(color);
      const frame = await snapshot();
      expect(animated.update({ ...state, currentRichContent: frame.richContentKey }, index * 5)).toBe(index > 0);
    }
    const fresh = new ChatGptCompletionTracker(5, 10);
    fresh.observeToolBatch(1, "");
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="copy-turn-action-button"]')!.hidden = true;
      const stop = document.createElement("button");
      stop.dataset.testid = "stop-button";
      document.body.append(stop);
    });
    const generating = await snapshot();
    const running = await page.locator('[data-testid="stop-button"]').isVisible();
    expect(generating.completionActionVisible).toBeFalse();
    expect(fresh.update({ ...state, running, completionActionVisible: false, externalToolCallsInFlight: true }, 0)).toBeFalse();
    expect(fresh.update({ ...state, running, completionActionVisible: false }, 1)).toBeFalse();
    await page.evaluate(() => {
      document.querySelector('[data-testid="stop-button"]')!.remove();
      document.querySelector<HTMLElement>('[data-testid="copy-turn-action-button"]')!.hidden = false;
    });
    const completed = await snapshot();
    expect(completed.completionActionVisible).toBeTrue();
    expect(await page.locator('[data-testid="stop-button"]').isVisible()).toBeFalse();
    expect(fresh.update(state, 2)).toBeFalse();
    await paint("#778899");
    expect(fresh.update({ ...state, currentRichContent: (await snapshot()).richContentKey }, 7)).toBeTrue();
  });
}, 30_000);

browserTest("Chromium uninitialized and oversized canvases keep their own rendering context and source access", async () => {
  await canvasFixture(async (page, snapshot) => {
    const initial = await snapshot();
    expect(await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.getContext("bitmaprenderer") !== null)).toBeTrue();
    await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => { canvas.width = 4096; canvas.height = 1025; });
    const observed = await snapshot();
    expect(observed.richOutput).toEqual(initial.richOutput);
    expect(observed.visibleText).toBe("");
    const tracker = new ChatGptCompletionTracker(5, 10);
    tracker.observeToolBatch(1, "");
    const state = { responsePresent: true, running: false, currentText: "", currentRichContent: observed.richContentKey,
      completionActionVisible: true, externalToolCallsInFlight: false };
    expect(tracker.update(state, 0)).toBeFalse();
    expect(() => tracker.update(state, 10)).toThrow(expect.objectContaining({ code: "browser_rich_preview_unreadable", retryable: false }));
    expect(tracker.update({ ...state, running: true, completionActionVisible: false }, 11)).toBeFalse();
    expect(tracker.update(state, 12)).toBeFalse();
    expect(tracker.update(state, 17)).toBeTrue();
  });
}, 30_000);

browserTest("Chromium tainted canvas and changing widget frames do not block healthy prose", async () => {
  await canvasFixture(async (page, snapshot) => {
    await page.route("https://foreign.example/pixel.png", (route: Route) => route.fulfill({ status: 200, contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cqX8AAAAASUVORK5CYII=", "base64"),
    }));
    await page.locator("canvas").evaluate(async (canvas: HTMLCanvasElement) => {
      const image = new Image();
      image.src = "https://foreign.example/pixel.png";
      await image.decode();
      canvas.getContext("2d")!.drawImage(image, 0, 0);
    });
    const observed = await snapshot();
    expect(observed.richOutput.items).toEqual([{ kind: "chart", label: "Revenue" }]);
    await page.locator("#owned").evaluate((root: HTMLElement) => root.insertAdjacentHTML("afterbegin", '<div class="markdown"><p>Ready summary</p><div class="chart-widget-container"><svg><text>Frame 1</text></svg></div></div>'));
    const mixed = await snapshot();
    expect(mixed.visibleText).toBe("Ready summary");
    await page.locator(".markdown svg text").evaluate((text: SVGTextElement) => { text.textContent = "Frame 2"; });
    const changed = await snapshot();
    expect(changed.fullHtml).toBe(mixed.fullHtml);
    const tracker = new ChatGptCompletionTracker(5, 10);
    tracker.observeToolBatch(1, "");
    const state = { responsePresent: true, running: false, currentText: mixed.visibleText, currentRichContent: mixed.richContentKey,
      completionActionVisible: true, externalToolCallsInFlight: false };
    expect(tracker.update(state, 0)).toBeFalse();
    expect(tracker.update(state, 5)).toBeTrue();
  });
}, 30_000);
