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

const root = join(tempRoot, `codex-router-agent-type-${process.pid}-${Date.now()}`);
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
routedTemplate.description = "Local-only routed subagent lifecycle fixture";
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

const rootSteps: number[] = [];
const rootRequests: Array<Record<string, unknown>> = [];
const routedRequests: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
const failures: string[] = [];
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

const rootServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") return Response.json(catalog);
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      return new Response("Not found", { status: 404 });
    }
    const body = await request.json() as Record<string, unknown>;
    const step = rootSteps.length;
    rootSteps.push(step);
    rootRequests.push(body);
    return new Response(bridgeToResponsesSSE(rootResponse(step), rootModel, collaborationMap), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  },
});

const routedServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: ROUTED_MODEL, object: "model" }] });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      return new Response("Not found", { status: 404 });
    }
    const body = await request.json() as Record<string, unknown>;
    routedRequests.push({
      authorization: request.headers.get("authorization"),
      body,
    });
    return new Response(
      bridgeToResponsesSSE(finalAnswer("ROUTED_CHILD_OK"), ROUTED_MODEL, collaborationMap),
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      },
    );
  },
});

writeFileSync(join(codexHome, "config.toml"), [
  `model = ${JSON.stringify(rootModel)}`,
  'model_provider = "coding-tools-root"',
  `model_catalog_json = ${JSON.stringify(catalogPath)}`,
  "",
  "[model_providers.coding-tools-root]",
  'name = "Coding Tools model-free root"',
  `base_url = "http://127.0.0.1:${rootServer.port}/v1"`,
  'env_key = "OPENAI_API_KEY"',
  'wire_api = "responses"',
  "requires_openai_auth = false",
  "supports_websockets = false",
  "",
  "[model_providers.codex-router]",
  'name = "Codex Router model-free child"',
  `base_url = "http://127.0.0.1:${routedServer.port}/v1"`,
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

let exitCode = -1;
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
      OPENAI_API_KEY: "local-model-free-root",
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => processHandle.kill(), 60_000);
  [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  clearTimeout(timeout);

  if (exitCode !== 0) failures.push(`Codex routed-agent lifecycle exited ${exitCode}`);
  if (!stdout.includes("ROOT_ROUTED_AGENT_OK")) failures.push("root did not finish routed-agent lifecycle");
  if (routedRequests.length === 0) failures.push("no routed child request reached the codex-router provider");
  const firstRouted = routedRequests[0];
  if (firstRouted?.body.model !== ROUTED_MODEL) {
    failures.push(`routed child model was ${String(firstRouted?.body.model)}, expected ${ROUTED_MODEL}`);
  }
  if (firstRouted?.authorization !== `Bearer ${CALLER_KEY}`) {
    failures.push("routed child did not authenticate with the env-backed caller key");
  }
  if (rootRequests.some(body => body.model === ROUTED_MODEL)) {
    failures.push("routed child leaked back through the root provider instead of switching providers");
  }
  if (rootSteps.length < 3) failures.push(`root lifecycle observed only ${rootSteps.length} response turns`);

  if (failures.length > 0) {
    const redactedRoutedRequests = routedRequests.map(entry => ({
      authorization: entry.authorization ? "Bearer [REDACTED]" : null,
      body: entry.body,
    }));
    throw new Error(
      `${failures.join("; ")}\nRoot requests: ${JSON.stringify(rootRequests)}`
        + `\nRouted requests: ${JSON.stringify(redactedRoutedRequests)}`
        + `\nCodex stdout: ${stdout.slice(-8_000)}\nCodex stderr: ${stderr.slice(-8_000)}`,
    );
  }

  process.stdout.write(
    `CODEX_ROUTER_AGENT_TYPE_SMOKE_OK ${definition.agentName} ${ROUTED_MODEL}\n`,
  );
} finally {
  await rootServer.stop(true);
  await routedServer.stop(true);
  const retained = join(retentionRoot, `${Date.now()}-${process.pid}-${root.split(/[\\/]/).at(-1)}`);
  renameSync(root, retained);
  process.stdout.write(`ROUTED_AGENT_SMOKE_RETAINED ${retained}\n`);
}
