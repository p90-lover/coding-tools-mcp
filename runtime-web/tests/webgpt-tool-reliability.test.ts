import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import * as z from "zod/v4";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker, TurnBroker, TurnBrokerTimeoutError } from "../src/adapters/chatgpt-web/turn-broker";
import { CODEX_CHAT_SEND_GATEWAY_GUARD, CODEX_CHAT_SEND_WIRE_NAME, codexChatSendInputSchema, prepareCodexChatSend } from "../src/adapters/chatgpt-web/codex-chat-send";
import { namespacedToolName, type CodexTool } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "webgpt-tool-reliability-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const command: CodexTool = { name: "exec_command", description: "Run a shell command", parameters: {
  type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false,
} };
const app: CodexTool = { name: "update_issue", namespace: "mcp__production_app",
  description: "Update an issue in the connected app", parameters: command.parameters };

async function memoryBroker(tools: CodexTool[]) {
  const broker = Reflect.construct(TurnBroker, [join(root, "never-listened")]) as TurnBroker;
  const internal = broker as unknown as { start(): Promise<void>; dispatch(request: Record<string, unknown>): Promise<any>; server?: unknown };
  // Keep the real logical capability, binding, dispatch and retirement paths; only socket startup is absent.
  internal.start = async () => {};
  const environment = { cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" as const }, tools };
  const token = await broker.register(environment);
  const activityId = "activity_receipt_observation";
  const { bindingId } = await internal.dispatch({ method: "claim", token, activityId });
  expect(internal.server).toBeUndefined();
  return { broker, token, bindingId, activityId, environment, rpc: (request: Record<string, unknown>) => internal.dispatch(request) };
}

test("receipt-only observation preserves canonical IDs, aliases, ambiguity and live binding ownership", async () => {
  const memory = await memoryBroker([command]);
  let foreignToken: string | undefined;
  try {
    const first = await memory.rpc({ method: "invoke_start", bindingId: memory.bindingId, requestKey: "original-request",
      wireName: command.name, arguments: { cmd: "first mock action" } });
    const poll = (callId: string, bindingId = memory.bindingId) => memory.rpc({ method: "invoke_poll", bindingId, callId, waitMs: 0 });
    expect(await poll(first.call_id)).toMatchObject({ call_id: first.call_id, state: "queued" });
    expect(await poll("original-request")).toEqual(await poll(first.call_id));
    const [original] = await memory.broker.nextToolBatch(memory.token);
    expect(original?.callId).toBe(first.call_id);
    expect(await poll("original-request")).toMatchObject({ call_id: first.call_id, state: "dispatched" });
    const native = { content: [{ type: "text" as const, text: "original result" }], structuredContent: { completed: true } };
    memory.broker.completeTool(memory.token, first.call_id, native); await Promise.resolve();
    expect(await poll("original-request")).toMatchObject({ call_id: first.call_id, state: "completed", result: native });
    await expect(poll("unknown-request")).rejects.toThrow("unavailable in this turn");
    const second = await memory.rpc({ method: "invoke_start", bindingId: memory.bindingId, requestKey: first.call_id,
      wireName: command.name, arguments: { cmd: "second mock action" } });
    await expect(poll(first.call_id)).rejects.toThrow("ambiguous");
    expect(await poll("original-request")).toMatchObject({ call_id: first.call_id, result: native });
    expect(await poll(second.call_id)).toMatchObject({ call_id: second.call_id, state: "queued" });
    foreignToken = await memory.broker.register(memory.environment);
    const foreign = await memory.rpc({ method: "claim", token: foreignToken, activityId: memory.activityId });
    await expect(poll("original-request", foreign.bindingId)).rejects.toThrow("unavailable in this turn");
    await expect(poll(second.call_id, foreign.bindingId)).rejects.toThrow("unavailable in this turn");
    expect((await memory.broker.nextToolBatch(memory.token)).map(request => request.callId)).toEqual([second.call_id]);
    memory.broker.revoke(memory.token);
    await expect(poll("original-request")).rejects.toThrow(/finished|invalid or expired/);
  } finally { memory.broker.revoke(memory.token); if (foreignToken) memory.broker.revoke(foreignToken); }
});

// The real registered handlers run in a VM so no stdio transport or child process is started.
function receiptMcpHandlers(environment: Record<string, unknown>, bindingId: string, rpc: (request: Record<string, unknown>) => Promise<any>, onInvokeResult?: (response: any) => void) {
  const file = join(import.meta.dir, "../src/adapters/chatgpt-web/mcp-server.ts"), source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const find = (predicate: (node: ts.Node) => boolean) => { let found: ts.Node | undefined;
    const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; ts.forEachChild(node, visit); }; visit(tree); expect(found).toBeDefined(); return found!; };
  const definition = (name: string) => find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree).replace(/^export\s+/, "");
  const variable = (name: string) => (find(node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name) as ts.VariableDeclaration).initializer!.getText(tree);
  const registration = (name: string) => find(node => ts.isCallExpression(node) && node.expression.getText(tree) === "server.registerTool"
    && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === name).getText(tree);
  const helpers = ["wireName", "exactTool", "execGateway", "gatewayToolNameIsValid", "gatewayNestedToolName", "execGatewayResultProgram", "execGatewayProgram", "framedGatewayCatalog", "chatGptMcpInvocationTimeout", "asMcpResult", "result",
    "safeVisibleTools", "inventoryMatches", "isAgentWaitTool", "isGatewayAgentWaitTool", "browserToolDescription", "browserToolParameters", "gatewayToolDescription", "gatewayToolCatalogProgram", "gatewayToolCatalogPage"].map(definition).join("\n");
  const constants = ["nativeTurnTokenSchema", "CHATGPT_WEB_COMMAND_POLL_MAX_MS", "COMMAND_POLL_TRANSPORT_RULE", "BRIDGE_TOOL_NAMES", "GATEWAY_AGENT_WAIT_TOOL_NAMES", "CHATGPT_WEB_AGENT_WAIT_POLL_MS", "AGENT_WAIT_TRANSPORT_RULE", "GATEWAY_CATALOG_BEGIN", "GATEWAY_CATALOG_END", "MAX_GATEWAY_CATALOG_BYTES"]
    .map(name => `const ${name}=${variable(name)};`).join("\n");
  const handlers = new Map<string, { schema: z.ZodType; handler: (input: any, extra: any) => Promise<any> }>();
  runInNewContext(ts.transpileModule(constants + "\n" + helpers + "\nconst pollInvocation=" + variable("pollInvocation") + ";const invoke=async(...args)=>{const response=await (" + variable("invoke") + ")(...args);onInvokeResult?.(response);return response;};\n"
    + registration("codex_chat_send") + ";\n" + registration("codex_tool_status") + ";\n" + registration("codex_tool_inventory"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    z, Buffer, onInvokeResult, namespacedToolName, CODEX_CHAT_SEND_GATEWAY_GUARD, CODEX_CHAT_SEND_WIRE_NAME, codexChatSendInputSchema, prepareCodexChatSend,
    CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS: 90_000, contract: "native", options: { brokerSocketPath: "not-a-real-endpoint" }, randomBytes, TurnBrokerTimeoutError,
    afterSafeStart: (_contract: string, value: string) => value, turnReferenceInput: () => ({ turn_token: z.string().min(20).max(256) }),
    turnReference: (_contract: string, input: { turn_token: string }) => input.turn_token,
    withClaimedTurn: async (_name: string, _token: string, _extra: unknown, action: (claimed: unknown) => Promise<unknown>) => action({ bindingId, environment }),
    server: { registerTool: (name: string, metadata: any, handler: any) => handlers.set(name, { schema: typeof metadata.inputSchema.parse === "function" ? metadata.inputSchema : z.object(metadata.inputSchema), handler }) },
    callTurnBroker: (_endpoint: string, request: Record<string, unknown>) => rpc(request),
  });
  return (name: string, input: unknown) => { const tool = handlers.get(name)!; return tool.handler(tool.schema.parse(input), {}); };
}

for (const gateway of [false, true]) test(`receipt-only ${gateway ? "guarded gateway" : "direct"} chat send observes a lost acknowledgment without another action`, async () => {
  const memory = await memoryBroker(gateway ? [{ name: "exec", description: "Native gateway", freeform: true, parameters: {} }]
    : [{ name: CODEX_CHAT_SEND_WIRE_NAME, description: "Native chat sender", parameters: {} }]);
  const native = { content: [{ type: "text" as const, text: "mock native acknowledgment" }], structuredContent: { queued: true }, _meta: { source: "original" } };
  let starts = 0, canonicalId = "";
  const call = receiptMcpHandlers(memory.environment, memory.bindingId, async request => {
    const response = await memory.rpc(request);
    if (request.method !== "invoke_start") return response;
    starts += 1; canonicalId = response.call_id;
    const [original] = await memory.broker.nextToolBatch(memory.token);
    expect(original?.callId).toBe(canonicalId);
    if (gateway) expect(original!.input!.startsWith(CODEX_CHAT_SEND_GATEWAY_GUARD + "\n")).toBe(true);
    memory.broker.completeTool(memory.token, canonicalId, native); await Promise.resolve();
    throw new TurnBrokerTimeoutError();
  });
  try {
    const input = { turn_token: memory.token, thread_id: "fake-recipient", prompt: "mock approved input" };
    const unknown = await call("codex_chat_send", input);
    expect(unknown.structuredContent).toMatchObject({ code: "codex_tool_submission_unknown", retryable: false });
    const invocationId = unknown.structuredContent.invocation_id;
    expect(codexChatSendInputSchema.safeParse({ ...input, invocation_id: invocationId }).success).toBe(false);
    const observed = await call("codex_tool_status", { turn_token: memory.token, call_id: invocationId, wait_ms: 0 });
    expect(observed).toEqual(native);
    expect(await call("codex_tool_status", { turn_token: memory.token, call_id: canonicalId, wait_ms: 0 })).toEqual(native);
    expect(unknown.structuredContent.message).toContain("codex_tool_status");
    expect(starts).toBe(1);
    await memory.rpc({ method: "activity_complete", token: memory.token, activityId: memory.activityId });
    expect(memory.broker.beginCompletionFence(memory.token)).toBeNumber();
  } finally { memory.broker.revoke(memory.token); }
});

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

test("nested inventory accepts native exec framing and structured catalogs without changing pagination or scope", async () => {
  const direct: CodexTool = { name: "visible", description: "Browser screenshot direct", parameters: {} };
  const gateway: CodexTool = { name: "exec", description: "Native tools", parameters: {}, freeform: true };
  const registry = [
    { name: "visible", description: "Excluded outer duplicate" },
    { name: "exec", description: "Excluded outer gateway" },
    { name: "mcp__browser__first", description: "Browser screenshot first", parameters: { type: "object" },
      annotations: { readOnlyHint: true }, _meta: { "openai/outputTemplate": "ui://browser/first" } },
    { name: "mcp__browser__second", description: "Browser screenshot second" },
  ];
  // An unmarked plain-JSON catalog is rejected: only this request's marker or frame proves the catalog.
  for (const format of ["framed", "structured", "metadata"] as const) {
    await withMcp([gateway, direct], async ({ client, broker, token }) => {
      for (const offset of [0, 2]) {
        const pending = client.callTool({ name: "codex_tool_inventory",
          arguments: { turn_token: token, query: "browser screenshot", offset, limit: 2 } });
        const [request] = await broker.nextToolBatch(token);
        expect(request?.wireName).toBe("exec");
        const emitted: string[] = [];
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        await new AsyncFunction("ALL_TOOLS", "text", request!.input!)(registry, (text: string) => emitted.push(text));
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).not.toContain("Excluded outer");
        const catalog = { tools: [registry[offset === 0 ? 2 : 3]], total: 2 };
        const framed = `Script completed\nWall time: 0.13 seconds\nOutput:\n${emitted[0]}\n`;
        broker.completeTool(token, request!.callId, {
          content: [{ type: "text", text: framed }],
          ...(format === "structured" ? { structuredContent: catalog } : {}),
          ...(format === "metadata" ? { structuredContent: { execution: "completed" } } : {}),
        });
        const result = await pending;
        expect(result.isError).not.toBeTrue();
        expect(result.structuredContent).toMatchObject({ total: 3, next_offset: offset === 0 ? 2 : null,
          tools: offset === 0 ? [{ wire_name: "visible" }, { wire_name: registry[2]!.name,
            parameters: registry[2]!.parameters, annotations: registry[2]!.annotations, _meta: registry[2]!._meta }]
            : [{ wire_name: registry[3]!.name }] });
      }
    });
  }
});

test("nested inventory rejects malformed native frames, oversized output and excluded descriptors", async () => {
  await withMcp([{ name: "exec", description: "Native tools", parameters: {}, freeform: true }], async ({ client, broker, token }) => {
    for (const invalid of ["truncated", "duplicate", "unframed", "oversized", "excluded", "pagination", "failed"] as const) {
      const pending = client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token } });
      const [request] = await broker.nextToolBatch(token);
      const emitted: string[] = [];
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction("ALL_TOOLS", "text", request!.input!)([], (text: string) => emitted.push(text));
      const output = emitted[0]!;
      const bad = invalid === "truncated" ? output.slice(0, -8)
        : invalid === "duplicate" ? `${output}\n${output}`
          : invalid === "unframed" ? `unrelated wrapper text\n${JSON.stringify({ tools: [], total: 0 })}`
            : invalid === "oversized" ? "x".repeat(1024 * 1024 + 1)
              : invalid === "excluded" ? JSON.stringify({ tools: [{ name: "exec", description: "hidden outer tool" }], total: 1 })
                : invalid === "pagination" ? JSON.stringify({ tools: [], total: -1 }) : output;
      broker.completeTool(token, request!.callId, { content: [{ type: "text", text: bad }],
        ...(invalid === "failed" ? { isError: true, structuredContent: { tools: [], total: 0 } } : {}) });
      const result = await pending;
      expect(result.isError).toBeTrue();
      expect(JSON.stringify(result.content)).toContain("Native nested tool inventory");
    }
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

test("inventory receipts preserve pending and unknown discovery without another accepted invocation", async () => {
  for (const mode of ["pending", "submission_unknown", "status_unknown", "completed"] as const) {
    const memory = await memoryBroker([{ name: "exec", description: "Native gateway", parameters: {}, freeform: true }]);
    const schema = { type: "object", properties: { view: { type: "string" } }, required: ["view"] };
    const catalog = { tools: [{ name: "mcp__fake_app__inspect", description: "Read fake state", parameters: schema }], total: 1 };
    const native = { content: [{ type: "text" as const, text: "Script completed\nOutput:\nCODEX_NATIVE_TOOL_CATALOG_V1_BEGIN\n"
      + JSON.stringify(catalog) + "\nCODEX_NATIVE_TOOL_CATALOG_V1_END" }], _meta: { source: "original catalog" } };
    let starts = 0, canonicalId = "", observe = false, originalResponse: any;
    const complete = async () => {
      const [request] = await memory.broker.nextToolBatch(memory.token);
      expect(request?.callId).toBe(canonicalId);
      memory.broker.completeTool(memory.token, canonicalId, native); await Promise.resolve();
    };
    const call = receiptMcpHandlers(memory.environment, memory.bindingId, async request => {
      if (request.method === "invoke_poll") {
        if (mode === "status_unknown" && !observe) throw new TurnBrokerTimeoutError();
        // Model the real queued state at the observation deadline without a 25s wall-clock delay.
        return memory.rpc({ ...request, waitMs: 0 });
      }
      const response = await memory.rpc(request);
      if (request.method === "invoke_start") {
        starts += 1; canonicalId = response.call_id;
        if (mode === "completed") await complete();
        if (mode === "submission_unknown") throw new TurnBrokerTimeoutError();
      }
      return response;
    }, response => { originalResponse = response; });
    try {
      const response = await call("codex_tool_inventory", { turn_token: memory.token });
      if (mode === "completed") {
        expect(response.structuredContent).toMatchObject({ total: 2, tools: [{ wire_name: "exec" },
          { wire_name: catalog.tools[0]!.name, kind: "gateway", schema_available: true, parameters: schema }] });
        expect(response).not.toBe(originalResponse);
      } else {
        expect(response).toBe(originalResponse);
        expect(response.structuredContent).toMatchObject({ code: "codex_tool_" + mode, retryable: false });
        expect(response.structuredContent.message).toMatch(/poll/i);
        expect(response.structuredContent.message).toMatch(/do not resubmit/i);
        await complete();
      }
      const reference = response.structuredContent.invocation_id ?? response.structuredContent.call_id ?? canonicalId;
      observe = true;
      const recovered = await call("codex_tool_status", { turn_token: memory.token, call_id: reference, wait_ms: 0 });
      expect(recovered).toEqual(native);
      expect(recovered.structuredContent).toBeUndefined(); // Status returns the raw catalog, not an invented normalized page.
      expect(starts).toBe(1);
      await memory.rpc({ method: "activity_complete", token: memory.token, activityId: memory.activityId });
      expect(memory.broker.beginCompletionFence(memory.token)).toBeNumber();
    } finally { memory.broker.revoke(memory.token); }
  }
});
