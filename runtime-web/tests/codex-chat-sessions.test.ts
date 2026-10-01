import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

for (const contract of ["native", "safe"] as const) test(`${contract} session reads respect local scope, paginate visible UTF-8 text and never return private records`, async () => {
  const root = mkdtempSync(join(resolve(import.meta.dir, "../../aiTemp"), "codex-sessions-test-"));
  const home = join(root, "codex");
  const appHome = join(root, "app");
  const workspace = join(root, "project-a");
  const otherWorkspace = join(root, "project-b");
  for (const directory of [home, appHome, workspace, otherWorkspace]) mkdirSync(directory, { recursive: true });
  const activeId = "11111111-1111-4111-8111-111111111111";
  const archivedId = "22222222-2222-4222-8222-222222222222";
  const escapedId = "33333333-3333-4333-8333-333333333333";
  const message = (role: string, text: string, channel?: string) => ({ type: "response_item", payload: {
    type: "message", role, ...(channel ? { channel } : {}), content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  } });
  const fixture = (directory: string, id: string, cwd: string, records: unknown[], timestamp = "2026-09-28T01:00:00Z") => {
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `rollout-2026-09-28T01-00-00-${id}.jsonl`);
    writeFileSync(file, [{ type: "session_meta", payload: { id, cwd, timestamp, source: "cli" } }, ...records].map(record => JSON.stringify(record)).join("\n") + "\n");
    return file;
  };
  const visibleAnswer = "Visible answer 🙂".repeat(120);
  const active = fixture(join(home, "sessions/2026/09/28"), activeId, workspace, [
    message("user", 'Original question\nBearer SECRET_BEARER_VALUE_123456\napi_key="SECRET_ASSIGN_VALUE"\n<codex_context_json>PRIVATE_BRIDGE_CONTEXT</codex_context_json>'),
    message("user", "Cookie: one=COOKIE_FIRST; two=COOKIE_SECOND\nAuthorization: Basic BASIC_SECRET_VALUE\nGH_TOKEN=github_pat_ENV_SECRET_VALUE_1234567890123456"),
    message("system", "SYSTEM_PRIVATE_VALUE"), message("developer", "DEVELOPER_PRIVATE_VALUE"),
    message("assistant", "ANALYSIS_PRIVATE_VALUE", "analysis"),
    message("user", "HIDDEN_CHANNEL_VALUE", "analysis"),
    { type: "response_item", payload: { type: "reasoning", text: "REASONING_PRIVATE_VALUE" } },
    { type: "response_item", payload: { type: "function_call_output", output: "TOOL_PRIVATE_VALUE" } },
    message("assistant", visibleAnswer, "final"),
    { type: "event_msg", payload: { type: "agent_message", message: "DUPLICATE_EVENT_VALUE" } },
    message("assistant", "Visible update", "commentary"),
  ]);
  const archived = fixture(join(home, "archived_sessions"), archivedId, otherWorkspace, [message("user", "Other project question")], "Bearer METADATA_SECRET_VALUE");
  const outside = join(root, "outside");
  fixture(outside, escapedId, workspace, [message("user", "SYMLINK_ESCAPE_VALUE")]);
  symlinkSync(outside, join(home, "sessions/2026/09/29"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ id: activeId, thread_name: "Saved session title" }) + "\n");
  const digest = () => createHash("sha256").update(readFileSync(active)).update(readFileSync(archived)).digest("hex");
  const before = digest();
  const config = { ...defaultConfig(), runtimeCommand: [process.execPath] };
  const writeScope = (scope?: string) => writeFileSync(join(appHome, "config.json"), JSON.stringify({ ...config, ...(scope ? { codexHistoryScope: scope } : {}) }));
  writeScope();
  const socketPath = defaultBrokerEndpoint(join(root, "broker"));
  const broker = TurnBroker.forSocket(socketPath);
  const environment = { cwd: workspace, roots: [workspace], writableRoots: [], sandboxPolicy: { type: "readOnly" as const, networkAccess: false }, tools: [] };
  const nonce = "surface_nonce_history_0123456789";
  const token = contract === "native" ? await broker.register(environment, 60_000) : await broker.registerSafe(environment, nonce, 60_000);
  if (contract === "safe") { broker.confirmSafeTurnSent(token, nonce); broker.startSafeTurn(token); }
  const client = new Client({ name: "codex-session-test", version: "1.0" });
  const env = Object.fromEntries(Object.entries({ ...process.env, CODEX_HOME: home, CODEX_CHATGPT_WEB_HOME: appHome }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socketPath, "--contract", contract], cwd: resolve(import.meta.dir, ".."), env, stderr: "pipe" });
  const reference = contract === "native" ? "turn_token" : "request_id";
  const call = (args: Record<string, unknown>) => client.callTool({ name: "codex_chat_sessions", arguments: { [reference]: token, ...args } });
  const data = async (args: Record<string, unknown>) => {
    const response = await call(args);
    expect(response.isError).not.toBe(true);
    return response.structuredContent as Record<string, any>;
  };
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.some(tool => tool.name === "codex_chat_sessions")).toBe(true);
    expect((await call({ operation: "discover", [reference]: "invalid_token_1234567890123456" })).isError).toBe(true);
    const discovered = await data({ operation: "discover" });
    expect(discovered.scope).toBe("workspace");
    expect(discovered.codex_home.replace(/^\\\\\?\\/, "")).toBe(home);
    expect(discovered.active_available).toBe(true);
    expect(discovered.archived_available).toBe(true);
    const scoped = await data({ operation: "list" });
    expect(scoped.sessions.map((item: any) => item.id)).toEqual([activeId]);
    expect(scoped.sessions[0].title).toBe("Saved session title");
    expect((await call({ operation: "read", session_id: archivedId })).isError).toBe(true);
    writeScope("all");
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await data({ operation: "list", limit: 1, ...(cursor ? { cursor } : {}) });
      ids.push(...page.sessions.map((item: any) => item.id));
      cursor = page.next_cursor;
      expect(ids.length).toBeLessThanOrEqual(2);
    } while (cursor);
    expect(ids.sort()).toEqual([activeId, archivedId]);
    expect((await data({ operation: "read", session_id: archivedId, source: "archived" })).messages[0].text).toBe("Other project question");
    expect((await data({ operation: "read", session_id: archivedId })).session.timestamp).toBeNull();
    const messages: Array<{ role: string; text: string }> = [];
    let firstCursor = "";
    let pages = 0;
    do {
      const page = await data({ operation: "read", session_id: activeId, max_bytes: 512, ...(cursor ? { cursor } : {}) });
      expect(page.messages.reduce((sum: number, item: any) => sum + Buffer.byteLength(item.text), 0)).toBeLessThanOrEqual(512);
      messages.push(...page.messages);
      cursor = page.next_cursor;
      firstCursor ||= cursor || "";
      expect(++pages).toBeLessThan(20);
    } while (cursor);
    const text = messages.map(item => item.text).join("");
    expect(text).toContain("Original question");
    expect(text).toContain(visibleAnswer);
    expect(text).toContain("Visible update");
    expect(text).not.toContain("\ufffd");
    for (const secret of ["SECRET_BEARER", "SECRET_ASSIGN", "COOKIE_FIRST", "COOKIE_SECOND", "BASIC_SECRET", "ENV_SECRET", "PRIVATE_BRIDGE", "SYSTEM_PRIVATE", "DEVELOPER_PRIVATE", "ANALYSIS_PRIVATE", "HIDDEN_CHANNEL", "REASONING_PRIVATE", "TOOL_PRIVATE", "DUPLICATE_EVENT", "SYMLINK_ESCAPE"]) expect(text).not.toContain(secret);
    expect((await call({ operation: "read", session_id: escapedId })).isError).toBe(true);
    expect((await call({ operation: "read", session_id: "../../auth.json" })).isError).toBe(true);
    expect((await call({ operation: "read", session_id: activeId, cursor: "../../auth.json" })).isError).toBe(true);
    expect((await call({ operation: "read", session_id: archivedId, cursor: firstCursor })).isError).toBe(true);
    const partialId = "44444444-4444-4444-8444-444444444444";
    const partial = fixture(join(home, "sessions/2026/09/28"), partialId, workspace, []);
    appendFileSync(partial, JSON.stringify(message("assistant", "Late visible " + "x".repeat(900), "final")));
    const tail = await data({ operation: "read", session_id: partialId });
    expect(tail.live_tail).toBe(true);
    expect(tail.messages).toEqual([]);
    appendFileSync(partial, "\n");
    const appended = await data({ operation: "read", session_id: partialId, cursor: tail.next_cursor, max_bytes: 512 });
    expect(appended.messages[0].text).toStartWith("Late visible ");
    const original = readFileSync(partial, "utf8");
    mkdirSync(join(root, "Trash"));
    renameSync(partial, join(root, "Trash", "original-partial.jsonl"));
    writeFileSync(partial, original.replace("Late visible", "Else visible"));
    expect((await call({ operation: "read", session_id: partialId, cursor: appended.next_cursor })).isError).toBe(true);
    expect(digest()).toBe(before);
  } finally { await client.close(); await broker.close(); }
}, 30_000);
