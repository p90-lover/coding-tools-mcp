import { expect, test } from "bun:test";
import {
  ChatGptVisibleTraceTracker,
  withChatGptToolBoundaryNarration,
  type ChatGptVisibleTraceBlock,
} from "../src/adapters/chatgpt-web/browser-worker";

// The redesigned agent turn as seen live (2026-10-20): a narration root becomes commentary only
// once a later step appears, and the whole group collapses to "Worked for …" when it finishes.
const status = (text: string): ChatGptVisibleTraceBlock => ({ kind: "status", text });
const commentary = (text: string): ChatGptVisibleTraceBlock => ({ kind: "commentary", text, complete: true });
const answer = (text: string): ChatGptVisibleTraceBlock => ({ kind: "answer", text });

test("narration still shown as the answer at a tool call is emitted once as commentary", () => {
  const tracker = new ChatGptVisibleTraceTracker(250);
  const observe = (blocks: ChatGptVisibleTraceBlock[], narration: string | undefined, now: number) => (
    tracker.observe(withChatGptToolBoundaryNarration(blocks, narration), false, now)
  );

  // ChatGPT wrote one sentence and called a tool; the sentence is still the last root.
  const atTool = [status("Inspecting Repository Structure"), answer("I will list the folder.")];
  expect(observe(atTool, "I will list the folder.", 0)).toEqual([]);
  expect(observe(atTool, "I will list the folder.", 300)).toEqual([
    { kind: "reasoning", text: "Inspecting Repository Structure" },
    { kind: "commentary", text: "I will list the folder." },
  ]);

  // The next step makes the DOM classify that root as commentary itself: no second copy.
  const nextStep = [commentary("I will list the folder."), status("Reviewing Git Log"), answer("Checking git next.")];
  expect(observe(nextStep, undefined, 600)).toEqual([]);
  expect(observe(nextStep, undefined, 900)).toEqual([{ kind: "reasoning", text: "Reviewing Git Log" }]);

  // The last sentence before the last tool call is caught at that tool call...
  expect(observe(nextStep, "Checking git next.", 1_000)).toEqual([]);
  expect(observe(nextStep, "Checking git next.", 1_300)).toEqual([
    { kind: "commentary", text: "Checking git next." },
  ]);
  // ...so the collapse into "Worked for 1m 15s" with only the final answer loses nothing.
  expect(observe([answer("Final summary")], undefined, 1_600)).toEqual([]);
});

test("tool-boundary narration is not added twice when the DOM already shows it as commentary", () => {
  const blocks = [commentary("Checking  git\nnext.")];
  expect(withChatGptToolBoundaryNarration(blocks, "Checking git next.")).toBe(blocks);
  expect(withChatGptToolBoundaryNarration(blocks, undefined)).toBe(blocks);
});
