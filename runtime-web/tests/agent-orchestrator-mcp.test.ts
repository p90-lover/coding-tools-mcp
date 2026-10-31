import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

test("WebGPT's native MCP catalog exposes mission execution but not self-approval", async () => {
  const client = new Client({ name: "ao-mission-catalog-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", "native"],
    cwd: resolve(import.meta.dir, ".."), stderr: "pipe" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const tool = tools.find(item => item.name === "coding_tools_agent_orchestrator");
    const operation = tool?.inputSchema.properties?.operation as { enum?: string[] } | undefined;
    expect(operation?.enum).toContain("start_run");
    expect(operation?.enum).toContain("run_status");
    expect(operation?.enum).toContain("observe");
    expect(operation?.enum).not.toContain("approve_harness");
  } finally { await client.close(); }
});

test("the MCP models operation defaults to WebGPT and CPA while explicit CPA stays CPA-only", async () => {
  const runtimeRoot = resolve(import.meta.dir, "..");
  const scratch = join(runtimeRoot, "aiTemp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "agent-orchestrator-mcp-"));
  const descriptor = join(root, "launcher-browser.json");
  const token = "mcp-model-test-".repeat(4);
  const endpoint = "http://127.0.0.1:1";
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: "codex-web-gpt-launcher", profile: "production",
    pid: process.pid, endpoint, control: { endpoint, token },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:coding-tools-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "s".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const client = new Client({ name: "ao-model-catalog-test", version: "1" });
  // Exercise the registered MCP handler and real catalog without a live app or fixture listener.
  const fixture = `
    const { createAgentOrchestratorWorkflow } = require("../desktop-electron/electron/agent-orchestrator-workflow.cjs");
    const { runChatGptMcpServer } = await import("./src/adapters/chatgpt-web/mcp-server.ts");
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: async () => { throw new Error("No headless request expected"); },
      cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k".repeat(40) }),
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "fixture-cpa-model" }] }) })
    });
    globalThis.fetch = async (url, options) => {
      if (url !== ${JSON.stringify(endpoint + "/v1/coding-tools/agent-orchestrator")}
        || options.headers.authorization !== ${JSON.stringify(`Bearer ${token}`)}) throw new Error("Unexpected fixture request");
      const body = JSON.parse(options.body);
      if (body.arguments.fixtureFailure) return new Response(null, { status: 502 });
      const result = await workflow.call(body.operation, { ...body.arguments, workspaceId: body.workspace_id });
      return Response.json({ ok: true, result, requestedArguments: body.arguments });
    };
    await runChatGptMcpServer({ brokerSocketPath: ${JSON.stringify(join(root, "unused-broker"))} });
  `;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--eval", fixture], cwd: runtimeRoot, stderr: "pipe",
    env: { ...process.env as Record<string, string>, CODEX_CHATGPT_WEB_HOME: root,
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: descriptor } });
  const models = async (arguments_: Record<string, unknown>) => {
    const response = await client.callTool({ name: "coding_tools_agent_orchestrator",
      arguments: { workspace_id: "fixture-workspace", operation: "models", arguments: arguments_ } });
    const content = response.content as Array<{ type: string; text?: string }>;
    return { response, payload: JSON.parse(content.find(item => item.type === "text")!.text!) };
  };
  try {
    await client.connect(transport);
    const available = await models({});
    expect(available.response.isError).not.toBe(true);
    expect(available.payload.result.models).toEqual([
      "chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro", "fixture-cpa-model",
    ]);
    expect(available.payload.result.harness).toBe("codex-native");
    expect(available.payload.requestedArguments).toEqual({ harness: "codex-native" });
    const cpa = await models({ harness: "cpa" });
    expect(cpa.response.isError).not.toBe(true);
    expect(cpa.payload.result.models).toEqual(["fixture-cpa-model"]);
    expect(cpa.payload.requestedArguments).toEqual({ harness: "cpa" });
    const unavailable = await models({ fixtureFailure: true });
    expect(unavailable.response.isError).toBe(true);
    expect(unavailable.payload.code).toBe("agent_orchestrator_unavailable");
    expect(unavailable.payload.result).toBeUndefined();
  } finally {
    await client.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
