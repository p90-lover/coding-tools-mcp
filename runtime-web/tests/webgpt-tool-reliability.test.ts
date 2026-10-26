import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexTool } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "webgpt-tool-reliability-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const command: CodexTool = { name: "exec_command", description: "Run a shell command", parameters: {
  type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false,
} };
const app: CodexTool = { name: "update_issue", namespace: "mcp__production_app",
  description: "Update an issue in the connected app", parameters: command.parameters };

async function withMcp(
  tools: CodexTool[],
  run: (context: { client: Client; broker: TurnBroker; token: string; socket: string }) => Promise<void>,
  consent?: "accept" | "decline" | "cancel" | "unchecked",
) {
  const socket = defaultBrokerEndpoint(join(root, crypto.randomUUID()));
  const broker = TurnBroker.forSocket(socket);
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false }, tools });
  const client = new Client({ name: "bridge-tools-test", version: "1" },
    consent ? { capabilities: { elicitation: { form: {} } } } : {});
  if (consent) client.setRequestHandler(ElicitRequestSchema, async request => {
    expect(request.params.message).toContain("mcp__production_app__update_issue");
    expect(request.params.message).toContain('"cmd":"reviewed change"');
    return consent === "accept" || consent === "unchecked"
      ? { action: "accept", content: { approve: consent === "accept" } } : { action: consent };
  });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socket], cwd: process.cwd(), stderr: "pipe" });
  try {
    await client.connect(transport);
    await run({ client, broker, token, socket });
  } finally {
    await client.close().catch(() => {});
    broker.revoke(token);
    await broker.close();
  }
}

test("inventory matches separate keywords and aliases and retains exact native schemas", async () => {
  await withMcp([command], async ({ client, token }) => {
    const found = await client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, query: "terminal command" } });
    expect(found.structuredContent).toMatchObject({ total: 1, tools: [{ wire_name: "exec_command", schema_available: true, parameters: command.parameters }] });
    expect((found.structuredContent as Record<string, unknown>).availability).toContain("execution unverified");
  });
});

test("nested inventory preserves supplied schemas and labels unavailable schemas", async () => {
  await withMcp([{ name: "exec", description: "Native tools", parameters: {}, freeform: true }], async ({ client, broker, token }) => {
    const pending = client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, query: "browser screenshot" } });
    const [request] = await broker.nextToolBatch(token);
    const emitted: string[] = [];
    const schema = { type: "object", properties: { tab: { type: "string" } }, required: ["tab"] };
    const metadata = { outputSchema: { type: "object" }, annotations: { readOnlyHint: true },
      _meta: { "openai/outputTemplate": "ui://browser/screenshot" } };
    const registry = [
      { name: "mcp__browser__screenshot", description: "Browser screenshot", inputSchema: schema, ...metadata },
      { name: "mcp__browser__snapshot", description: "Browser screenshot", parameters: undefined },
    ];
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("ALL_TOOLS", "text", request!.input!)(registry, (text: string) => emitted.push(text));
    broker.completeTool(token, request!.callId, { content: [{ type: "text", text: emitted[0] }] });
    const result = await pending;
    expect(result.structuredContent).toMatchObject({ total: 2, tools: [
      { wire_name: registry[0]!.name, schema_available: true, parameters: schema, ...metadata },
      { wire_name: registry[1]!.name, schema_available: false },
    ] });
  });
});

test("MCP receipts survive polling, deduplicate identical IDs and reject changed actions", async () => {
  await withMcp([command], async ({ client, broker, token, socket }) => {
    const args = { turn_token: token, wire_name: "exec_command", invocation_id: "build-1", arguments: { cmd: "build" }, wait_ms: 0 };
    const pending = await client.callTool({ name: "codex_tool_call", arguments: args });
    expect(pending.structuredContent).toMatchObject({ code: "codex_tool_pending", state: "queued", retryable: false });
    const callId = (pending.structuredContent as Record<string, unknown>).call_id as string;
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ callId, wireName: "exec_command", arguments: { cmd: "build" } });
    const again = await client.callTool({ name: "codex_tool_call", arguments: args });
    expect(again.structuredContent).toMatchObject({ call_id: callId, state: "dispatched" });
    const changed = await client.callTool({ name: "codex_tool_call", arguments: { ...args, arguments: { cmd: "delete" } } });
    expect(changed.isError).toBeTrue();
    expect(JSON.stringify(changed.content)).toContain("conflicts");
    const other = await broker.register({ cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [command] });
    try {
      const claim = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token: other });
      await expect(callTurnBroker(socket, { method: "invoke_poll", bindingId: claim.bindingId, callId })).rejects.toThrow("unavailable in this turn");
    } finally { broker.revoke(other); }
    broker.completeTool(token, callId, { content: [{ type: "text", text: "build done" }], structuredContent: { exit_code: 0 } });
    const done = await client.callTool({ name: "codex_tool_status", arguments: { turn_token: token, call_id: callId, wait_ms: 0 } });
    expect(done.structuredContent).toEqual({ exit_code: 0 });
    expect(done.content).toEqual([{ type: "text", text: "build done" }]);
    const replay = await client.callTool({ name: "codex_tool_call", arguments: args });
    expect(replay.content).toEqual(done.content);
    expect(broker.beginCompletionFence(token)).toBeNumber();
  });
});

for (const consent of [undefined, "decline", "cancel", "unchecked"] as const) {
  test(`app confirmation ${consent ?? "unsupported"} never dispatches an action`, async () => {
    await withMcp([app], async ({ client, broker, token }) => {
      const result = await client.callTool({ name: "codex_app_call", arguments: { turn_token: token,
        wire_name: "mcp__production_app__update_issue", arguments: { cmd: "reviewed change" }, reason: "Update the reviewed issue", invocation_id: "app-1" } });
      expect(result.structuredContent).toMatchObject({ executed: false, code: consent ? "app_permission_denied" : "app_confirmation_unavailable" });
      expect(broker.beginCompletionFence(token)).toBeNumber();
    }, consent);
  });
}

test("accepted app confirmation dispatches the exact action through native Codex", async () => {
  await withMcp([app], async ({ client, broker, token }) => {
    const pending = client.callTool({ name: "codex_app_call", arguments: { turn_token: token,
      wire_name: "mcp__production_app__update_issue", arguments: { cmd: "reviewed change" }, reason: "Update the reviewed issue", invocation_id: "app-1" } });
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "mcp__production_app__update_issue", freeform: false, arguments: { cmd: "reviewed change" } });
    broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "Native result" }] });
    expect((await pending).content).toEqual([{ type: "text", text: "Native result" }]);
  }, "accept");
});
