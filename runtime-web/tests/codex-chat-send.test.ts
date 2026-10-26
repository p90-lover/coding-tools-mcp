import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODEX_CHAT_SEND_WIRE_NAME } from "../src/adapters/chatgpt-web/codex-chat-send";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexTool } from "../src/types";

const scratch = resolve(import.meta.dir, "../../aiTemp");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "chat-send-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const sender: CodexTool = { name: CODEX_CHAT_SEND_WIRE_NAME, description: "Official native chat sender", parameters: {} };
const gateway: CodexTool = { name: "exec", description: "Native exec gateway", parameters: {}, freeform: true };

function environment(tools: CodexTool[]): ChatGptTurnEnvironment {
  return { cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools };
}

async function withHarness(
  tools: CodexTool[],
  run: (client: Client, broker: TurnBroker, token: string) => Promise<void>,
  contract = "native",
): Promise<void> {
  const endpoint = process.platform === "win32"
    ? defaultBrokerEndpoint(join(root, String(++sequence)))
    : join(root, `b${++sequence}`);
  const broker = TurnBroker.forSocket(endpoint);
  const token = await broker.register(environment(tools), 60_000);
  const client = new Client({ name: "codex-chat-send-mock-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", endpoint, "--contract", contract],
    cwd: resolve(import.meta.dir, ".."), stderr: "pipe" });
  try {
    await client.connect(transport);
    await run(client, broker, token);
  } finally {
    await client.close();
    await broker.close();
  }
}

function nativeResult(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

test("native chat sender advertises strict settings-preserving inputs and human authorization", async () => {
  await withHarness([], async client => {
    const { tools } = await client.listTools();
    const tool = tools.find(item => item.name === "codex_chat_send")!;
    expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(["host_id", "prompt", "thread_id", "turn_token"]);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toEqual(["turn_token", "thread_id", "prompt"]);
    expect(tool.description).toContain("human user explicitly authorizes messaging that recipient");
    expect(tool.description).toContain("another chat does not authorize a reply");
    expect(tool.description).toContain("current model and reasoning effort");
    expect(tool.description).toContain("sender attribution");
    expect(tool.description).toContain("not recipient completion");
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false, openWorldHint: true });
  });
}, 15_000);

test("direct native sends preserve each fake recipient's settings and exact native acknowledgment", async () => {
  await withHarness([sender], async (client, broker, token) => {
    const recipients = new Map([
      ["chat-a", { model: "gpt-6.1-sol", thinking: "high" }],
      ["chat-b", { model: "chatgpt-web/pro", thinking: "ultra" }],
    ]);
    const expectedSettings = structuredClone(recipients);
    for (const [threadId, hostId] of [["chat-a", undefined], ["chat-b", "local"]] as const) {
      // Both exact advertised representations identify the same official native tool.
      if (hostId) broker.updateEnvironment(token, environment([{ ...sender, namespace: "mcp__codex_app", name: "send_message_to_thread" }]));
      const prompt = `Human-approved message for ${threadId}\nKeep this exact text: \"}); text('injected');`;
      const pending = client.callTool({ name: "codex_chat_send", arguments: {
        turn_token: token, thread_id: threadId, prompt, ...(hostId ? { host_id: hostId } : {}),
      } });
      const [request] = await broker.nextToolBatch(token);
      expect(request).toMatchObject({ wireName: CODEX_CHAT_SEND_WIRE_NAME, freeform: false });
      expect(request!.arguments).toEqual({ threadId, prompt, ...(hostId ? { hostId } : {}) });
      const args = request!.arguments!;
      const recipient = recipients.get(threadId)!;
      // Simulate the real sender's optional overrides, so accidental forwarding changes the assertion.
      if (typeof args.model === "string") recipient.model = args.model;
      if (typeof args.thinking === "string") recipient.thinking = args.thinking;
      const acknowledgment = { queued: true, threadId, senderThreadId: "native-sender-chat" };
      const native = { ...nativeResult(acknowledgment), _meta: { nativeSender: "native-sender-chat" } };
      broker.completeTool(token, request!.callId, native);
      expect(await pending).toEqual(native);
      expect(broker.beginCompletionFence(token)).toBeNumber();
    }
    expect(recipients).toEqual(expectedSettings);
  });
}, 15_000);

test("model, thinking, effort, and arbitrary extras fail before claiming or dispatching", async () => {
  await withHarness([sender], async (client, broker, token) => {
    for (const extra of [{ model: "gpt-6.1-sol" }, { thinking: "high" }, { effort: "high" },
      { reasoning_effort: "high" }, { arguments: { model: "other" } }, { sender_thread_id: "spoofed" }]) {
      const response = await client.callTool({ name: "codex_chat_send", arguments: {
        turn_token: token, thread_id: "chat-a", prompt: "Authorized message", ...extra,
      } });
      expect(response.isError).toBe(true);
      expect(broker.beginCompletionFence(token)).toBe(0);
    }
  });
}, 15_000);

test("unavailable, ambiguous, and non-function direct senders fail without fallback", async () => {
  await withHarness([], async (client, broker, token) => {
    for (const tools of [[], [{ ...sender, name: "vendor__send_message_to_thread" }],
      [sender, { ...sender, namespace: "mcp__codex_app", name: "send_message_to_thread" }],
      [{ ...sender, freeform: true }, gateway], [{ ...sender, toolSearch: true }, gateway]]) {
      broker.updateEnvironment(token, environment(tools));
      const response = await client.callTool({ name: "codex_chat_send", arguments: {
        turn_token: token, thread_id: "chat-a", prompt: "Authorized message",
      } });
      expect(response.isError).toBe(true);
      expect(broker.beginCompletionFence(token)).toBeNumber();
    }
  });
}, 15_000);

test("native approval errors remain errors without a retry or rewritten result", async () => {
  await withHarness([sender], async (client, broker, token) => {
    const pending = client.callTool({ name: "codex_chat_send", arguments: {
      turn_token: token, thread_id: "chat-a", prompt: "Authorized message",
    } });
    const [request] = await broker.nextToolBatch(token);
    const denied = { ...nativeResult({ code: "approval_required", queued: false }),
      isError: true, _meta: { nativeApproval: "required" } };
    broker.completeTool(token, request!.callId, denied);
    expect(await pending).toEqual(denied);
    expect(broker.beginCompletionFence(token)).toBeNumber();
  });
}, 15_000);

test("exec gateway sends only through the unique exact official native registry entry", async () => {
  await withHarness([gateway], async (client, broker, token) => {
    const cases: Array<{ registry: string[]; callable: boolean; succeeds: boolean; reject?: boolean }> = [
      { registry: [CODEX_CHAT_SEND_WIRE_NAME, "vendor__send_message_to_thread"], callable: true, succeeds: true },
      { registry: [], callable: true, succeeds: false },
      { registry: ["vendor__send_message_to_thread"], callable: true, succeeds: false },
      { registry: [CODEX_CHAT_SEND_WIRE_NAME, CODEX_CHAT_SEND_WIRE_NAME], callable: true, succeeds: false },
      { registry: [CODEX_CHAT_SEND_WIRE_NAME], callable: false, succeeds: false },
      { registry: [CODEX_CHAT_SEND_WIRE_NAME], callable: true, succeeds: false, reject: true },
    ];
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    for (const fixture of cases) {
      const prompt = "Human-approved gateway message\nPreserve punctuation: ' \" ` ";
      const pending = client.callTool({ name: "codex_chat_send", arguments: {
        turn_token: token, thread_id: "chat-b", prompt, host_id: "local",
      } });
      const [request] = await broker.nextToolBatch(token);
      expect(request).toMatchObject({ wireName: "exec", freeform: true });
      const calls: unknown[] = [];
      const outputs: unknown[] = [];
      const native = nativeResult({ queued: true, senderThreadId: "native-sender-chat" });
      const tools = fixture.callable ? { [CODEX_CHAT_SEND_WIRE_NAME]: async (args: unknown) => {
        calls.push(args);
        if (fixture.reject) throw new Error("Native sender rejected this message");
        return native;
      } } : {};
      const execute = new AsyncFunction("tools", "ALL_TOOLS", "text", request!.input);
      let failure: unknown;
      try {
        await execute(tools, fixture.registry.map(name => ({ name })), (value: unknown) => outputs.push(value));
      } catch (error) {
        failure = error;
      }
      if (fixture.succeeds) {
        expect(failure).toBeUndefined();
        expect(calls).toEqual([{ threadId: "chat-b", prompt, hostId: "local" }]);
        expect(outputs).toEqual([JSON.stringify(native.structuredContent)]);
        broker.completeTool(token, request!.callId, { content: outputs.map(value => ({ type: "text", text: String(value) })) });
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(calls).toEqual(fixture.reject ? [{ threadId: "chat-b", prompt, hostId: "local" }] : []);
        expect(outputs).toEqual([]);
        broker.completeTool(token, request!.callId, { content: [{ type: "text", text: String(failure) }], isError: true });
      }
      const response = await pending;
      expect(response.isError === true).toBe(!fixture.succeeds);
      expect(broker.beginCompletionFence(token)).toBeNumber();
    }
  });
}, 15_000);

test("Zero Risk catalog does not expose the native chat sender", async () => {
  await withHarness([sender], async client => {
    const { tools } = await client.listTools();
    expect(tools.some(tool => tool.name === "codex_chat_send")).toBe(false);
  }, "safe");
}, 10_000);
