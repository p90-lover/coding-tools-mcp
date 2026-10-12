"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const { routineAppTool } = createAgentOrchestratorWorkflow({ requestHeadless: async () => ({ ok: true }) });

test("Approve for me answers the app's own reads and worktree edits itself", () => {
  for (const name of ["list_dir", "read_file", "search_text", "git_status", "git_diff", "git_log", "view_image", "apply_patch", "patch_check", "read_output"]) {
    assert.ok(routineAppTool(`mcp__coding-tools__${name}`), name);
  }
});

test("the terminal, the screen, unknown tools and look-alike servers still go to the person", () => {
  for (const name of [
    "mcp__coding-tools__exec_command", "mcp__coding-tools__write_stdin", "mcp__coding-tools__kill_command",
    "mcp__coding-tools__computer_click", "mcp__coding-tools__capture_screenshot", "mcp__coding-tools__list_windows",
    "mcp__coding-tools__vision_status", "mcp__coding-tools__delete_everything",
    "mcp__coding-tools-evil__read_file", "mcp__coding_tools__read_file", "mcp__other__read_file", "read_file",
    "mcp__coding-tools__read_file_extra", "", undefined,
  ]) assert.equal(routineAppTool(name), null, String(name));
});
