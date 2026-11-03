const path = require("node:path");

// An app started from inside an agent's shell (an install or a relaunch that a Codex or Claude
// chat ran) inherits that one chat's environment, and passes it on to everything it starts.
// Seen 2026-11-03 after 0.8.80's install from an AO Codex chat: the app and AO ran with the chat's
// CODEX_HOME (AO's CPA-only gateway home), so the bridge's Codex route refused the journal of
// ~/.codex; with its ANTHROPIC_CUSTOM_MODEL_OPTION, so AO no longer offered Claude Code the model a
// card picked and every DeepSeek card failed at "Invalid value for config option model"; and with
// CODEX_SANDBOX_NETWORK_DISABLED, AO_SESSION_ID and the gateway's keys for every later agent.

// Set only inside an agent session: AO's agents, Codex's shell and Claude Code.
const SESSION_MARKERS = ["AO_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SHELL", "CLAUDECODE"];
const CLAUDE_SESSION_KEYS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION"];
// AO's gateway (session_manager/gateway.go) points each agent family at CPA on loopback. A family is
// dropped only when its address is loopback, so a person's own API settings stay.
const GATEWAY_FAMILIES = [
  { url: "ANTHROPIC_BASE_URL", keys: /^ANTHROPIC_(?:BASE_URL|AUTH_TOKEN|API_KEY|MODEL|DEFAULT_\w+_MODEL|SMALL_FAST_MODEL|CUSTOM_MODEL_OPTION)$/ },
  { url: "OPENAI_BASE_URL", keys: /^OPENAI_(?:BASE_URL|API_KEY)$/ },
  { url: "AGY_LLM_GATEWAY_URL", keys: /^AGY_LLM_GATEWAY_\w+$/ },
];

function loopback(value) {
  try {
    const host = new URL(String(value ?? "").trim()).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** Removes an agent session's own variables from `env`; returns the names removed (never values). */
function dropAgentSessionEnvironment(env = process.env) {
  if (!SESSION_MARKERS.some((key) => env[key])) return [];
  const drop = (key) => key.startsWith("AO_")
    || (key.startsWith("CODEX_") && key !== "CODEX_HOME" && !key.startsWith("CODEX_CHATGPT_WEB_"))
    || CLAUDE_SESSION_KEYS.includes(key)
    || GATEWAY_FAMILIES.some((family) => family.keys.test(key) && loopback(env[family.url]));
  const dropped = Object.keys(env).filter(drop);
  // A person's own CODEX_HOME stays; AO's per-gateway home is never theirs.
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome && path.resolve(codexHome).toLowerCase().split(/[\\/]+/).includes("gateway-homes")) dropped.push("CODEX_HOME");
  for (const key of dropped) delete env[key];
  return dropped.sort();
}

let dropped = [];
/** Runs once, first thing in the app's entry, before any module reads the environment. */
function cleanAgentSessionEnvironment() {
  dropped = dropAgentSessionEnvironment(process.env);
  return dropped;
}
const droppedAgentSessionEnvironment = () => [...dropped];

module.exports = { cleanAgentSessionEnvironment, dropAgentSessionEnvironment, droppedAgentSessionEnvironment };
