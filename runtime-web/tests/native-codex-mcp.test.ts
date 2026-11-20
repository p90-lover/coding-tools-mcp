import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

// Seen 2026-11-20: every workspace's MCP listener was stopped, the desktop app refused the native Codex
// request with "Start this workspace's authenticated MCP listener first", and the connector answered
// ChatGPT only "Check the Coding Tools workspace listener and native Codex connection". ChatGPT then told
// the person their native Codex connection was unavailable, with nothing saying what to do.
test("native Codex passes the desktop app's refusal reason to ChatGPT, not a generic bridge failure", async () => {
  const runtimeRoot = resolve(import.meta.dir, "..");
  const scratch = join(runtimeRoot, "aiTemp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "native-codex-mcp-"));
  const descriptor = join(root, "launcher-browser.json");
  const token = "native-codex-test-".repeat(4);
  const endpoint = "http://127.0.0.1:1";
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: "codex-web-gpt-launcher", profile: "production",
    pid: process.pid, endpoint, control: { endpoint, token },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:coding-tools-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "s".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }), { mode: 0o600 });
  // The desktop control server's answers, picked by the request's workspace_id.
  const fixture = `
    const { runChatGptMcpServer } = await import("./src/adapters/chatgpt-web/mcp-server.ts");
    globalThis.fetch = async (url, options) => {
      if (url !== ${JSON.stringify(endpoint + "/v1/coding-tools/native-codex")}
        || options.headers.authorization !== ${JSON.stringify(`Bearer ${token}`)}) throw new Error("Unexpected fixture request");
      const body = JSON.parse(options.body);
      if (body.workspace_id === "listener-stopped") {
        return Response.json({ error: "Start this workspace's authenticated MCP listener first" }, { status: 400 });
      }
      if (body.workspace_id === "refused-without-reason") return new Response("", { status: 400 });
      if (body.workspace_id === "bad-gateway") return new Response(null, { status: 502 });
      if (body.workspace_id === "unreachable") throw new TypeError("fetch failed");
      return Response.json({ ok: true, operation: { request_id: body.request_id, state: "completed",
        result: { ok: true, status: "ready" } } });
    };
    await runChatGptMcpServer({ brokerSocketPath: ${JSON.stringify(join(root, "unused-broker"))} });
  `;
  const client = new Client({ name: "native-codex-refusal-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--eval", fixture], cwd: runtimeRoot, stderr: "pipe",
    env: { ...process.env as Record<string, string>, CODEX_CHATGPT_WEB_HOME: root,
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: descriptor } });
  const call = async (workspaceId: string) => {
    const response = await client.callTool({ name: "coding_tools_native_codex",
      arguments: { workspace_id: workspaceId, request_id: "req-native-1", tool: "codex_runtime_status", arguments: {} } });
    const content = response.content as Array<{ type: string; text?: string }>;
    return { response, payload: JSON.parse(content.find(item => item.type === "text")!.text!) };
  };
  try {
    await client.connect(transport);
    const stopped = await call("listener-stopped");
    expect(stopped.response.isError).toBe(true);
    expect(stopped.payload.code).toBe("native_codex_refused");
    expect(stopped.payload.message).toContain("Start this workspace's authenticated MCP listener first");
    expect(stopped.payload.message).toContain("new request_id");
    // Without a stated reason, or when the app can't be reached, the generic answer stays.
    for (const workspace of ["refused-without-reason", "bad-gateway", "unreachable"]) {
      const failed = await call(workspace);
      expect(failed.response.isError).toBe(true);
      expect(failed.payload.code).toBe("native_codex_bridge_unavailable");
    }
    const ready = await call("connected");
    expect(ready.response.isError).not.toBe(true);
    expect(ready.payload.operation.state).toBe("completed");
  } finally {
    await client.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
// Starting the CLI from source takes several seconds on a busy Windows machine.
}, 60_000);
