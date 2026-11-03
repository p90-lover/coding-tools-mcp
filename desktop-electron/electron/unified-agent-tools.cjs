"use strict";

// The person's own file tools (github.com/p90-lover/unified-agent-tools, vendored under
// vendor/unified-agent-tools) for every chat session that runs a GPT model, next to the app's
// coding-tools server. GPT agents searched with shell rg/findstr and read with Get-Content: on a
// large repository that timed out or flooded the context, and the agent concluded "not found".
// These tools honor .gitignore, answer within a deadline and an output budget, and say whether a
// search was complete, so the session is told to use them for every file operation instead.
//
// A stdio MCP server the agent's harness starts in the session's own worktree (Codex starts its
// MCP servers in its app-server's directory, which AO sets to the worktree):
// - pinned there (UNIFIED_AGENT_TOOLS_ROOT=cwd): every path, and any workspaceRoot it is given,
//   must resolve inside it, the same scope as the app's own apply_patch;
// - its "files" profile only: no shell, web fetch or desktop capture, which stay with the app's
//   own reviewed, sandboxed tools (exec_command, preview_*, capture_*);
// - run by the app's own executable as Node (ELECTRON_RUN_AS_NODE), so no Node install is needed.

const fs = require("node:fs");
const path = require("node:path");

const SERVER_NAME = "unified-agent-tools";
// What the app's coding-tools server leaves out of a session that has these: the same jobs, done
// by one tool each, so the model has one obvious choice (chat-agent-tools.cjs listTools).
const DUPLICATE_TOOLS = Object.freeze(new Set(["read_file", "list_dir", "list_files", "search_text", "apply_patch", "patch_check"]));
// The tools a session is told about (the server's "files" profile).
const FILE_TOOLS = Object.freeze(["Read", "ReadMany", "Grep", "SearchAndRead", "Glob", "ListDirectory", "Edit", "ApplyMultipleEdits", "Write", "MoveToTrash", "ViewImage"]);

/**
 * Whether a chat session runs a GPT model, by its AO harness ("codex", "claude-code", "opencode",
 * …) and the model it was launched with, as agent-orchestrator-workflow.cjs sends it: "default" or
 * empty (the harness's own default model), a native id ("gpt-5.6", "gpt-5.6-terra"), or a CPA pool
 * model through the local gateway, which any harness can run, so a Codex session may run Claude
 * and Claude Code may run GPT: "gpt-5.5", "gpt-5.5(high)", opencode's "openai/gpt-5.5",
 * "claude-opus-4-7", "deepseek-v4.1-flash".
 */
function isGptModel(agent, model) {
  // Without its effort suffix ("(high)"), in any case.
  const id = String(model ?? "").trim().toLowerCase().replace(/\([^)]*\)$/, "");
  // A harness's own default is GPT only on Codex; opencode's depends on its own config, so it keeps
  // the app's file tools.
  if (!id || id === "default") return agent === "codex";
  // WebGPT's tiers ("chatgpt-web/high") are ChatGPT itself.
  if (id.startsWith("chatgpt-web/")) return true;
  // The model after any provider prefix ("openai/", "cpa/"): GPT, open-weight gpt-oss, Codex's own
  // models and OpenAI's o-series.
  const name = id.slice(id.lastIndexOf("/") + 1);
  return /^(?:gpt-|chatgpt-|codex-|o\d+(?:-|$))/.test(name);
}

/** The vendored server: next to the app's resources once packaged, else in the source tree. */
function defaultServerPath({ packaged = false, resourcesPath = process.resourcesPath } = {}) {
  return packaged
    ? path.join(resourcesPath, "unified-agent-tools", "mcp", "server.mjs")
    : path.join(__dirname, "..", "vendor", "unified-agent-tools", "mcp", "server.mjs");
}

/**
 * A ripgrep for the server's searches (they fall back to git's index, then a walk, without one):
 * on PATH, else the copy Codex installs with itself. Codex may start MCP servers with a trimmed
 * environment, so the path is handed to the server rather than left to its own PATH lookup.
 */
async function findRipgrep(env = process.env, platform = process.platform) {
  const name = platform === "win32" ? "rg.exe" : "rg";
  const candidates = String(env.PATH ?? "").split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry)).map((entry) => path.join(entry, name));
  if (platform === "win32" && env.APPDATA) {
    candidates.push(path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64",
      "vendor", "x86_64-pc-windows-msvc", "codex-path", name));
  }
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

// Asynchronous on purpose: these run on Electron main at every chat launch, where a synchronous
// stat holds every window for as long as the hard disk takes (main-sync-calls.test.cjs).
const isFile = (filePath) => fs.promises.stat(filePath).then((stat) => stat.isFile(), () => false);

function createUnifiedAgentTools({ serverPath = defaultServerPath(), nodePath = process.execPath, enabled = () => true, ripgrep = findRipgrep, logger = null } = {}) {
  let missingLogged = false;
  // Looked up once, by the first GPT chat; launches at the same time share the lookup.
  let ripgrepLookup = null;
  return Object.freeze({
    SERVER_NAME,
    /**
     * The AO session config of the server for one chat session (POST /sessions and
     * /resume-agent mcpServers), or null when the session does not run a GPT model, the user
     * turned the tools off, or the server is not installed. Never fails a launch.
     */
    async forSession(agent, model) {
      try {
        if (!enabled() || !isGptModel(agent, model)) return null;
        if (!await isFile(serverPath)) {
          if (!missingLogged) logger?.warn?.("unified_agent_tools.missing", { serverPath });
          missingLogged = true;
          return null;
        }
      } catch (cause) {
        logger?.warn?.("unified_agent_tools.unavailable", { message: String(cause?.message || cause).slice(0, 200) });
        return null;
      }
      ripgrepLookup ??= Promise.resolve().then(() => ripgrep()).then((found) => found ?? null, () => null);
      const ripgrepPath = await ripgrepLookup;
      return {
        name: SERVER_NAME, type: "stdio", command: nodePath, args: [serverPath, "--stdio"],
        env: { ELECTRON_RUN_AS_NODE: "1", UNIFIED_AGENT_TOOLS_ROOT: "cwd", UNIFIED_AGENT_TOOLS_PROFILE: "files",
          ...(ripgrepPath ? { UNIFIED_AGENT_TOOLS_RG: ripgrepPath } : {}) },
      };
    },
  });
}

module.exports = Object.freeze({ DUPLICATE_TOOLS, FILE_TOOLS, SERVER_NAME, createUnifiedAgentTools, defaultServerPath, findRipgrep, isGptModel });
