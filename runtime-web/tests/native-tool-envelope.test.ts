import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import * as brokerModule from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import type { CodexToolResultMessage } from "../src/types";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };
const turnToken = "turn_native_envelope_projection_12345678901234567890";
const privateSentinel = "COMPONENT_ONLY_PRIVATE_SENTINEL";
const canonical = {
  content: [
    { type: "text" as const, text: "Chart ready" },
    { type: "resource_link" as const, uri: "https://example.test/chart.csv", name: "Chart data", mimeType: "text/csv" },
    { type: "resource" as const, resource: { uri: "urn:example:summary", mimeType: "text/plain", text: "Public summary" } },
    { type: "audio" as const, mimeType: "audio/wav", data: "UklGRkFVRElPX0JJTkFSWQ==" },
  ],
  structuredContent: { series: [1, 2, 3] },
  isError: false,
  _meta: { componentState: privateSentinel },
};

function requestWithResult(output: unknown) {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    input: [
      { type: "function_call", call_id: "call_chart", name: "chart", namespace: "mcp__charts", arguments: "{}" },
      { type: "function_call_output", call_id: "call_chart", output },
    ],
  });
}

function toolMessage(output: unknown): CodexToolResultMessage {
  const message = requestWithResult(output).context.messages.at(-1)!;
  if (message.role !== "toolResult") throw new Error("Expected a normalized tool result");
  return message;
}

test("canonical native result retains rich content and component metadata apart from public projection", () => {
  const message = toolMessage(canonical);
  expect(message.mcpResult).toEqual(canonical);
  expect(message.content).toContain("Chart ready");
  expect(message.content).toContain("Public summary");
  expect(message.content).toContain('"series":[1,2,3]');
  expect(JSON.stringify(message.content)).not.toContain(privateSentinel);
  expect(JSON.stringify(message.content)).not.toContain(canonical.content[3]!.data!);
  expect(brokerModule.codexToolResultToBrokerResult(message)).toEqual(canonical);
  expect(toolMessage({ ...canonical, isError: true }).isError).toBe(true);
});

test("SDK-valid native envelopes may omit content without losing structured or private fields", () => {
  const output = { structuredContent: { series: [1, 2, 3] }, isError: false, _meta: { componentState: privateSentinel } };
  const sdkResult = CallToolResultSchema.parse(output);
  expect(sdkResult.content).toEqual([]);
  const message = toolMessage(output);
  expect(message.mcpResult).toEqual(sdkResult);
  expect(message.content).toBe('{"series":[1,2,3]}');
  expect(brokerModule.codexToolResultToBrokerResult(message)).toEqual(sdkResult);
  const compiled = compileChatGptWebPrompt(requestWithResult(output), capabilities, turnToken);
  expect(compiled.text).toContain('series');
  expect(compiled.text).not.toContain(privateSentinel);
  for (const metadataOnly of [{ _meta: { componentState: privateSentinel } }, { isError: true }]) {
    expect(toolMessage(metadataOnly).mcpResult).toEqual(CallToolResultSchema.parse(metadataOnly));
  }
  for (const content of [null, "not an array", {}]) {
    const malformed = { content, structuredContent: { series: [] } };
    expect(CallToolResultSchema.safeParse(malformed).success).toBeFalse();
    expect(() => toolMessage(malformed)).toThrow("content");
  }
});

test("ordinary JSON objects and legacy JSON strings are not empty MCP envelopes", () => {
  for (const ordinary of [{ output: "ok", exit_code: 0 }, { isError: true, error: "ordinary function error" }]) {
    // The SDK's default alone is deliberately insufficient to identify an MCP result.
    expect(CallToolResultSchema.safeParse(ordinary).success).toBeTrue();
    expect(toolMessage(ordinary).mcpResult).toBeUndefined();
    expect(toolMessage(ordinary).content).toBe(JSON.stringify(ordinary));
    const legacy = JSON.stringify(ordinary);
    expect(toolMessage(legacy).mcpResult).toBeUndefined();
    expect(toolMessage(legacy).content).toBe(legacy);
  }
  const ambiguous = { _meta: { privateSentinel }, response: "ordinary JSON" };
  expect(CallToolResultSchema.safeParse(ambiguous).success).toBeTrue();
  const message = toolMessage(ambiguous);
  expect(message.content).toBe('{"response":"ordinary JSON"}');
  expect(message.mcpResult?.content).toEqual([{ type: "text", text: message.content }]);
  expect(brokerModule.codexToolResultToBrokerResult(message)._meta).toEqual(ambiguous._meta);
  const compiled = compileChatGptWebPrompt(requestWithResult(ambiguous), capabilities, turnToken);
  expect(compiled.text).toContain('ordinary JSON');
  expect(compiled.text).not.toContain(privateSentinel);
  const legacy = JSON.stringify(ambiguous);
  expect(toolMessage(legacy).mcpResult).toBeUndefined();
  expect(toolMessage(legacy).content).toBe(legacy);
});

test("binary and oversized MCP resource URIs stay canonical without entering model text", () => {
  const uris = ["data:application/octet-stream;base64,QklOQVJZX1VSSV9TRU5USU5FTA==", "blob:https://example.test/BINARY_BLOB_URI_SENTINEL", `https://example.test/${"x".repeat(5_000)}`];
  for (const uri of uris) {
    const result = CallToolResultSchema.parse({ content: [
      { type: "resource_link", name: "Download report", uri, mimeType: "application/octet-stream" },
      { type: "resource", resource: { uri, mimeType: "application/octet-stream", blob: "QklOQVJZX0JMT0JfU0VOVElORUw=" } },
    ], _meta: { componentState: privateSentinel } });
    const message = toolMessage(result);
    expect(message.mcpResult).toEqual(result);
    expect(message.content).toContain("Download report");
    expect(message.content).not.toContain(uri);
    expect(JSON.stringify(message.content).length).toBeLessThan(1_000);
    const compiled = compileChatGptWebPrompt(requestWithResult(result), capabilities, turnToken);
    expect(compiled.text).not.toContain(uri);
    expect(compiled.text).not.toContain(privateSentinel);
  }
  const publicUri = "https://example.test/report.csv";
  const resourceUri = "urn:example:report";
  expect(toolMessage({ content: [
    { type: "resource_link", name: "Report", uri: publicUri },
    { type: "resource", resource: { uri: resourceUri, blob: "YmxvYg==" } },
  ] }).content).toBe(`[resource: Report — ${publicUri}][resource: ${resourceUri}]`);
});

test("canonical MCP arrays survive while legacy native text and image results keep their projection", () => {
  expect(toolMessage(canonical.content).mcpResult).toEqual({ content: canonical.content });
  const legacy = toolMessage('{"output":"legacy","exit_code":0}');
  expect(legacy.mcpResult).toBeUndefined();
  expect(brokerModule.codexToolResultToBrokerResult(legacy)).toEqual({
    content: [{ type: "text", text: legacy.content }],
    structuredContent: { output: "legacy", exit_code: 0 },
  });
  const native = toolMessage([{ type: "input_text", text: "image ready" }, { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=", detail: "original" }]);
  expect(native.mcpResult).toBeUndefined();
  expect(native.content).toEqual([{ type: "text", text: "image ready" }, { type: "image", imageUrl: "data:image/png;base64,aW1hZ2U=", detail: "high" }]);
  expect(brokerModule.codexToolResultToBrokerResult(native).content).toEqual([{ type: "text", text: "image ready" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
  const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=", _meta: { "codex/imageDetail": "original" } };
  const canonicalImage = toolMessage({ content: [image] });
  expect(canonicalImage.content).toEqual([{ type: "image", imageUrl: "data:image/png;base64,aW1hZ2U=" }]);
  expect(brokerModule.codexToolResultToBrokerResult(canonicalImage).content).toEqual([image]);
  expect(toolMessage([{ type: "input_file", filename: "chart.csv", file_data: "BINARY_FILE_NOT_PUBLIC_TEXT" }]).content).toBe("[file: chart.csv]");
});

test("supplied tool descriptor metadata survives direct and deferred Responses declarations", () => {
  const descriptor = {
    type: "function", name: "chart", description: "Draw chart", parameters: { type: "object" },
    outputSchema: { type: "object", properties: { series: { type: "array" } } },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: "ui://example/chart.html" } },
  };
  for (const body of [{ tools: [descriptor] }, { input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "mcp__charts", tools: [descriptor] }] }] }]) {
    const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, ...body });
    expect(parsed.context.tools?.[0]).toMatchObject({ name: "chart", outputSchema: descriptor.outputSchema, annotations: descriptor.annotations, _meta: descriptor._meta });
  }
});

test("canonical private metadata and duplicate binary do not enter inline or multipart prompt token accounting", () => {
  const parsed = requestWithResult(canonical);
  const projected = structuredClone(parsed);
  const message = projected.context.messages.at(-1)!;
  if (message.role !== "toolResult") throw new Error("Expected a tool result");
  delete message.mcpResult;
  for (const options of [undefined, { experimentalMultipartParts: 2 as const }]) {
    const full = compileChatGptWebPrompt(parsed, capabilities, turnToken, options);
    const publicOnly = compileChatGptWebPrompt(projected, capabilities, turnToken, options);
    expect(full.text).toBe(publicOnly.text);
    expect(full.multipart).toEqual(publicOnly.multipart);
    expect(JSON.stringify(full)).not.toContain(privateSentinel);
    expect(JSON.stringify(full)).not.toContain(canonical.content[3]!.data!);
    expect(estimateCompiledChatGptWebInputTokens(full, parsed.modelId)).toBe(estimateCompiledChatGptWebInputTokens(publicOnly, parsed.modelId));
  }
});

test("canonical native result crosses broker and MCP stdio without losing media, resources or component metadata", async () => {
  const brokerPath = defaultBrokerEndpoint(join(tmpdir(), `ne-${process.pid.toString(36)}-${Date.now().toString(36)}`));
  const broker = brokerModule.TurnBroker.forSocket(brokerPath);
  const tool = {
    namespace: "mcp__charts", name: "chart", description: "Chart fixture", parameters: { type: "object" },
    annotations: { readOnlyHint: true }, outputSchema: { type: "object" }, _meta: { fixture: "descriptor" },
  };
  const environment: ChatGptTurnEnvironment = {
    cwd: runtimeRoot, roots: [runtimeRoot], writableRoots: [runtimeRoot],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [tool],
  };
  const token = await broker.register(environment, 60_000);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(runtimeRoot, "src", "cli.ts"), "mcp", "--broker-socket", brokerPath],
    cwd: runtimeRoot, stderr: "pipe",
  });
  const client = new Client({ name: "native-envelope-test", version: "1" });
  try {
    await client.connect(transport);
    const inventory = await client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, include_schema: true } });
    expect(inventory.structuredContent).toMatchObject({ tools: [{ wire_name: "mcp__charts__chart", annotations: tool.annotations, outputSchema: tool.outputSchema, _meta: tool._meta }] });
    const structuredOnly = { structuredContent: canonical.structuredContent, isError: false, _meta: canonical._meta };
    const cases = [
      { output: canonical, expected: CallToolResultSchema.parse(canonical) },
      { output: structuredOnly, expected: CallToolResultSchema.parse(structuredOnly) },
      { output: { _meta: canonical._meta, response: "extension" }, expected: { content: [{ type: "text" as const, text: '{"response":"extension"}' }], structuredContent: { response: "extension" }, _meta: canonical._meta } },
    ];
    for (const { output, expected } of cases) {
      const pending = client.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name: "mcp__charts__chart", arguments: {} } });
      const [request] = await broker.nextToolBatch(token);
      await broker.completeTool(token, request!.callId, brokerModule.codexToolResultToBrokerResult(toolMessage(output)));
      expect(await pending).toEqual(expected);
    }
  } finally {
    await client.close().catch(() => {});
    await broker.revoke(token);
    await broker.close();
  }
}, 30_000);

test("native exec gateway exposes public structured results without printing component metadata", async () => {
  const brokerPath = defaultBrokerEndpoint(join(tmpdir(), `ng-${process.pid.toString(36)}-${Date.now().toString(36)}`));
  const broker = brokerModule.TurnBroker.forSocket(brokerPath);
  const token = await broker.register({
    cwd: runtimeRoot, roots: [runtimeRoot], writableRoots: [runtimeRoot], sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{ name: "exec", description: "Native exec fixture", parameters: { type: "object" }, freeform: true }],
  }, 60_000);
  const client = new Client({ name: "native-gateway-envelope-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(runtimeRoot, "src", "cli.ts"), "mcp", "--broker-socket", brokerPath],
    cwd: runtimeRoot, stderr: "pipe",
  });
  const descriptor = { name: "fixture_chart", description: "Fixture chart", outputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { fixture: "supplied" } };
  const execute = async (input: string, result: unknown) => {
    const content: unknown[] = [];
    await new Function("tools", "ALL_TOOLS", "text", "image", "audio", "generatedImage", `return (async () => {${input}\n})();`)(
      { fixture_chart: async () => result }, [descriptor],
      (value: unknown) => content.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }),
      (value: unknown) => content.push(value), (value: unknown) => content.push(value), (value: unknown) => content.push(value),
    );
    return content;
  };
  try {
    await client.connect(transport);
    const binaryUris = ["data:application/octet-stream;base64,QklOQVJZX0dBVEVXQVlfU0VOVElORUw=", "blob:https://example.test/BINARY_GATEWAY_URI_SENTINEL", `https://example.test/${"x".repeat(5_000)}`];
    const binaryResults = binaryUris.map(uri => CallToolResultSchema.parse({ content: [
      { type: "resource_link", name: "Download report", uri, mimeType: "application/octet-stream" },
      { type: "resource", resource: { uri, mimeType: "application/octet-stream", blob: "QklOQVJZX0JMT0I=" } },
    ] }));
    for (const result of [canonical, { status: "plain", _meta: { componentState: privateSentinel } }, ...binaryResults]) {
      const pending = client.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name: descriptor.name, arguments: {} } });
      const [request] = await broker.nextToolBatch(token);
      expect(request?.wireName).toBe("exec");
      const content = await execute(request!.input!, result);
      expect(JSON.stringify(content)).not.toContain(privateSentinel);
      if (result === canonical) expect(JSON.stringify(content)).toContain('series');
      if (binaryResults.includes(result as typeof binaryResults[number])) {
        for (const uri of binaryUris) expect(JSON.stringify(content)).not.toContain(uri);
        expect(JSON.stringify(content)).toContain("Download report");
        expect(JSON.stringify(content).length).toBeLessThan(1_000);
      }
      await broker.completeTool(token, request!.callId, { content });
      expect(JSON.stringify(await pending)).not.toContain(privateSentinel);
    }
    const pendingInventory = client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, query: descriptor.name, include_schema: true } });
    const [inventoryRequest] = await broker.nextToolBatch(token);
    await broker.completeTool(token, inventoryRequest!.callId, { content: await execute(inventoryRequest!.input!, undefined) });
    expect((await pendingInventory).structuredContent).toMatchObject({ tools: [{ wire_name: descriptor.name, outputSchema: descriptor.outputSchema, annotations: descriptor.annotations, _meta: descriptor._meta }] });
  } finally {
    await client.close().catch(() => {});
    await broker.revoke(token);
    await broker.close();
  }
}, 30_000);
