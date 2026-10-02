import { expect, test } from "bun:test";
import {
  OLD_TOOL_RESULT_CHAR_LIMIT,
  RECENT_TOOL_RESULTS_KEPT_WHOLE,
  withTrimmedOldToolResults,
} from "../src/adapters/chatgpt-web/prompt-budget";
import { chatGptConversationKey, retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

function toolResult(index: number, text: string): CodexMessage {
  return { role: "toolResult", toolCallId: `call-${index}`, toolName: "shell", content: text, isError: false, timestamp: index };
}

test("old large tool outputs keep their start and end; recent and small ones stay whole", () => {
  const big = `${"A".repeat(3_000)}${"M".repeat(20_000)}${"Z".repeat(1_500)}`;
  const messages: CodexMessage[] = [
    { role: "user", content: "fix it", timestamp: 0 },
    toolResult(1, big),
    toolResult(2, "small"),
    ...Array.from({ length: RECENT_TOOL_RESULTS_KEPT_WHOLE }, (_, index) => toolResult(index + 3, big)),
  ];
  const trimmed = withTrimmedOldToolResults(messages);
  const oldest = trimmed[1] as { content: string };
  expect(oldest.content.length).toBeLessThan(OLD_TOOL_RESULT_CHAR_LIMIT + 200);
  expect(oldest.content.startsWith("A".repeat(2_500))).toBe(true);
  expect(oldest.content.endsWith("Z".repeat(1_000))).toBe(true);
  expect(oldest.content).toContain("characters of this earlier tool output omitted");
  expect(trimmed[2]).toBe(messages[2]!);
  for (let index = 3; index < trimmed.length; index += 1) expect(trimmed[index]).toBe(messages[index]!);
  expect(messages[1]).toEqual(toolResult(1, big));
});

test("image parts of old tool results are kept; history without big outputs is returned as is", () => {
  const parts: CodexMessage = { role: "toolResult", toolCallId: "c", toolName: "view_image", isError: false, timestamp: 0,
    content: [{ type: "image", imageUrl: "data:image/png;base64,AAAA" }, { type: "text", text: "x".repeat(10_000) }] };
  const messages = [parts, ...Array.from({ length: RECENT_TOOL_RESULTS_KEPT_WHOLE }, (_, index) => toolResult(index, "ok"))];
  const [first] = withTrimmedOldToolResults(messages) as unknown as [{ content: Array<{ type: string; text?: string; imageUrl?: string }> }];
  expect(first.content[0]).toEqual({ type: "image", imageUrl: "data:image/png;base64,AAAA" });
  expect(first.content[1]!.text!.length).toBeLessThan(OLD_TOOL_RESULT_CHAR_LIMIT + 200);
  const quiet = [toolResult(1, "ok"), toolResult(2, "fine")];
  expect(withTrimmedOldToolResults(quiet)).toBe(quiet);
});

function parsedRequest(systemPrompt: string[], messages: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/high",
    options: { reasoning: "high" },
    context: { systemPrompt, messages },
    _rawBody: { input: [], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-1", turn_id: "turn-1" }) } },
  } as unknown as CodexParsedRequest;
}

test("a retained follow-up omits the Codex instructions, and changed instructions start a new conversation", () => {
  const history: CodexMessage[] = [
    { role: "user", content: "first", timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1 },
    { role: "user", content: "next", timestamp: 2 },
  ];
  const resume = retainedConversationResumeRequest(parsedRequest(["long codex instructions"], history))!;
  expect(resume.context.systemPrompt).toBeUndefined();
  expect(resume.context.messages).toEqual([history[2]!]);
  const key = (instructions: string[]) => chatGptConversationKey(parsedRequest(instructions, history), "ns");
  expect(key(["same"])).toBeString();
  expect(key(["same"])).toBe(key(["same"]));
  expect(key(["changed"])).not.toBe(key(["same"]));
});
