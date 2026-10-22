"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const { routineAppTool, recommendedAnswer, blockedRequest } = createAgentOrchestratorWorkflow({ requestHeadless: async () => ({ ok: true }) });

test("Approve for me answers the app's own reads and worktree edits itself", () => {
  for (const name of ["list_dir", "read_file", "search_text", "git_status", "git_diff", "git_log", "view_image", "apply_patch", "patch_check", "read_output"]) {
    assert.ok(routineAppTool(`mcp__coding-tools__${name}`), name);
  }
});

test("every tool of the chat's own groups is covered by Approve for me as it is added; the terminal and the screen go to the reviewer", () => {
  // The user: "it doesn't auto register chat harness tools for the auto review list". The groups are
  // read from the tools' own modules, so a tool added there needs no second list here.
  const { AGENT_TOOLS, TERMINAL_TOOLS, DESKTOP_TOOLS } = require("../electron/chat-agent-tools.cjs");
  const { PREVIEW_TOOLS } = require("../electron/chat-preview.cjs");
  const { SUBAGENT_TOOLS } = require("../electron/subagents.cjs");
  const { CHAT_HISTORY_TOOLS } = require("../electron/chat-history.cjs");
  for (const name of [...AGENT_TOOLS, ...PREVIEW_TOOLS, ...SUBAGENT_TOOLS, ...CHAT_HISTORY_TOOLS]) assert.ok(routineAppTool(`mcp__coding-tools__${name}`), name);
  for (const name of [...TERMINAL_TOOLS, ...DESKTOP_TOOLS].filter((tool) => !["check_exec_environment", "read_output"].includes(tool))) {
    assert.equal(routineAppTool(`mcp__coding-tools__${name}`), null, `${name} is reviewed, not routine`);
  }
  assert.ok(SUBAGENT_TOOLS.size >= 5 && PREVIEW_TOOLS.size >= 10, "the groups are the real ones");
});

test("the terminal, the screen, unknown tools and look-alike servers still go to the person", () => {
  for (const name of [
    "mcp__coding-tools__exec_command", "mcp__coding-tools__write_stdin", "mcp__coding-tools__kill_command",
    "mcp__coding-tools__computer_click", "mcp__coding-tools__capture_screenshot", "mcp__coding-tools__list_windows",
    "mcp__coding-tools__vision_status", "mcp__coding-tools__capture_process", "mcp__coding-tools__capture_window",
    "mcp__coding-tools__delete_everything",
    "mcp__coding-tools-evil__read_file", "mcp__coding_tools__read_file", "mcp__other__read_file", "read_file",
    "mcp__coding-tools__read_file_extra", "", undefined,
  ]) assert.equal(routineAppTool(name), null, String(name));
});

test("a question nobody answers gets each field's recommended choice, and a URL request is declined", () => {
  const answer = recommendedAnswer({ mode: "form", fields: [
    { key: "framework", type: "choice", options: [{ value: "vue", label: "Vue", description: "" }, { value: "react", label: "React (Recommended)", description: "" }] },
    { key: "extras", type: "multi", options: [{ value: "lint", label: "Lint", description: "" }] },
    { key: "proceed", type: "boolean", options: [] },
    { key: "notes", type: "text", options: [] },
  ] });
  assert.equal(answer.action, "accept");
  assert.deepEqual({ ...answer.content, notes: typeof answer.content.notes }, { framework: "react", extras: ["lint"], proceed: true, notes: "string" });
  assert.deepEqual(recommendedAnswer({ mode: "url", url: "https://example.com", fields: [] }), { action: "decline" });
});

test("the safety rules block what is never answered for the person", () => {
  assert.equal(blockedRequest("git push origin main"), true);
  assert.equal(blockedRequest("rm -rf /"), true);
  assert.equal(blockedRequest("powershell -Command Invoke-WebRequest http://127.0.0.1:8000"), false);
});

test("the safety rules read a tool's JSON arguments as the command they carry", () => {
  // A tool's arguments arrive as JSON (the card's toolInput, the app's own workspace approvals), where
  // a newline is "\n": "cd app\ngit push" hid git push from the rules' word boundary.
  assert.equal(blockedRequest(JSON.stringify({ cmd: "cd app\ngit push origin main" })), true);
  assert.equal(blockedRequest(`permission · mcp__coding-tools__exec_command · input ${JSON.stringify({ cmd: "echo ok\r\ngit push --force" })}`), true);
  assert.equal(blockedRequest(JSON.stringify({ cmd: "echo ok\tgit push" })), true);
  // A workspace approval for a write names its path as a JSON string: the quote hid ".env".
  assert.equal(blockedRequest(JSON.stringify({ path: ".env", content: "TOKEN=x" })), true);
  assert.equal(blockedRequest(JSON.stringify({ cmd: "npm test\ngit status" })), false);
});
