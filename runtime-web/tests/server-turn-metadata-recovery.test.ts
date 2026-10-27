import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

const endpoint = "http://127.0.0.1:17841/v1/responses";
const header = { thread_id: "01a06c66-0000-7ae1-9108-69b5f70e0671", turn_id: "01a06c66-0000-7ae1-9108-69b5f70e0672" };

function send(metadata: unknown, bodyMetadata?: unknown, stream = false) {
  const requestBody: Record<string, unknown> = {
    model: "chatgpt-web/high", stream,
    input: [{ type: "message", role: "user", id: "msg_continue",
      content: [{ type: "input_text", text: "Continue this restored Codex task" }] }],
  };
  if (bodyMetadata !== undefined) requestBody.client_metadata = {
    "x-codex-turn-metadata": JSON.stringify(bodyMetadata),
  };
  const seen: unknown[] = [];
  const bound: unknown[] = [];
  const adapter = (): ProviderAdapter => ({ name: "header-identity-regression", async runTurn(parsed, _incoming, emit) {
    seen.push(extractChatGptTurnIdentity(parsed));
    emit({ type: "text_delta", text: "Part one. ", phase: "final_answer" });
    emit({ type: "text_delta", text: "Part two.", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } });
  return { seen, bound, response: responseRequest(new Request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify(metadata) },
    body: JSON.stringify(requestBody),
  }), defaultConfig("full"), adapter, { rememberState: false, onTurnIdentity: value => bound.push(value) }) };
}

test("a restored WebGPT turn recovers its identity from the header and keeps the full answer", async () => {
  const { response, seen, bound } = send(header);
  const result = await response;
  expect(result.status).toBe(200);
  expect(seen).toEqual([{ threadId: header.thread_id, turnId: header.turn_id }]);
  expect(bound).toEqual([{ threadId: header.thread_id, turnId: header.turn_id }]);
  const answer = await result.json() as { output: Array<{ type: string; content?: Array<{ text?: string }> }> };
  expect(JSON.stringify(answer.output)).toContain("Part one. Part two.");
});

test("partial saved metadata is filled by the matching native header", async () => {
  const { response, seen, bound } = send(header, { thread_id: header.thread_id });
  expect((await response).status).toBe(200);
  expect(seen).toEqual([{ threadId: header.thread_id, turnId: header.turn_id }]);
  expect(bound).toEqual([{ threadId: header.thread_id, turnId: header.turn_id }]);
});

test("conflicting or malformed metadata cannot silently rebind a saved Codex task", async () => {
  const conflict = send(header, { thread_id: "another-task", turn_id: header.turn_id });
  const response = await conflict.response;
  expect(response.status).toBe(400);
  expect(conflict.seen).toHaveLength(0);
  expect(conflict.bound).toHaveLength(0);
  expect(await response.text()).toContain("Conflicting Codex turn metadata");
  const malformed = send(["not", "metadata"]);
  expect((await malformed.response).status).toBe(400);
  expect(malformed.seen).toHaveLength(0);
});

test("streaming a restored WebGPT reply preserves both answer fragments", async () => {
  const { response, seen } = send(header, undefined, true);
  const result = await response;
  expect(result.status).toBe(200);
  const events = await result.text();
  expect(events).toContain("Part one. ");
  expect(events).toContain("Part two.");
  expect(seen).toHaveLength(1);
});
