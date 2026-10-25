import { describe, expect, test } from "bun:test";
import {
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

describe("native Codex /goal over ChatGPT Web", () => {
  test("keeps goal.internal_context as the current browser-turn instruction", () => {
    const goalText = [
      '<codex_internal_context source="goal">',
      "Objective: finish the active 0.7 implementation.",
      "Continue autonomously and audit completion before stopping.",
      "</codex_internal_context>",
    ].join("\n");
    const body = {
      model: "chatgpt-web/high",
      input: [{
        type: "message",
        role: "user",
        id: "goal-context-1",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-goal-1" },
        content_item_kinds: ["goal.internal_context"],
        content: [{ type: "input_text", text: goalText }],
      }],
      client_metadata: {
        "x-codex-turn-metadata": {
          thread_id: "thread-goal-1",
          turn_id: "turn-goal-1",
          request_kind: "turn",
        },
      },
      stream: true,
    };

    const parsed = parseRequest(body);

    expect(extractChatGptTurnIdentity(parsed)).toMatchObject({
      threadId: "thread-goal-1",
      turnId: "turn-goal-1",
    });
    expect(extractChatGptTurnUserRevision(parsed)).toEqual(body.input[0]!.content);
    expect(parsed.context.messages).toHaveLength(1);
    expect(parsed.context.messages[0]).toMatchObject({ role: "user", content: goalText });
    const raw = parsed._rawBody as typeof body;
    expect(raw.input[0]!.content_item_kinds).toEqual(["goal.internal_context"]);
  });

  test("a revised /goal makes the next browser model request replan instead of continuing the old objective", () => {
    const goal = (text: string, id: string) => ({
      type: "message", role: "user", id,
      internal_chat_message_metadata_passthrough: { turn_id: "turn-goal-2" },
      content_item_kinds: ["goal.internal_context"],
      content: [{ type: "input_text", text: `<codex_internal_context source="goal">\n${text}\n</codex_internal_context>` }],
    });
    const parsed = parseRequest({
      model: "chatgpt-web/high", stream: true,
      input: [goal("Old objective: finish A", "goal-old"), goal("New objective: do B instead", "goal-new")],
      client_metadata: { "x-codex-turn-metadata": { thread_id: "thread-goal-2", turn_id: "turn-goal-2" } },
    });
    parsed.modelId = CHATGPT_WEB_MODEL_ID;
    const compiled = compileChatGptWebPrompt(parsed,
      { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012");
    expect(extractChatGptTurnUserRevision(parsed)).toEqual([
      { type: "input_text", text: `<codex_internal_context source="goal">\nNew objective: do B instead\n</codex_internal_context>` },
    ]);
    expect(compiled.text).toContain("New objective: do B instead");
    expect(compiled.text).toContain("re-evaluate your existing plan against this latest goal");
    expect(compiled.text.indexOf("re-evaluate your existing plan")).toBeGreaterThan(compiled.text.indexOf("</codex_context_json>"));
  });

  test("normal instructions do not introduce a goal-change replan", () => {
    const parsed = parseRequest({ model: "chatgpt-web/high", input: [{
      type: "message", role: "user", id: "ordinary", content: [{ type: "input_text", text: "Do the task" }],
    }], stream: true });
    parsed.modelId = CHATGPT_WEB_MODEL_ID;
    const compiled = compileChatGptWebPrompt(parsed,
      { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012");
    expect(compiled.text).not.toContain("re-evaluate your existing plan against this latest goal");
  });
});
