import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest("Codex Native2 transports a synthetic computer tool and image result without a file", async () => {
  const brokerPath = defaultBrokerEndpoint(
    join(runtimeRoot, "aiTemp", `computer-vision-${process.pid}-${Date.now()}`),
    "win32",
  );
  const broker = TurnBroker.forSocket(brokerPath);
  const environment: ChatGptTurnEnvironment = {
    cwd: runtimeRoot,
    roots: [runtimeRoot],
    writableRoots: [runtimeRoot],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{
      namespace: "mcp__cua_repl",
      name: "js",
      description: "Control an approved computer and return image content",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    }, {
      name: "view_image",
      description: "Read a workspace image",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
  };
  const token = await broker.register(environment, 60_000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(runtimeRoot, "src", "cli.ts"), "mcp", "--broker-socket", brokerPath],
    cwd: runtimeRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "computer-vision-relay-check", version: "1" });
  try {
    await client.connect(transport);
    const inventory = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: token, query: "cua_repl", include_schema: true },
    });
    expect(inventory.structuredContent).toMatchObject({
      total: 1,
      tools: [{ wire_name: "mcp__cua_repl__js", kind: "function" }],
    });

    const pending = client.callTool({
      name: "codex_tool_call",
      arguments: {
        turn_token: token,
        wire_name: "mcp__cua_repl__js",
        arguments: { code: "await cua.getState()" },
      },
    });
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({
      wireName: "mcp__cua_repl__js",
      freeform: false,
      arguments: { code: "await cua.getState()" },
    });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
    await broker.completeTool(token, request!.callId, {
      content: [{ type: "image", mimeType: "image/png", data: png }],
      structuredContent: { observed: true },
    });
    const response = await pending;
    expect(response.content).toEqual([{ type: "image", mimeType: "image/png", data: png }]);
    expect(response.structuredContent).toEqual({ observed: true });

    const vision = client.callTool({
      name: "codex_view_image",
      arguments: { turn_token: token, path: "image.png", detail: "original" },
    });
    const [visionRequest] = await broker.nextToolBatch(token);
    expect(visionRequest).toMatchObject({
      wireName: "view_image",
      arguments: { path: "image.png", detail: "original" },
    });
    await broker.completeTool(token, visionRequest!.callId, {
      content: [{ type: "image", mimeType: "image/png", data: png }],
    });
    expect((await vision).content).toEqual([{ type: "image", mimeType: "image/png", data: png }]);
  } finally {
    await client.close().catch(() => {});
    await broker.revoke(token);
    await broker.close();
  }
}, 30_000);

windowsTest("independent native Codex tool is exposed only on the native ChatGPT contract", async () => {
  for (const contract of ["native", "safe"] as const) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(runtimeRoot, "src", "cli.ts"), "mcp",
        "--broker-socket", defaultBrokerEndpoint(join(runtimeRoot, "aiTemp", "native-codex-tool-check"), "win32"),
        "--contract", contract,
      ],
      cwd: runtimeRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "native-codex-tool-check", version: "1" });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names.includes("coding_tools_native_codex")).toBe(contract === "native");
    } finally {
      await client.close().catch(() => {});
    }
  }
}, 30_000);
