import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
