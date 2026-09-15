import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bridgeToResponsesSSE } from "../src/bridge";
import { routedAgentDefinition } from "../src/routed-agent-catalog";
import type { AdapterEvent } from "../src/types";
import { resolveCodexSmokeExecutable } from "./codex-smoke-path";

const ROUTED_MODEL = "commandcode-proxy/claude-sonnet-4-6";
const CALLER_KEY = "model_free_router_caller_key_abcdefghijklmnopqrstuvwxyz012345";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const tempRoot = resolve(process.env.CODING_TOOLS_TEMP_ROOT || join(repoRoot, "aiTemp", "tmp"));
const retentionRoot = resolve(
  process.env.CODING_TOOLS_RETENTION_ROOT || join(repoRoot, "aiTemp", "Trash", "routed-agent-smoke"),
);
mkdirSync(tempRoot, { recursive: true });
mkdirSync(retentionRoot, { recursive: true });

const root = join(tempRoot, `codex-router-global-agent-${process.pid}-${Date.now()}`);
const codexHome = join(root, "codex");
const agentsDir = join(codexHome, "agents");
mkdirSync(agentsDir, { recursive: true, mode: 0o700 });

const codex = resolveCodexSmokeExecutable(process.argv.slice(2), process.env, process.platform);
if (!existsSync(codex)) throw new Error(`Codex executable is missing: ${codex}`);

const bundled = spawnSync(codex, ["debug", "models", "--bundled"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 15_000,
});
if (bundled.status !== 0) {
  throw new Error(`Could not read bundled Codex models: ${bundled.error?.message || bundled.stderr}`);
}

const sourceCatalog = JSON.parse(bundled.stdout) as { models?: Array<Record<string, unknown>> };
if (!Array.isArray(sourceCatalog.models) || sourceCatalog.models.length === 0) {
  throw new Error("Pinned Codex bundled model catalog is empty");
}
const rootTemplate = sourceCatalog.models.find(model => model.slug === "gpt-5.6-sol")
  || sourceCatalog.models.find(model => model.visibility === "list" && typeof model.slug === "string");
if (!rootTemplate || typeof rootTemplate.slug !== "string") {
  throw new Error("Pinned Codex catalog has no usable root model");
}
const rootModel = rootTemplate.slug;
const routedTemplate = structuredClone(rootTemplate);
routedTemplate.slug = ROUTED_MODEL;
routedTemplate.display_name = `${ROUTED_MODEL} model-free routed smoke`;
routedTemplate.description = "Local-only global-router subagent lifecycle fixture";
routedTemplate.visibility = "list";
routedTemplate.supported_in_api = true;
routedTemplate.multi_agent_version = "v2";
routedTemplate.tool_mode = null;
routedTemplate.additional_speed_tiers = [];
routedTemplate.service_tiers = [];
routedTemplate.default_service_tier = null;
delete routedTemplate.comp_hash;
delete routedTemplate.availability_nux;
const catalog = {
  ...sourceCatalog,
  models: [...sourceCatalog.models, routedTemplate],
};
const catalogPath = join(root, "models.json");
writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, { encoding: "utf8", mode: 0o600 });

const definition = routedAgentDefinition(ROUTED_MODEL);
writeFileSync(join(agentsDir, definition.fileName), definition.contents, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});

const rootRequests: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
const childRequests: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
const failures: string[] = [];
let rootStep = 0;
const collaborationMap = new Map([
  ["spawn_agent", { namespace: "collaboration", name: "spawn_agent" }],
  ["wait_agent", { namespace: "collaboration", name: "wait_agent" }],
]);

async function* toolCall(name: string, args: Record<string, unknown>): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: `call_${name}_${crypto.randomUUID()}`, name };
  yield { type: "tool_call_delta", arguments: JSON.stringify(args) };
  yield { type: "tool_call_end" };
  yield { type: "done", stopReason: "tool_use", endTurn: false };
}

async function* finalAnswer(text: string): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text, phase: "final_answer" };
  yield { type: "done", stopReason: "stop", endTurn: true };
}

function rootResponse(step: number): AsyncIterable<AdapterEvent> {
  if (step === 0) {
    return toolCall("spawn_agent", {
      task_name: "routed_child",
      message: "ROUTED_CHILD: reply with exactly ROUTED_CHILD_OK.",
      agent_type: definition.agentName,
      fork_turns: "none",
    });
  }
  if (step === 1) return toolCall("wait_agent", { timeout_ms: 500 });
  return finalAnswer("ROOT_ROUTED_AGENT_OK");
}

const routerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json(catalog);
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      return new Response("Not found", { status: 404 });
    }
    const body = await request.json() as Record<string, unknown>;
    const entry = { authorization: request.headers.get("authorization"), body };
    if (body.model === ROUTED_MODEL) {
      childRequests.push(entry);
      return new Response(
        bridgeToResponsesSSE(finalAnswer("ROUTED_CHILD_OK"), ROUTED_MODEL, collaborationMap),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    }
    if (body.model !== rootModel) {
      failures.push(`unexpected global-router model ${String(body.model)}`);
      return Response.json({ error: { message: failures.at(-1) } }, { status: 400 });
    }
    rootRequests.push(entry);
    const step = rootStep++;
    return new Response(bridgeToResponsesSSE(rootResponse(step), rootModel, collaborationMap), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});

writeFileSync(join(codexHome, "config.toml"), [
  `model = ${JSON.stringify(rootModel)}`,
  'model_provider = "codex-router"',
  `model_catalog_json = ${JSON.stringify(catalogPath)}`,
  "",
  "[model_providers.codex-router]",
  'name = "Codex Router model-free global provider"',
  `base_url = "http://127.0.0.1:${routerServer.port}/v1"`,
  'env_key = "CODING_TOOLS_CODEX_ROUTER_CALLER_KEY"',
  'wire_api = "responses"',
  "requires_openai_auth = false",
  "supports_websockets = false",
  "",
  "[agents]",
  "max_depth = 2",
  "",
  "[features]",
  "multi_agent = true",
  "",
  "[features.multi_agent_v2]",
  "enabled = true",
  "min_wait_timeout_ms = 100",
  "max_wait_timeout_ms = 5000",
  "default_wait_timeout_ms = 500",
  "",
].join("\n"), { encoding: "utf8", mode: 0o600 });

let stdout = "";
let stderr = "";
try {
  const processHandle = Bun.spawn([
    codex,
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--sandbox",
    "read-only",
    "--model",
    rootModel,
    "ROOT_ROUTED_AGENT: delegate to the named routed child and report only its result.",
  ], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => processHandle.kill(), 60_000);
  const [exitCode, processStdout, processStderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  clearTimeout(timeout);
  stdout = processStdout;
  stderr = processStderr;

  if (exitCode !== 0) failures.push(`Codex global-router lifecycle exited ${exitCode}`);
  if (!stdout.includes("ROOT_ROUTED_AGENT_OK")) failures.push("root did not finish global-router lifecycle");
  if (childRequests.length === 0) failures.push("no routed child request reached the global router provider");
  if (childRequests[0]?.body.model !== ROUTED_MODEL) {
    failures.push(`child model was ${String(childRequests[0]?.body.model)}, expected ${ROUTED_MODEL}`);
  }
  const allRequests = [...rootRequests, ...childRequests];
  if (allRequests.some(entry => entry.authorization !== `Bearer ${CALLER_KEY}`)) {
    failures.push("one or more global-router requests did not use the env-backed caller key");
  }
  if (rootRequests.length < 3) failures.push(`root lifecycle observed only ${rootRequests.length} response turns`);

  if (failures.length > 0) {
    const redacted = allRequests.map(entry => ({
      authorization: entry.authorization ? "Bearer [REDACTED]" : null,
      model: entry.body.model,
    }));
    throw new Error(
      `${failures.join("; ")}\nRequests: ${JSON.stringify(redacted)}`
        + `\nCodex stdout: ${stdout.slice(-8_000)}\nCodex stderr: ${stderr.slice(-8_000)}`,
    );
  }

  process.stdout.write(
    `CODEX_ROUTER_GLOBAL_AGENT_SMOKE_OK ${definition.agentName} ${rootModel} -> ${ROUTED_MODEL}\n`,
  );
} finally {
  await routerServer.stop(true);
  const retained = join(retentionRoot, `${Date.now()}-${process.pid}-${root.split(/[\\/]/).at(-1)}`);
  renameSync(root, retained);
  process.stdout.write(`ROUTED_AGENT_SMOKE_RETAINED ${retained}\n`);
}
