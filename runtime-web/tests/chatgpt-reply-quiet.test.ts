import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHATGPT_COMPLETION_SETTLE_MS,
  CHATGPT_REPLY_QUIET_READS,
  CHATGPT_REPLY_QUIET_WAIT_MS,
  chatGptQuietReads,
  type ChatGptReplyRead,
} from "../src/adapters/chatgpt-web/browser-worker";

const read = (change: Partial<ChatGptReplyRead> = {}): ChatGptReplyRead => ({
  running: true, text: "Thinking", rich: "", action: false, progress: 3, ...change,
});

test("a running reply that stays the same counts as quiet, read after read", () => {
  let quiet = chatGptQuietReads(0, undefined, read());
  expect(quiet).toBe(0);
  for (let index = 1; index <= CHATGPT_REPLY_QUIET_READS; index += 1) {
    quiet = chatGptQuietReads(quiet, read(), read());
    expect(quiet).toBe(index);
  }
});

test("any change in the reply or its tool progress resets the quiet count", () => {
  for (const change of [{ text: "Thinking." }, { rich: "table" }, { action: true }, { progress: 4 }, { running: false }]) {
    expect(chatGptQuietReads(9, read(), read(change))).toBe(0);
  }
  // A reply that just started running again is not quiet yet.
  expect(chatGptQuietReads(9, read({ running: false }), read())).toBe(0);
});

test("a stopped reply keeps full-rate reads, so completion is never delayed", () => {
  const stopped = read({ running: false, text: "Done." });
  expect(chatGptQuietReads(9, stopped, stopped)).toBe(0);
  // Backing off at most this long can never outlast the settle window a stopped reply needs.
  expect(CHATGPT_REPLY_QUIET_WAIT_MS).toBeLessThan(CHATGPT_COMPLETION_SETTLE_MS);
});

test("the reply loop waits for a page or tool change only after quiet reads, bounded and without failing the turn", () => {
  const source = readFileSync(join(import.meta.dir, "../src/adapters/chatgpt-web/browser-worker.ts"), "utf8");
  const loop = source.slice(source.indexOf("let lastRead: ChatGptReplyRead | undefined;"), source.indexOf("tolerated internal observation fault"));
  expect(loop).toContain("quietReads = chatGptQuietReads(quietReads, lastRead, read);");
  expect(loop).toMatch(/if \(quietReads >= CHATGPT_REPLY_QUIET_READS && !page\.isClosed\(\)\) \{/);
  expect(loop).toMatch(/this\.waitForTurnDomOrExternalProgress\([\s\S]*?CHATGPT_REPLY_QUIET_WAIT_MS,\s*\)\.catch\(\(\) => undefined\)/);
  expect(loop).toContain("setTimeout(resolveQuiet, CHATGPT_REPLY_QUIET_WAIT_MS + 250)");
});
