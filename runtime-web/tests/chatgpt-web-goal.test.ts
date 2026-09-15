import { describe, expect, test } from "bun:test";
import {
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";

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
});
