import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  ChatGptBrowserDiagnostics,
  chatGptDiagnosticWarrantsPersistence,
} from "../src/adapters/chatgpt-web/browser-worker";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const page = {
  evaluate: async () => ({ composer: { visibleCount: 1, textChars: [0] } }),
} as unknown as Page;

const trail = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const [trace] = readdirSync(root);
  if (!trace) return [];
  return readdirSync(join(root, trace)).sort()
    .map(name => JSON.parse(readFileSync(join(root, trace, name), "utf8")).checkpoint as string);
};

test("a healthy chat turn keeps its diagnostic checkpoints in memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-diagnostics-ok-"));
  roots.push(root);
  const diagnostics = new ChatGptBrowserDiagnostics("healthy_turn", join(root, "browser-turns"), "Coding Tools", "on-failure");
  for (const checkpoint of ["browser-page-acquired", "send-accepted", "response-visible", "turn-completed"]) {
    await diagnostics.capture(page, checkpoint);
  }
  expect(existsSync(join(root, "browser-turns"))).toBe(false);
});

test("a failing chat turn writes the whole trail that led to the failure, then keeps writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-diagnostics-fail-"));
  roots.push(root);
  const diagnosticsRoot = join(root, "browser-turns");
  const diagnostics = new ChatGptBrowserDiagnostics("failing_turn", diagnosticsRoot, "Coding Tools", "on-failure");
  await diagnostics.capture(page, "browser-page-acquired");
  await diagnostics.capture(page, "send-accepted");
  expect(trail(diagnosticsRoot)).toEqual([]);
  await diagnostics.capture(page, "response-stalled-60s");
  await diagnostics.capture(page, "turn-failed", new Error("observation timed out"));
  expect(trail(diagnosticsRoot)).toEqual([
    "browser-page-acquired", "send-accepted", "response-stalled-60s", "turn-failed",
  ]);
});

test("checkpoints that persist a trail are failures, stalls, rebinds and errors only", () => {
  for (const checkpoint of ["turn-failed", "response-stalled-60s", "response-page-rebound", "submission-page-rebound"]) {
    expect(chatGptDiagnosticWarrantsPersistence(checkpoint)).toBe(true);
  }
  for (const checkpoint of ["send-accepted", "response-visible", "turn-completed", "compaction-handoff-accepted"]) {
    expect(chatGptDiagnosticWarrantsPersistence(checkpoint)).toBe(false);
  }
  expect(chatGptDiagnosticWarrantsPersistence("composer-ready", new Error("boom"))).toBe(true);
});
