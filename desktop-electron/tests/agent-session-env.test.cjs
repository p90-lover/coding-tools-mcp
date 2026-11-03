const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { dropAgentSessionEnvironment } = require("../electron/agent-session-env.cjs");

// The environment of the app's main process after 0.8.80 was installed from an AO Codex chat
// (2026-11-03), values shortened; keys and secrets are placeholders.
const fromAgentShell = () => ({
  PATH: "C:\\Windows",
  USERPROFILE: "C:\\Users\\simon",
  CODING_TOOLS_HOME: "G:\\AppData\\.coding-tools",
  CODING_TOOLS_LAUNCHER_DATA_DIR: "G:\\AppData\\Coding Tools",
  CODEX_CHATGPT_WEB_HOME: "G:\\AppData\\.coding-tools",
  HTTPS_PROXY: "http://proxy.example:10000",
  AO_SESSION_ID: "coding-tools-mcp-230",
  AO_PORT: "64886",
  AO_DATA_DIR: "C:\\Users\\simon\\.ao\\coding-tools",
  CODEX_HOME: "C:\\Users\\simon\\.ao\\coding-tools\\gateway-homes\\codex",
  CODEX_THREAD_ID: "01a17ba2",
  CODEX_SHELL: "1",
  CODEX_CI: "1",
  CODEX_SANDBOX_NETWORK_DISABLED: "1",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
  ANTHROPIC_AUTH_TOKEN: "key",
  ANTHROPIC_API_KEY: "key",
  ANTHROPIC_MODEL: "gpt-6.1-sol",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-6.1-sol",
  ANTHROPIC_SMALL_FAST_MODEL: "gpt-6.1-sol",
  ANTHROPIC_CUSTOM_MODEL_OPTION: "gpt-6.1-sol",
  OPENAI_BASE_URL: "http://127.0.0.1:8317/v1",
  OPENAI_API_KEY: "key",
  AGY_LLM_GATEWAY_URL: "http://127.0.0.1:8317",
  AGY_LLM_GATEWAY_MODELS: "gpt-6.1-sol",
});

test("an app started from an AO gateway chat drops that chat's session, gateway and Codex home", () => {
  const env = fromAgentShell();
  const dropped = dropAgentSessionEnvironment(env);
  assert.deepEqual(Object.keys(env).sort(), [
    "CODEX_CHATGPT_WEB_HOME", "CODING_TOOLS_HOME", "CODING_TOOLS_LAUNCHER_DATA_DIR", "HTTPS_PROXY", "PATH", "USERPROFILE",
  ]);
  assert.ok(dropped.includes("ANTHROPIC_CUSTOM_MODEL_OPTION"));
  assert.ok(dropped.includes("CODEX_HOME"));
  assert.ok(dropped.includes("CODEX_SANDBOX_NETWORK_DISABLED"));
  assert.deepEqual(dropped, [...dropped].sort());
});

test("a person's own API settings and Codex home stay, even when started from an agent", () => {
  const env = {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_API_KEY: "key",
    OPENAI_API_KEY: "key",
    CODEX_HOME: "D:\\codex-home",
  };
  assert.deepEqual(dropAgentSessionEnvironment(env), ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);
  assert.deepEqual(env, { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "key", OPENAI_API_KEY: "key", CODEX_HOME: "D:\\codex-home" });
});

test("an app started normally keeps its whole environment", () => {
  const env = { ...fromAgentShell() };
  for (const key of ["AO_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SHELL"]) delete env[key];
  const before = { ...env };
  assert.deepEqual(dropAgentSessionEnvironment(env), []);
  assert.deepEqual(env, before);
});

test("the app's entry cleans the environment before anything else loads", () => {
  const entry = fs.readFileSync(path.join(__dirname, "..", "electron", "main-with-provider.cjs"), "utf8");
  const code = entry.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("//"));
  assert.match(code[0], /agent-session-env\.cjs"\)\.cleanAgentSessionEnvironment\(\)/);
});
