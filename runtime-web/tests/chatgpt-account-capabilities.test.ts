import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_CAPABILITY_CACHE_TTL_MS,
  chatGptCapabilityCachePath,
  chatGptEffortTierAvailability,
  freshChatGptEffortTiers,
  parseChatGptEffortTicks,
  readFreshChatGptCapabilityCache,
  recordChatGptEffortSnapshot,
} from "../src/chatgpt-account-capabilities";
import { recordChatGptEffortSnapshotInPassing } from "../src/adapters/chatgpt-web/browser-worker";
import { readChatGptEffortSnapshot } from "../src/chatgpt-session";
import { CHATGPT_WEB_LUNA_MODEL_ROUTES, CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { routerWebModelCatalog } from "../src/router-web-ingress";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cachePath = () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-capability-cache-"));
  roots.push(root);
  return chatGptCapabilityCachePath(root);
};
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const PLUS = parseChatGptEffortTicks(["false", "false", "false", "true"], 4)!;
const PRO = parseChatGptEffortTicks(["false", "false", "false", "false", "false"], 5)!;

test("tick locks map by slider index, with 4 and 5 positions", () => {
  // Captured Plus picker: a fourth, locked position is the Pro upsell, not Extra High access.
  expect(chatGptEffortTierAvailability(PLUS)).toEqual([true, true, true, false, false]);
  expect(chatGptEffortTierAvailability(PRO)).toEqual([true, true, true, true, true]);
  expect(chatGptEffortTierAvailability(parseChatGptEffortTicks(["false", "false", "false", "false"], 4)!))
    .toEqual([true, true, true, true, false]);
  expect(chatGptEffortTierAvailability(parseChatGptEffortTicks(["false", "false", "false", "false", "true"], 5)!))
    .toEqual([true, true, true, true, false]);
});

test("only an exact and complete tick reading is accepted", () => {
  expect(parseChatGptEffortTicks([], 4)).toBeUndefined();
  expect(parseChatGptEffortTicks(["false", "false", "false"], 4)).toBeUndefined();
  expect(parseChatGptEffortTicks(["false", "false", "false", null], 4)).toBeUndefined();
  expect(parseChatGptEffortTicks(["false", "false", "false", "unknown"], 4)).toBeUndefined();
  expect(parseChatGptEffortTicks(Array(6).fill("false"), 6)).toBeUndefined();
  expect(parseChatGptEffortTicks(["false"], 1)).toEqual({ ticks: [{ locked: false }] });
});

test("the slider reading uses ticks only, never the slider root, and never moves it", async () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const read = (locks: Array<string | null>) => {
    // The root and its wrapper carry data-locked too; only ticks also carry data-selected.
    const document = createDocument(`<div data-model-reasoning-effort-slider data-locked="false">
      <span data-locked="false">${locks.map((lock, index) =>
        `<span data-selected="${index === 0}"${lock === null ? "" : ` data-locked="${lock}"`}></span>`).join("")}
      </span></div>`);
    const container = {
      evaluate: async (fn: (element: Element) => unknown) => fn(document.querySelector("[data-model-reasoning-effort-slider]")!),
    };
    return readChatGptEffortSnapshot(container as never, { min: 0, max: locks.length - 1, value: 0 });
  };
  expect(await read(["false", "false", "false", "true"])).toEqual(PLUS);
  expect(await read(["false", "false", "false", "false", "false"])).toEqual(PRO);
  expect(await read(["false", "false", "false", null])).toBeUndefined();
});

test("the cache is fresh for 24 hours and ignores stale, future and corrupt files", () => {
  const path = cachePath();
  expect(readFreshChatGptCapabilityCache(NOW, path)).toBeUndefined();
  expect(recordChatGptEffortSnapshot(PLUS, NOW, path)).toBeTrue();
  expect(readFreshChatGptCapabilityCache(NOW, path)).toEqual({
    detectedAt: new Date(NOW).toISOString(),
    ticks: PLUS.ticks,
    extraHighAvailable: false,
    proAvailable: false,
  });
  expect(freshChatGptEffortTiers(NOW + CHATGPT_CAPABILITY_CACHE_TTL_MS, path)).toEqual([true, true, true, false, false]);
  expect(freshChatGptEffortTiers(NOW + CHATGPT_CAPABILITY_CACHE_TTL_MS + 1, path)).toBeUndefined();
  expect(freshChatGptEffortTiers(NOW - 60 * 60 * 1000, path)).toBeUndefined();

  for (const corrupt of [
    "{not json",
    JSON.stringify({ detectedAt: "yesterday", ticks: PLUS.ticks }),
    JSON.stringify({ detectedAt: new Date(NOW).toISOString(), ticks: [{ locked: "no" }] }),
    JSON.stringify({ detectedAt: new Date(NOW).toISOString(), ticks: [] }),
    JSON.stringify([]),
  ]) {
    writeFileSync(path, corrupt);
    expect(freshChatGptEffortTiers(NOW, path)).toBeUndefined();
  }
});

test("passive detection writes only when the ticks change, or to refresh an old reading", () => {
  const path = cachePath();
  expect(recordChatGptEffortSnapshot(PLUS, NOW, path)).toBeTrue();
  const firstWrite = statSync(path).mtimeMs;
  expect(recordChatGptEffortSnapshot(PLUS, NOW + 60_000, path)).toBeFalse();
  expect(recordChatGptEffortSnapshot(PLUS, NOW + 11 * 60 * 60 * 1000, path)).toBeFalse();
  expect(statSync(path).mtimeMs).toBe(firstWrite);
  expect(JSON.parse(readFileSync(path, "utf8")).detectedAt).toBe(new Date(NOW).toISOString());
  // A daily user keeps the reading fresh without a write per turn.
  expect(recordChatGptEffortSnapshot(PLUS, NOW + 13 * 60 * 60 * 1000, path)).toBeTrue();
  // A plan change is written at once.
  expect(recordChatGptEffortSnapshot(PRO, NOW + 13 * 60 * 60 * 1000 + 1, path)).toBeTrue();
  expect(readFreshChatGptCapabilityCache(NOW + 14 * 60 * 60 * 1000, path)?.proAvailable).toBeTrue();
});

test("the in-turn reading is best effort and records what the slider showed", async () => {
  const recorded: unknown[] = [];
  const container = {
    evaluate: async () => ["false", "false", "false", "true"],
  };
  await recordChatGptEffortSnapshotInPassing(container as never, { min: 0, max: 3, value: 2 }, snapshot => {
    recorded.push(snapshot);
    return true;
  });
  expect(recorded).toEqual([PLUS]);
  // A failed read or write never reaches the turn.
  await recordChatGptEffortSnapshotInPassing({ evaluate: async () => { throw new Error("detached"); } } as never,
    { min: 0, max: 3, value: 2 }, () => { throw new Error("must not record"); });
  await recordChatGptEffortSnapshotInPassing(container as never, { min: 0, max: 3, value: 2 }, () => {
    throw new Error("disk full");
  });
  // A reading that does not match the ARIA range is not recorded.
  await recordChatGptEffortSnapshotInPassing(container as never, { min: 0, max: 4, value: 2 }, () => {
    throw new Error("must not record");
  });
});

function nativeCatalog(): Record<string, unknown> {
  return {
    models: [{
      slug: "gpt-5.6-sol",
      visibility: "list",
      tool_mode: "code_mode_only",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
    }],
  };
}
const webSlugs = (catalog: Record<string, unknown>) => (catalog.models as Array<{ slug: string }>)
  .map(model => model.slug)
  .filter(slug => slug.startsWith("chatgpt-web/"));

test("the model list follows a fresh reading and otherwise keeps the static list", () => {
  const config = defaultConfig("full");
  const all = CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug);
  expect(webSlugs(augmentNativeModelCatalog(nativeCatalog(), config))).toEqual(all);
  expect(webSlugs(augmentNativeModelCatalog(nativeCatalog(), config, undefined, chatGptEffortTierAvailability(PLUS))))
    .toEqual(["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high"]);
  expect(webSlugs(augmentNativeModelCatalog(nativeCatalog(), config, undefined, chatGptEffortTierAvailability(PRO))))
    .toEqual(all);
  // A reading that hides Instant is not plausible and leaves the static list.
  expect(webSlugs(augmentNativeModelCatalog(nativeCatalog(), config, undefined, [false, true, true, false, false])))
    .toEqual(all);
  // Luna-only and Zero Risk accounts keep their own lists.
  config.solAvailable = false;
  expect(webSlugs(augmentNativeModelCatalog(nativeCatalog(), config, undefined, chatGptEffortTierAvailability(PRO))))
    .toEqual(CHATGPT_WEB_LUNA_MODEL_ROUTES.map(route => route.slug));

  const router = defaultConfig("full");
  expect(routerWebModelCatalog(router, chatGptEffortTierAvailability(PLUS)).data.map(entry => entry.id))
    .toEqual(["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high"]);
  expect(routerWebModelCatalog(router).data.map(entry => entry.id)).toEqual(all);
});
