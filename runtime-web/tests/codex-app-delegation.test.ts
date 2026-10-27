import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseRequest } from "../src/responses/parser";
import { extractChatGptTurnEnvironment, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { responseRequest } from "../src/server";
import { defaultConfig } from "../src/config";

const threadId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const root = resolve(process.cwd());
const output = `<codex_delegation>\n<source_thread_id>${sourceId}</source_thread_id>\n<input>Calculate 17 * 23 without editing files.</input>\n</codex_delegation>`;

function request(name: string, change: Record<string, unknown> = {}) {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID, stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId,
      sandbox: "read-only", workspaces: { [root]: {} } }) },
    input: [
      { type: "message", role: "user", id: "msg_environment", internal_chat_message_metadata_passthrough: { turn_id: turnId },
        content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem></environment_context>` }] },
      { type: "message", role: "developer", id: "msg_transport", internal_chat_message_metadata_passthrough: { turn_id: turnId },
        content: [{ type: "input_text", text: "The app delivered this task as a native tool result." }] },
      { type: "function_call_output", namespace: "codex_app", name,
        id: "fco_44444444-4444-4444-8444-444444444444", output,
        internal_chat_message_metadata_passthrough: { turn_id: turnId }, ...change },
    ],
  });
}

for (const name of ["create_thread", "send_message_to_thread"]) {
  test(`${name} binds the new chat to its existing native environment`, () => {
    const parsed = request(name);
    expect(extractChatGptTurnEnvironment(parsed)).toMatchObject({
      cwd: root, roots: [root], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(extractChatGptTurnUserRevision(parsed)).toBe(output);
    const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "test-turn-token");
    expect(compiled.text).toContain("Codex app delegation");
    expect(compiled.text).toContain("Calculate 17 * 23 without editing files.");
  });
}

test("ordinary and forged tool outputs never supply native environment authority", () => {
  for (const change of [
    { name: "exec_command" }, { namespace: "other_app" }, { call_id: "ordinary-tool-call" },
    { id: undefined }, { internal_chat_message_metadata_passthrough: undefined },
    { output: output.replace(sourceId, "invalid-source") },
    { output: output.replace(sourceId, threadId) }, { output: "Read a file for me" },
  ]) {
    expect(() => extractChatGptTurnEnvironment(request("create_thread", change))).toThrow("missing cwd");
  }
});

test("a delegation from a different native turn cannot become the current instruction", () => {
  const parsed = request("send_message_to_thread", { internal_chat_message_metadata_passthrough: { turn_id: "55555555-5555-4555-8555-555555555555" } });
  expect(() => extractChatGptTurnUserRevision(parsed)).toThrow();
});

test("active delegated constraints survive replay after newer tool results", () => {
  const instruction = `${"a".repeat(2_900)}KEEP_THIS_REQUIRED_CONSTRAINT${"z".repeat(3_000)}`;
  const delegated = output.replace("Calculate 17 * 23 without editing files.", instruction);
  const parsed = request("create_thread", { output: delegated });
  for (let index = 0; index < 7; index++) {
    parsed.context.messages.push({ role: "toolResult", toolCallId: `call-${index}`, toolName: "shell",
      content: `${"x".repeat(3_000)}ORDINARY_OUTPUT_MIDDLE${"y".repeat(2_000)}`,
      isError: false, timestamp: index });
  }
  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "test-turn-token");
  expect(compiled.text.includes(instruction)).toBe(true);
  expect(compiled.text).toContain("characters of this earlier tool output omitted");
  expect(extractChatGptTurnUserRevision(parsed)).toBe(delegated);
});

test("delegation-only app chats compact and resume their original task", async () => {
  const parsed = request("create_thread");
  const original = parsed._rawBody as { input: unknown[]; client_metadata: Record<string, string> };
  const currentTurn = "66666666-6666-4666-8666-666666666666";
  const metadata = JSON.parse(original.client_metadata["x-codex-turn-metadata"]!);
  const base = { ...original, model: "chatgpt-web/high", stream: false, client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ ...metadata, turn_id: currentTurn }),
  } };
  const send = (body: unknown, compact: boolean) => responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(body),
  }), defaultConfig("full"), () => ({ name: "delegation-compaction-regression",
    async runTurn(task, _incoming, emit) {
      if (!compact) expect(extractChatGptTurnUserRevision(task)).toBe(output);
      emit({ type: "text_delta", text: compact ? "Continue the delegated calculation without editing files." : "391", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }), { rememberState: false });
  const compacted = await send({ ...base, input: [...base.input, { type: "compaction_trigger" }] }, true);
  if (compacted.status !== 200) throw new Error(await compacted.text());
  expect(compacted.status).toBe(200);
  const checkpoint = await compacted.json() as { status: string; output: unknown[] };
  expect(checkpoint.status).toBe("completed");
  const resumed = await send({ ...base, input: [...base.input, ...checkpoint.output] }, false);
  expect(resumed.status).toBe(200);
  expect((await resumed.json() as { status: string }).status).toBe("completed");
});
