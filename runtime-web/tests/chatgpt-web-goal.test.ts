import { describe, expect, test } from "bun:test";
import {
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt, compilePlainChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
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

  test("uses only the newest goal when a plain long-running turn receives multiple revisions", () => {
    const goal = (objective: string) => ({
      type: "message", role: "user",
      content_item_kinds: ["goal.internal_context"],
      content: [{ type: "input_text", text: `<codex_internal_context source="goal">\n${objective}\n</codex_internal_context>` }],
    });
    const parsed = parseRequest({
      model: "chatgpt-web/high", stream: true,
      input: [goal("Old goal: optimize task A"), goal("New goal: finish task B")],
    });
    const compiled = compilePlainChatGptWebPrompt(
      parsed.context.messages, "turn_12345678901234567890123456789012",
    );
    expect(compiled).toBeDefined();
    expect(compiled!.text).toContain("New goal: finish task B");
    expect(compiled!.text).not.toContain("Old goal: optimize task A");
    expect(compiled!.text).toContain("The latest native Codex /goal objective is authoritative");
    expect(compiled!.text).toContain("update_goal through codex_tool_call");
  });

  test("re-evaluates an edited goal after full context and keeps normal tasks unchanged", () => {
    const goal = (objective: string) => ({
      type: "message", role: "user",
      content_item_kinds: ["goal.internal_context"],
      content: [{ type: "input_text", text: `<codex_internal_context source="goal">\n${objective}\n</codex_internal_context>` }],
    });
    const parsed = parseRequest({
      model: "chatgpt-web/high", stream: true,
      input: [goal("First objective"), goal("Revised objective")],
    });
    parsed.modelId = CHATGPT_WEB_MODEL_ID;
    const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };
    const token = "turn_12345678901234567890123456789012";
    const prompt = compileChatGptWebPrompt(parsed, capabilities, token);
    expect(prompt.text).toContain("Revised objective");
    expect(prompt.text).toContain("The latest native Codex /goal objective is authoritative");
    expect(prompt.text.indexOf("The latest native Codex /goal objective")).toBeGreaterThan(
      prompt.text.indexOf("</codex_context_json>"),
    );
    const normal = parseRequest({
      model: "chatgpt-web/high", stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Ordinary task" }] }],
    });
    normal.modelId = CHATGPT_WEB_MODEL_ID;
    expect(compileChatGptWebPrompt(normal, capabilities, token).text)
      .not.toContain("The latest native Codex /goal objective is authoritative");
  });

});
