"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function clean(value, limit, required = true) {
  if (typeof value !== "string") throw new Error("Expected text");
  const text = value.trim();
  if ((required && !text) || text.length > limit || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
    throw new Error("Text is empty, too long, or contains control characters");
  }
  return text;
}

function clausesFrom(value) {
  const clauses = value?.clauses;
  if (!Array.isArray(clauses) || clauses.length < 1 || clauses.length > 12) {
    throw new Error("Provide between one and twelve clauses");
  }
  return clauses.map((item) => ({
    title: clean(item?.title, 240),
    detail: clean(item?.detail ?? "", 8192, false),
  }));
}

// Codex's own permission profiles: read-only, or workspace (create, edit and delete inside the
// workspace; anything else is asked for). Native standalone command execution stays off.
const AO_PERMISSION_PROFILES = [":read-only", ":workspace"];

async function resolveAoNativeConnection({ workspaceId, runId, nodeId, executable, model, permissionProfile = ":read-only", userData }) {
  if (!AO_PERMISSION_PROFILES.includes(permissionProfile)) throw new Error("Choose read-only or workspace permission for this card");
  if (!path.isAbsolute(executable) || !path.isAbsolute(userData)) {
    throw new Error("Select absolute native Codex executable and application-data paths");
  }
  const resolved = await fs.promises.realpath(executable);
  const metadata = await fs.promises.stat(resolved);
  if (!metadata.isFile() || metadata.size > 512 * 1024 * 1024
    || process.platform === "win32" && !resolved.toLowerCase().endsWith(".exe")) {
    throw new Error("Select a native codex.exe within the 512 MiB inspection limit");
  }
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(resolved);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const nodeHash = createHash("sha256").update(JSON.stringify([
    clean(workspaceId, 128), clean(runId, 80), clean(nodeId, 80),
  ])).digest("hex");
  return {
    executable: resolved, expected_sha256: hash.digest("hex"),
    codex_home: path.join(userData, "headless", "ao-homes", nodeHash),
    allow_model_usage: true, allow_command_execution: false,
    permission_profile: permissionProfile, model: clean(model, 128),
    request_limit: 3, lifetime_seconds: 900,
  };
}

function permissionText(profile) {
  return profile === ":workspace" ? "workspace (create, edit and delete inside the workspace)" : "read-only";
}

// The installed Codex desktop app keeps its CLI at %LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe;
// the newest build wins. A chat send or a Start/Resume without a chosen executable uses it.
// The Codex CLI (npm install -g @openai/codex) ships its native binary inside the package.
function codexCliExecutable(env = process.env, arch = process.arch) {
  if (process.platform !== "win32" || !env.APPDATA) return null;
  const [pkg, triple] = arch === "arm64"
    ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"] : ["codex-win32-x64", "x86_64-pc-windows-msvc"];
  const file = path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", pkg, "vendor", triple, "bin", "codex.exe");
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

// Missions run on the Codex CLI harness; the copy bundled with the Codex desktop app is only
// a fallback when the CLI is not installed.
function isDesktopBundledCodex(file, env = process.env) {
  if (!env.LOCALAPPDATA || typeof file !== "string") return false;
  const root = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin").toLowerCase() + path.sep;
  return path.resolve(file).toLowerCase().startsWith(root);
}

function findInstalledCodexExecutable(env = process.env) {
  const cli = codexCliExecutable(env);
  if (cli) return cli;
  if (process.platform !== "win32" || !env.LOCALAPPDATA) return null;
  const root = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  let best = null;
  let builds = [];
  try { builds = fs.readdirSync(root); } catch { return null; }
  for (const build of builds) {
    const file = path.join(root, build, "codex.exe");
    try {
      const metadata = fs.statSync(file);
      if (metadata.isFile() && (!best || metadata.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: metadata.mtimeMs };
    } catch {}
  }
  return best?.file ?? null;
}

const CHAT_TASK_TITLE = "New task";

// The WebGPT tiers the bridge serves; it runs a tier the account lacks at the nearest lower one.
const WEB_TIERS = ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro"];
const LUNA_TIERS = ["chatgpt-web/luna", "chatgpt-web/think"];
// AO harness models shown as "cpa/<model>" run that CPA pool model through the local gateway.
const CPA_MODEL_PREFIX = "cpa/";
// Agents AO's daemon can point at the CPA gateway, each through its own launch variables
// (Claude Code: ANTHROPIC_*, Codex: a CPA-only CODEX_HOME, opencode: OPENAI_*, agy: its
// AGY_LLM_GATEWAY_* mode, which needs no Google sign-in). Other agents get only their own models.
const GATEWAY_AGENTS = new Set(["claude-code", "codex", "opencode", "agy"]);
// agy reads "gemini-<version>-flash-<level>" as its own model plus a thinking level and asks the
// gateway for "gemini-<version>-flash", which CPA does not serve, so those stay off agy.
const gatewayModelFits = (agent, model) => agent !== "agy" || !/^gemini-[\d.]+-flash-(low|medium|high)$/.test(model);
const webModel = (model) => WEB_TIERS.includes(model) || LUNA_TIERS.includes(model);

// The runtime's `catalog ao-web` returns one WebGPT row: High, or Luna on a Luna-only (Free/Go)
// account that has no Sol tiers. Any tier reuses that row under its own slug; the bridge picks
// the ChatGPT mode from the slug, not from this entry.
function aoWebCatalogForModel(catalog, model) {
  if (!/^chatgpt-web\/[a-z-]{1,32}$/.test(model)) throw new Error("AO WebGPT model is invalid");
  const template = Array.isArray(catalog?.models) && catalog.models.length === 1 ? catalog.models[0] : null;
  if (typeof template?.slug !== "string" || !/^chatgpt-web\/[a-z-]{1,32}$/.test(template.slug)) {
    throw new Error("AO WebGPT catalog is unavailable");
  }
  if (template.slug === model) return catalog;
  const tier = model.slice("chatgpt-web/".length).split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
  return { models: [{ ...template, slug: model, display_name: `ChatGPT Web — ${tier}` }] };
}

function createAgentOrchestratorWorkflow({ requestHeadless, cpaConnection, webBridgeConnection, webModelCatalog, confirm, resolveHarness, aoHarness, fetchImpl = fetch, findCodexExecutable = findInstalledCodexExecutable, exists = (file) => fs.existsSync(file), onRunState = null }) {
  // A saved path goes stale when the Codex app updates itself (it replaces bin\<build>\), so a
  // chosen executable that no longer exists falls back to the currently installed one.
  function codexExecutable(chosen) {
    const picked = typeof chosen === "string" && chosen.trim() ? clean(chosen, 1024) : "";
    const found = findCodexExecutable();
    // A saved desktop-app copy (the old default) gives way to the Codex CLI when it is installed.
    if (picked && exists(picked) && !(found && isDesktopBundledCodex(picked) && !isDesktopBundledCodex(found))) return picked;
    if (found) return found;
    throw new Error(picked
      ? `The saved codex.exe no longer exists (${picked}) and no Codex CLI was found`
      : "The Codex CLI was not found; install it with npm install -g @openai/codex, or choose a codex.exe in AO settings");
  }
  const backgroundRuns = new Map();
  // Background-run observations for MCP event incidents (stall, held, approval waits).
  // An observer failure must never affect the run it watches.
  function reportRun(workspaceId, runId, state, mission, attention = null) {
    if (!onRunState) return;
    try {
      onRunState({
        workspaceId, runId, status: state.status, detail: state.detail, stopped: state.stopped === true, attention,
        ...(mission ? { fingerprint: (mission.nodes ?? []).map((node) => `${node.id}:${node.state}`).join(",") } : {}),
      });
    } catch { /* observational only */ }
  }
  const dispatching = new Set();
  const nodeKey = (workspaceId, runId, nodeId) => JSON.stringify([workspaceId, runId, nodeId]);
  // Any card (orchestrator, worker or reviewer) on an AO harness runs as an AO session.
  const externalAgent = (node) => typeof node?.route?.harness_id === "string"
    && node.route.harness_id.startsWith("ao:") ? node.route.harness_id.slice(3) : null;
  function harnessService() {
    if (!aoHarness) throw new Error("Agent Orchestrator harnesses are unavailable");
    return aoHarness;
  }
  const runKey = (workspaceId, runId) => JSON.stringify([workspaceId, runId]);
  async function tool(workspaceId, name, arguments_) {
    const response = await requestHeadless("/api/v1/tools/call", {
      request_id: randomUUID(),
      workspace_id: clean(workspaceId, 128),
      tool: name,
      arguments: arguments_,
    });
    const operation = response?.operation;
    if (operation?.state !== "completed" || !operation.result) {
      throw new Error("Workflow outcome is unknown; refresh the board before trying again");
    }
    return operation.result;
  }

  function checked(result) {
    if (result?.ok === false) throw new Error(result.error?.message || "Workflow operation failed");
    return result;
  }

  async function write(workspaceId, arguments_) {
    let result = await tool(workspaceId, "workflow_update", arguments_);
    if (result?.error?.code === "APPROVAL_REQUIRED") {
      const requestId = result.error?.details?.request_id;
      if (typeof requestId !== "string") throw new Error("Workflow approval request is invalid");
      const grant = checked(await tool(workspaceId, "request_permissions", {
        request_id: requestId, scope: "once", confirm: true,
      }));
      result = await tool(workspaceId, "workflow_update", {
        ...arguments_, approval_token: grant.approval_token,
      });
    }
    return checked(result);
  }

  async function board({ workspaceId, taskId } = {}) {
    const result = checked(await tool(workspaceId, "workflow_list", {
      ...(taskId ? { task_id: clean(taskId, 128) } : {}),
      limit: 100,
      include_archived: false,
    }));
    return { ok: true, revision: result.revision, steps: result.steps, tasks: result.tasks ?? [],
      task: result.task ?? null, workspaceId: result.workspace_id };
  }

  function connection() {
    const value = cpaConnection();
    if (!value?.proxyApiKey) throw new Error("Start managed CPA and configure a proxy API key first");
    const url = new URL(value.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "8317"
      || url.username || url.password || url.search || url.hash) {
      throw new Error("CPA must use its managed local endpoint");
    }
    return { baseUrl: url.origin, key: value.proxyApiKey };
  }

  async function models({ harness, workspaceId } = {}) {
    if (typeof harness === "string" && harness.startsWith("ao:")) {
      const items = await harnessService().models(harness.slice(3), workspaceId);
      // Every CPA pool model can also run on this agent through the local gateway ("cpa/<model>"),
      // except WebGPT, which only works through the bridge on Native Codex.
      let cpa = [];
      if (GATEWAY_AGENTS.has(harness.slice(3))) {
        try {
          cpa = (await models()).models.filter(id => !id.startsWith("chatgpt-web/") && gatewayModelFits(harness.slice(3), id))
            .map(id => `${CPA_MODEL_PREFIX}${id}`);
        } catch { /* CPA not running: own models only. */ }
      }
      // An agent may report WebGPT from the user's Codex config; it cannot run it, so it is left out here.
      // "default" is not offered: it lets the agent pick, and silently change, its own model.
      return { ok: true, harness, models: [...items.map(item => item.id).filter(id => id !== "default" && !id.startsWith("chatgpt-web/")), ...cpa] };
    }
    if (harness === "codex-native") {
      // Native Codex runs only WebGPT (every tier, Luna and Think included). CPA pool models run on
      // an AO harness through the gateway ("cpa/<model>").
      return { ok: true, harness, models: [...WEB_TIERS, ...LUNA_TIERS] };
    }
    const { baseUrl, key } = connection();
    const response = await fetchImpl(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`CPA model catalog returned HTTP ${response.status}`);
    const payload = await response.json();
    const ids = [...new Set((Array.isArray(payload?.data) ? payload.data : [])
      .map((entry) => entry?.id).filter((id) => typeof id === "string" && id.length <= 128))].slice(0, 100);
    if (!ids.length) throw new Error("CPA has no available models");
    return { ok: true, models: ids };
  }

  // Native Codex runs WebGPT/CPA routes in-process; every other worker harness is AO's own.
  async function harnesses() {
    const native = { id: "codex-native", label: "Native Codex", runnable: true, installed: true, authStatus: "configured" };
    try {
      const catalog = await harnessService().catalog();
      return { ok: true, harnesses: [native, ...catalog.map(item => ({ id: `ao:${item.id}`, label: item.label,
        installed: item.installed, authStatus: item.authStatus, chat: item.chat, runnable: item.installed }))] };
    } catch (error) {
      return { ok: true, harnesses: [native], notice: String(error?.message || "AO harness catalog unavailable").slice(0, 300) };
    }
  }

  async function dispatchExternal(workspaceId, runId, node, expectedRevision, background) {
    const agent = externalAgent(node);
    const key = nodeKey(workspaceId, runId, node.id);
    if (dispatching.has(key)) return { ok: true, waiting: true, reason: "dispatching" };
    dispatching.add(key);
    try {
      const reserved = await requestHeadless("/api/v1/ao/external/reserve", {
        workspace_id: workspaceId, run_id: runId, node_id: node.id,
        expected_revision: expectedRevision, confirm: !background,
      }, background ? undefined : { localConfirmation: true });
      if (reserved?.ok === true && reserved.waiting) return reserved;
      if (reserved?.ok !== true || typeof reserved.request_key !== "string") throw new Error("AO harness reservation outcome is unknown");
      let session = null;
      let failure = null;
      try {
        const viaCpa = node.route.model.startsWith(CPA_MODEL_PREFIX) ? node.route.model.slice(CPA_MODEL_PREFIX.length) : null;
        if (viaCpa && (!GATEWAY_AGENTS.has(agent) || !gatewayModelFits(agent, viaCpa))) {
          throw new Error(`${node.settings?.name || "This card"}: ${agent} cannot use CPA models (${node.route.model}); choose one of its own models`);
        }
        // The gateway serves CPA through OpenAI- and Anthropic-compatible endpoints; opencode names
        // models as provider/model, so a CPA model is its OpenAI provider's "openai/<model>".
        const agentModel = viaCpa && agent === "opencode" ? `openai/${viaCpa}` : viaCpa ?? node.route.model;
        session = await harnessService().spawn({ workspaceId, agent, model: agentModel, prompt: reserved.prompt,
          name: node.settings?.name || "AO worker", ...(viaCpa ? { gateway: { provider: "cpa", model: viaCpa } } : {}),
          // AO applies effort to the agent's own models; a gateway model skips AO's effort check by design.
          ...(!viaCpa && node.route.effort ? { effort: node.route.effort } : {}) });
      } catch (error) { failure = error; }
      const saved = await requestHeadless("/api/v1/ao/external/submitted", {
        workspace_id: workspaceId, run_id: runId, node_id: node.id, request_key: reserved.request_key,
        ...(session ? { session_id: session } : {}),
      });
      if (failure) throw failure;
      if (saved?.ok !== true) throw new Error("AO harness session outcome is unknown");
      return { ok: true, run: saved.run, session_id: session };
    } finally { dispatching.delete(key); }
  }

  const TERMINAL_TURNS = new Set(["completed", "failed", "interrupted", "cancelled", "recovered"]);
  async function observeExternal(workspaceId, runId, node) {
    const session = node.receipt?.thread_id;
    if (node.state === "reserved" && !dispatching.has(nodeKey(workspaceId, runId, node.id))) {
      // The launch was lost before AO returned a session; hold it rather than replay.
      const held = await requestHeadless("/api/v1/ao/external/submitted", {
        workspace_id: workspaceId, run_id: runId, node_id: node.id, request_key: node.receipt?.request_key || node.request_key,
      });
      return { ok: true, run: held?.run, pending_approvals: [] };
    }
    if (node.state !== "running" || !session) return { ok: true, pending_approvals: [] };
    const observed = await harnessService().observe(session);
    const terminal = TERMINAL_TURNS.has(observed.turnState) || observed.exited;
    if (!terminal) return { ok: true, pending_approvals: [], needs_input: observed.needsInput, session_id: session };
    const completed = observed.turnState === "completed";
    const result = await requestHeadless("/api/v1/ao/external/terminal", {
      workspace_id: workspaceId, run_id: runId, node_id: node.id, session_id: session,
      ...(observed.turnId ? { turn_id: observed.turnId } : {}),
      ...(observed.answer ? { answer: observed.answer } : {}),
      completed,
      ...(!completed ? { failure: observed.error || (observed.exited ? "AO session exited before a final answer" : `AO turn ${observed.turnState}`) } : {}),
    });
    if (result?.ok !== true) throw new Error("AO harness result could not be saved; inspect the card");
    return { ...result, pending_approvals: [] };
  }

  async function savedNode(workspaceId, runId, nodeId) {
    const saved = await runs({ workspaceId, runId });
    const mission = saved.runs.find((entry) => entry.id === runId && entry.workspace_id === workspaceId);
    return { mission, node: mission?.nodes?.find((entry) => entry.id === nodeId) };
  }

  async function runs({ workspaceId, runId } = {}) {
    const id = clean(workspaceId, 128);
    const response = await requestHeadless("/api/v1/ao/read", {
      workspace_id: id,
      ...(runId ? { run_id: clean(runId, 80) } : {}),
    });
    if (response?.ok !== true || !Array.isArray(response.runs)) {
      throw new Error("AO run read failed");
    }
    return response;
  }

  async function updateRun({ workspaceId, change } = {}) {
    const id = clean(workspaceId, 128);
    if (!change || typeof change !== "object" || Array.isArray(change)
      || !["create", "create_from_team", "graph", "cancel"].includes(change.operation)) {
      throw new Error("Choose a supported AO graph change");
    }
    clean(change.operation === "create" ? change.run?.id : change.run_id, 80);
    if (change.operation === "create" && Array.isArray(change.run?.nodes)) {
      for (const node of change.run.nodes) {
        clean(node?.role, 20); clean(node?.route?.harness_id, 128); clean(node?.route?.model, 128);
      }
    }
    // Relinking or removing a card that is working stops its turn; the engine has already put the
    // attempt into history (rewire) or removed the card, and ignores the late result.
    const graphChange = change.operation === "graph" ? change.change : null;
    const touched = ["set_parents", "remove_node"].includes(graphChange?.operation) ? clean(graphChange.node_id, 80) : "";
    let before;
    if (touched) {
      const saved = await runs({ workspaceId: id, runId: clean(change.run_id, 80) });
      before = saved.runs.find((run) => run.id === change.run_id)?.nodes?.find((node) => node.id === touched);
    }
    const response = await requestHeadless("/api/v1/ao/update", {
      workspace_id: id, change, confirm: true,
    }, { localConfirmation: true });
    if (response?.ok !== true || response.run?.workspace_id !== id) {
      throw new Error("AO run update failed; refresh before retrying");
    }
    if (before && ["running", "reserved"].includes(before.state)) {
      const after = response.run.nodes?.find((node) => node.id === touched);
      if (!after || after.state === "pending") {
        if (externalAgent(before) && before.receipt?.thread_id) {
          await harnessService().interrupt(before.receipt.thread_id).catch(() => undefined);
        } else {
          await requestHeadless("/api/v1/ao/harness/disconnect", {
            workspace_id: id, run_id: change.run_id, node_id: touched, confirm: true,
          }, { localConfirmation: true }).catch(() => undefined);
        }
      }
    }
    return response;
  }

  async function teamUpdate({ workspaceId, change } = {}) {
    if (!change || typeof change !== "object" || Array.isArray(change)
      || !["save_team", "apply_team", "set_limits"].includes(change.operation)) {
      throw new Error("Choose a supported local team setting");
    }
    const response = await requestHeadless("/api/v1/ao/update", {
      workspace_id: clean(workspaceId, 128), change, confirm: true,
    }, { localConfirmation: true });
    if (response?.ok !== true) throw new Error("Team settings changed; refresh before applying again");
    return response;
  }

  async function harnessStatus({ workspaceId, runId, nodeId } = {}) {
    const response = await requestHeadless("/api/v1/ao/harness/status", {
      workspace_id: clean(workspaceId, 128),
      run_id: clean(runId, 80),
      node_id: clean(nodeId, 80),
    });
    if (response?.ok !== true) throw new Error("AO harness status unavailable");
    return response.status?.pending_approvals
      ? { ...response, status: { ...response.status, pending_approvals: withAdvice(response.status.pending_approvals) } } : response;
  }

  // What each working card is doing now, for the chat and the cards: when it started, its
  // current step and when anything was last heard. Read-only; it never advances the run.
  async function activity({ workspaceId, runId } = {}) {
    const id = clean(workspaceId, 128);
    const run = clean(runId, 80);
    const saved = await runs({ workspaceId: id, runId: run });
    const mission = saved.runs.find((entry) => entry.id === run && entry.workspace_id === id);
    if (!mission) throw new Error("AO run not found");
    const nodes = {};
    await Promise.all(mission.nodes.filter((node) => node.state === "reserved" || node.state === "running").map(async (node) => {
      const base = { state: node.state, started_at_ms: node.receipt?.started_at_ms ?? null };
      try {
        if (externalAgent(node)) {
          const session = node.receipt?.thread_id;
          if (!session) {
            nodes[node.id] = { ...base, activity: "launching" };
            return;
          }
          const observed = await harnessService().observe(session);
          nodes[node.id] = { ...base, turn_started: Boolean(observed.turnId),
            activity: observed.needsInput ? "waiting for input" : observed.exited ? "exited" : String(observed.turnState || "working").slice(0, 40) };
          return;
        }
        const status = (await harnessStatus({ workspaceId: id, runId: run, nodeId: node.id })).status || {};
        const thread = (Array.isArray(status.threads) ? status.threads : []).find((entry) => entry.id === node.receipt?.thread_id);
        const turnStarted = Boolean(thread?.turn_id || node.receipt?.turn_id);
        nodes[node.id] = { ...base, turn_started: turnStarted,
          activity: !status.connected ? "not connected" : thread?.activity || (turnStarted ? "working" : "waiting for the turn to start"),
          activity_at_ms: thread?.activity_at_ms || null, last_event_at_ms: thread?.last_event_at_ms || null,
          started_at_ms: base.started_at_ms ?? (thread?.started_at_ms || null) };
      } catch (error) {
        nodes[node.id] = { ...base, activity: "unknown", error: String(error?.message || error).slice(0, 300) };
      }
    }));
    return { ok: true, now_ms: Date.now(), nodes };
  }

  async function connectAoHarness(input = {}, granted = false) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["workspaceId", "runId", "nodeId", "executable"].includes(key))) {
      throw new Error("Renderer credential or unsupported AO connection field was refused");
    }
    if (typeof resolveHarness !== "function") throw new Error("AO-owned harness connection is unavailable");
    const workspaceId = clean(input.workspaceId, 128);
    const runId = clean(input.runId, 80);
    const nodeId = clean(input.nodeId, 80);
    const executable = clean(input.executable, 1024);
    const saved = await runs({ workspaceId, runId });
    const mission = saved.runs.find((entry) => entry.id === runId && entry.workspace_id === workspaceId);
    const node = mission?.nodes?.find((entry) => entry.id === nodeId);
    if (!node || mission.cancelled || !["pending", "reserved"].includes(node.state)) {
      throw new Error("Select a pending AO card in the active run");
    }
    const route = node.route || {};
    // The route decides the connection: shared CPA pool (any model) or WebGPT.
    const worker = route.provider_id === "cliproxyapi-antigravity";
    let webBridge;
    if (externalAgent(node)) throw new Error("AO harness workers run as AO sessions and need no Codex connection");
    if (worker) {
      if (route.harness_id !== "codex-native" || route.account_id !== "shared-cpa-pool" || !route.model) {
        throw new Error("AO card requires the saved shared-CPA route");
      }
      const catalog = await models();
      if (!catalog.models.includes(route.model)) throw new Error("Exact AO worker model is absent from CPA catalog");
    } else if (!["planner", "approver", "worker", "review_split", "sub_reviewer", "reviewer"].includes(node.role)
      || route.harness_id !== "codex-native" || route.provider_id !== "chatgpt-web"
      || !webModel(route.model)) {
      throw new Error("AO WebGPT route does not match the saved card");
    } else {
      const baseUrl = webBridgeConnection?.()?.baseUrl;
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1"
        || !url.port || url.username || url.password || url.search || url.hash) {
        throw new Error("AO WebGPT requires the managed local bridge");
      }
      webBridge = { baseUrl };
    }
    const selected = await resolveHarness({ workspaceId, runId, nodeId, executable,
      model: route.model, providerId: route.provider_id, accountId: route.account_id, permissionProfile: route.permission_profile });
    if (!selected || selected.model !== route.model || selected.permission_profile !== route.permission_profile
      || !AO_PERMISSION_PROFILES.includes(selected.permission_profile)
      || selected.allow_model_usage !== true || selected.allow_command_execution !== false) {
      throw new Error("AO native connection does not match the saved route and permission");
    }
    if (!granted && !await confirm({
      message: "Connect this AO-owned Codex session?",
      detail: `Workspace: ${workspaceId}\nRun: ${runId}\nNode: ${nodeId}\nProvider: ${route.provider_id}\nAccount policy: ${route.account_id}\nModel: ${route.model}\nExecutable: ${selected.executable}\nSHA-256: ${selected.expected_sha256}\nPermission: ${permissionText(route.permission_profile)}; standalone commands: off`.slice(0, 1200),
    })) return { ok: false, cancelled: true };
    if (!worker) {
      const catalog = await webModelCatalog?.({ executable: selected.executable, model: route.model });
      const model = Array.isArray(catalog?.models) && catalog.models.length === 1
        ? catalog.models[0] : null;
      if (model?.slug !== route.model || JSON.stringify(model).length > 256 * 1024) {
        throw new Error("Exact AO WebGPT model is absent from the bundled Codex catalog");
      }
      webBridge.catalog = catalog;
    }
    const response = await requestHeadless("/api/v1/ao/harness/connect", {
      workspace_id: workspaceId, run_id: runId, node_id: nodeId,
      connection: selected, ...(worker ? { private_proxy_api_key: connection().key }
        : { web_bridge_base_url: webBridge.baseUrl, web_model_catalog: webBridge.catalog }),
      confirm: !granted,
    }, granted ? undefined : { localConfirmation: true });
    if (response?.ok === true && response.waiting === true) return response;
    if (response?.ok !== true || response.status?.model !== route.model) {
      throw new Error("AO harness connection outcome is unknown; inspect status before retrying");
    }
    return { ok: true, owned: response.owned === true, route_verified: false, status: response.status };
  }

  async function stopAoHarness({ workspaceId, runId, nodeId } = {}) {
    const id = clean(workspaceId, 128);
    const run = clean(runId, 80);
    const node = clean(nodeId, 80);
    if (!await confirm({
      message: "Stop this AO-owned Codex session?",
      detail: `Workspace: ${id}\nRun: ${run}\nNode: ${node}\nActive work may be interrupted.`,
    })) return { ok: false, cancelled: true };
    const response = await requestHeadless("/api/v1/ao/harness/disconnect", {
      workspace_id: id, run_id: run, node_id: node, confirm: true,
    }, { localConfirmation: true });
    if (response?.ok !== true) throw new Error("AO harness stop outcome unknown");
    return response;
  }

  async function observe({ workspaceId, runId, nodeId } = {}) {
    const found = await savedNode(clean(workspaceId, 128), clean(runId, 80), clean(nodeId, 80));
    if (externalAgent(found.node)) return observeExternal(workspaceId, runId, found.node);
    const response = await requestHeadless("/api/v1/ao/harness/observe", {
      workspace_id: clean(workspaceId, 128), run_id: clean(runId, 80),
      node_id: clean(nodeId, 80),
    });
    if (response?.ok !== true) throw new Error("AO result is unavailable; inspect the run before retrying");
    return response.pending_approvals ? { ...response, pending_approvals: withAdvice(response.pending_approvals) } : response;
  }

  async function approveAoHarness({ workspaceId, runId, nodeId, approvalId, allow } = {}) {
    const id = clean(workspaceId, 128);
    const run = clean(runId, 80);
    const node = clean(nodeId, 80);
    const approval = clean(approvalId, 128);
    if (typeof allow !== "boolean") throw new Error("Choose Allow or Deny for this AO tool request");
    const current = await harnessStatus({ workspaceId: id, runId: run, nodeId: node });
    const pending = current.status?.pending_approvals?.find((entry) => entry.approval_id === approval);
    if (!pending) throw new Error("AO tool request is no longer pending");
    if (!await confirm({
      message: allow ? "Allow this AO tool request once?" : "Deny this AO tool request?",
      detail: pending.kind === "command"
        ? `Run: ${run}\nNode: ${node}\nCommand: ${String(pending.command || "")}\nWorking directory: ${String(pending.cwd || "")}\nReason: ${String(pending.reason || "")}\nRequested permissions: ${JSON.stringify(pending.permissions || {})}\nThis approves this command once, not the session. The native runtime may execute it beyond the default read-only sandbox.`
        : `Run: ${run}\nNode: ${node}\nPath: ${String(pending.path || "").slice(0, 500)}\nReason: ${String(pending.reason || "").slice(0, 500)}`,
    })) return { ok: false, cancelled: true };
    const response = await requestHeadless("/api/v1/ao/harness/approval", {
      workspace_id: id, run_id: run, node_id: node,
      approval_id: approval, allow, confirm: true,
    }, { localConfirmation: true });
    if (response?.ok !== true || response.result?.ok !== true) {
      throw new Error("AO tool approval outcome is unknown; inspect the card before retrying");
    }
    return response;
  }

  async function advance({ workspaceId, runId, executable } = {}) {
    const id = clean(workspaceId, 128);
    const run = clean(runId, 80);
    if (backgroundRuns.get(runKey(id, run))?.status === "running") {
      throw new Error("This AO run is already advancing in the background");
    }
    const saved = await runs({ workspaceId: id, runId: run });
    const mission = saved.runs.find((entry) => entry.id === run && entry.workspace_id === id);
    if (!mission || mission.cancelled) throw new Error("Select an active AO run");
    const active = mission.nodes.find((node) => ["reserved", "running"].includes(node.state));
    if (active) return observe({ workspaceId: id, runId: run, nodeId: active.id });
    const ready = mission.nodes.find((node) => node.state === "pending"
      && node.parents.every((parentId) => mission.nodes.some((parent) => parent.id === parentId && parent.state === "finished")));
    if (!ready) {
      const held = mission.nodes.find((node) => node.state === "held");
      if (held) return observe({ workspaceId: id, runId: run, nodeId: held.id });
      return { ok: true, completed: mission.nodes.every((node) => node.state === "finished"),
        waiting: true, run: mission };
    }
    if (externalAgent(ready)) {
      if (!await confirm({
        message: "Run this AO card?",
        detail: `Workspace: ${id}\nRun: ${run}\nNode: ${ready.id}\nHarness: ${ready.route.harness_id}\nModel: ${ready.route.model}\nAO starts a worker session in its own worktree.`.slice(0, 1200),
      })) return { ok: false, cancelled: true };
      return dispatchExternal(id, run, ready, mission.revision, false);
    }
    const selectedExecutable = clean(executable, 1024);
    const status = await harnessStatus({ workspaceId: id, runId: run, nodeId: ready.id });
    if (status.status?.connected && status.status.model !== ready.route.model) {
      throw new Error("AO connected harness model does not match the saved card");
    }
    if (!status.status?.connected) {
      const connected = await connectAoHarness({ workspaceId: id, runId: run,
        nodeId: ready.id, executable: selectedExecutable });
      if (connected.cancelled) return connected;
    }
    if (!await confirm({
      message: "Run this AO card?",
      detail: `Workspace: ${id}\nRun: ${run}\nNode: ${ready.id}\nRole: ${ready.role}\nModel: ${ready.route.model}\nPermission: ${permissionText(ready.route.permission_profile)}; other tool requests ask you`.slice(0, 1200),
    })) return { ok: false, cancelled: true };
    const response = await requestHeadless("/api/v1/ao/harness/execute", {
      workspace_id: id, run_id: run, node_id: ready.id,
      expected_revision: mission.revision, confirm: true,
    }, { localConfirmation: true });
    if (response?.ok !== true) throw new Error("AO dispatch outcome is unknown; inspect the run before retrying");
    return response;
  }

  async function runStatus({ workspaceId, runId } = {}) {
    const id = clean(workspaceId, 128);
    const run = clean(runId, 80);
    const current = backgroundRuns.get(runKey(id, run));
    if (current) return { ok: true, status: current.status, ...(current.detail ? { detail: current.detail } : {}) };
    const saved = await runs({ workspaceId: id, runId: run });
    const mission = saved.runs.find((entry) => entry.id === run && entry.workspace_id === id);
    if (!mission) throw new Error("AO run unavailable");
    const status = mission.paused && !mission.cancelled ? "paused" : mission.cancelled || mission.nodes.some((node) => ["held", "cancelled", "archived", "reserved", "running"].includes(node.state))
      ? "held" : mission.nodes.every((node) => node.state === "finished") ? "finished" : "idle";
    return { ok: true, status };
  }

  async function controlRun({ workspaceId, runId, action, executable } = {}) {
    if (!["pause", "resume", "stop", "retry"].includes(action)) throw new Error("Choose a mission control");
    const id = clean(workspaceId, 128), run = clean(runId, 80);
    const result = await requestHeadless("/api/v1/ao/control", { workspace_id: id, run_id: run, action, confirm: true }, { localConfirmation: true });
    if (result?.ok !== true || result.run?.workspace_id !== id) throw new Error("Mission control needs a fresh status check");
    if (action === "stop") {
      for (const node of result.run.nodes ?? []) {
        if (externalAgent(node) && node.state === "running" && node.receipt?.thread_id) {
          await harnessService().interrupt(node.receipt.thread_id).catch(() => undefined);
        }
      }
    }
    const current = backgroundRuns.get(runKey(id, run));
    if (action === "resume") {
      if (current?.driving) { current.status = "running"; current.detail = undefined; }
      else return startRun({ workspaceId: id, runId: run, executable });
    } else if (current && action !== "retry") {
      current.status = action === "pause" ? "paused" : "held";
      current.stopped = action === "stop";
      current.detail = action === "pause" ? "Paused; already-sent turns may finish" : "Stopped by you";
      reportRun(id, run, current, null);
    }
    return result;
  }

  // --- recovery helper ------------------------------------------------------------------
  // When a card is held (its turn failed or could not be confirmed), a helper model reads the
  // failure and decides: retry the card, wait for the user, or stop. It runs on the CPA pool so it
  // does not depend on the WebGPT path that may have just failed. Retries are bounded by the card's
  // two-attempt history, so a card that keeps failing ends with the helper's reason, not a loop.
  const HELPER_ATTEMPT_LIMIT = 2;
  const TRANSIENT_FAILURE = /not confirm|timed out|timeout|disconnected|network|ECONNRESET|socket|502|503|504|stream/i;

  // Requests the command approver may never allow, whatever the model says.
  const HARD_DENY = [
    /\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME|[a-z]:[\\/])/i, /\bmkfs\b|\bformat\s+[a-z]:/i, /\bdd\s+if=/i,
    /\bgit\s+push\b/i, /\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/i, /\b(iwr|irm|invoke-webrequest)\b[^|\n]*\|\s*iex\b/i,
    /(^|[\\/\s])\.env(\.|\b)|id_rsa|[\\/]\.ssh[\\/]|credentials|secrets?\.(json|ya?ml|toml)/i,
    /\bRemove-Item\b[^\n]*-Recurse[^\n]*([a-z]:\\|~|\$HOME)/i, /\bdel\s+\/[sq]\b|\brd\s+\/s\b/i,
    /\bshutdown\b|\breg\s+delete\b|\bbcdedit\b|\bdiskpart\b/i,
  ];
  const approverAdvice = new Map(); // approval_id -> { action, reason }
  const withAdvice = (approvals) => Array.isArray(approvals)
    ? approvals.map((item) => approverAdvice.has(item?.approval_id) ? { ...item, recommendation: approverAdvice.get(item.approval_id) } : item)
    : approvals;
  const describeRequest = (approval) => [approval.kind, approval.command, approval.path, approval.cwd && `in ${approval.cwd}`, approval.reason]
    .filter(Boolean).join(" · ").slice(0, 1500);

  async function askApprover({ approver, mission, approval }) {
    const { baseUrl, key } = connection();
    const route = approver.route ?? {};
    const own = route.provider_id === "cliproxyapi-antigravity" ? route.model
      : typeof route.model === "string" && route.model.startsWith(CPA_MODEL_PREFIX) ? route.model.slice(CPA_MODEL_PREFIX.length) : null;
    const catalog = (await models()).models;
    const model = own && catalog.includes(own) ? own : catalog[0];
    if (!model) throw new Error("CPA has no model for the command approver");
    const prompt = [
      "You are the command approver for an orchestrated coding mission. A worker asks to run a tool request.",
      `Workspace: ${mission.workspace_id}. Approver rules: ${String(approver.settings?.instructions || "none").slice(0, 1500)}`,
      `Request: ${describeRequest(approval)}`,
      approval.permissions ? `Permissions: ${JSON.stringify(approval.permissions).slice(0, 800)}` : "",
      'Answer with JSON only: {"action":"allow"|"deny"|"ask","reason":"<one sentence for the user>"}.',
      "allow: clearly safe and needed for the task. deny: destructive, outside the workspace, secret-touching or unrelated. ask: anything unclear.",
    ].filter(Boolean).join("\n");
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Command approver returned HTTP ${response.status}`);
    const text = String((await response.json())?.choices?.[0]?.message?.content ?? "");
    const decision = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (!["allow", "deny", "ask"].includes(decision?.action)) throw new Error("Command approver gave no decision");
    return { action: decision.action, reason: String(decision.reason || "").slice(0, 300) };
  }

  /**
   * Screens pending tool requests with the mission's command approver (once it has approved the plan).
   * With auto-decide on it answers allow/deny itself; otherwise it only recommends, and "ask" always
   * goes to the person. The hard deny list wins over the model.
   */
  async function screenApprovals(workspaceId, runId, mission, active, observed) {
    const approver = mission.nodes.find((node) => node.role === "approver" && node.state === "finished" && node.receipt?.verdict === "APPROVED");
    if (!approver) return null;
    let note = null;
    for (const [index, result] of observed.entries()) {
      for (const approval of result?.pending_approvals ?? []) {
        if (!approval?.approval_id || approverAdvice.has(approval.approval_id)) continue;
        const request = describeRequest(approval);
        const advice = HARD_DENY.some((pattern) => pattern.test(request))
          ? { action: "deny", reason: "Blocked by the command approver's safety rules" }
          : await askApprover({ approver, mission, approval });
        approverAdvice.set(approval.approval_id, advice);
        if (approverAdvice.size > 500) approverAdvice.delete(approverAdvice.keys().next().value);
        if (approver.settings?.auto_decide === true && advice.action !== "ask") {
          await requestHeadless("/api/v1/ao/harness/approval", {
            workspace_id: workspaceId, run_id: runId, node_id: active[index].id, approval_id: approval.approval_id,
            allow: advice.action === "allow", confirm: false, approver_reason: advice.reason || advice.action, approver_request: request,
          });
          note = `Command approver ${advice.action === "allow" ? "allowed" : "denied"}: ${advice.reason}`;
        } else {
          note = `Command approver suggests ${advice.action === "ask" ? "checking it yourself" : advice.action === "allow" ? "allowing" : "denying"}: ${advice.reason}`;
        }
      }
    }
    return note;
  }

  async function askRecoveryHelper({ mission, node, task }) {
    const { baseUrl, key } = connection();
    const catalog = (await models()).models;
    const preferred = mission.nodes.find((entry) => entry.route?.provider_id === "cliproxyapi-antigravity")?.route.model;
    const model = catalog.includes(preferred) ? preferred : catalog[0];
    if (!model) throw new Error("CPA has no model for the recovery helper");
    const role = node.settings?.name || node.role;
    const prompt = [
      "A step in an orchestrated coding mission failed. Decide the next step.",
      `Step: ${role} (${node.role}), model ${node.route?.model}`,
      `Attempts so far: ${(node.history?.length ?? 0) + 1} of ${HELPER_ATTEMPT_LIMIT + 1}`,
      `Failure: ${String(node.receipt?.error || "no error text").slice(0, 1500)}`,
      `Task: ${String(task?.title || "").slice(0, 200)}`,
      String(task?.description || "").slice(0, 1500),
      'Answer with JSON only: {"action":"retry"|"wait"|"stop","reason":"<one sentence for the user>"}.',
      "retry: the failure looks transient or fixable by running the step again.",
      "wait: a person must act first (approval, sign-in, missing input). stop: retrying cannot help.",
    ].join("\n");
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Recovery helper returned HTTP ${response.status}`);
    const text = String((await response.json())?.choices?.[0]?.message?.content ?? "");
    const decision = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (!["retry", "wait", "stop"].includes(decision?.action)) throw new Error("Recovery helper gave no decision");
    return { action: decision.action, reason: String(decision.reason || "").slice(0, 300), model };
  }

  // Returns a status detail for the user; retrying re-queues the held cards.
  async function recoverHeld(workspaceId, mission) {
    const held = mission.nodes.filter((node) => node.state === "held");
    if (!held.length || mission.cancelled) return null;
    const exhausted = held.find((node) => (node.history?.length ?? 0) >= HELPER_ATTEMPT_LIMIT);
    if (exhausted) return `${exhausted.settings?.name || exhausted.role} failed ${HELPER_ATTEMPT_LIMIT + 1} times; decide the next step yourself or send a follow-up`;
    const node = held[0];
    let decision;
    try {
      const task = (await board({ workspaceId, taskId: mission.project_id })).task;
      decision = await askRecoveryHelper({ mission, node, task });
    } catch {
      // No helper available: retry only what looks transient.
      decision = TRANSIENT_FAILURE.test(String(node.receipt?.error || ""))
        ? { action: "retry", reason: "The failure looks transient" }
        : { action: "wait", reason: "The recovery helper is unavailable; inspect the failed step" };
    }
    if (decision.action !== "retry") return `Helper: ${decision.reason || decision.action}`;
    await controlRun({ workspaceId, runId: mission.id, action: "retry" });
    return `Helper retried ${node.settings?.name || node.role}: ${decision.reason}`;
  }

  async function driveRun(workspaceId, runId, executable, state) {
    const pause = () => new Promise(resolve => setTimeout(resolve, 500));
    state.driving = true;
    try {
      for (;;) {
        if (state.stopped) { reportRun(workspaceId, runId, state, null); return; }
        let saved = await runs({ workspaceId, runId });
        let mission = saved.runs.find(entry => entry.id === runId && entry.workspace_id === workspaceId);
        if (!mission) throw new Error("Saved mission is unavailable");
        if (!Number.isInteger(saved.worker_capacity?.[runId])) throw new Error("The installed AO service does not report worker capacity; update the matching runtime");
        const active = mission.nodes.filter(node => node.state === "running");
        let attention = null;
        if (active.length) {
          const observed = await Promise.all(active.map(node => observe({ workspaceId, runId, nodeId: node.id })));
          attention = observed.some(result => result.pending_approvals?.length) ? "pending_approval"
            : observed.some(result => result.needs_input) ? "needs_input" : null;
          state.detail = attention === "pending_approval" ? "Waiting for your tool approval"
            : attention === "needs_input" ? "An AO worker needs input on the Board" : undefined;
          if (attention === "pending_approval") {
            const note = await screenApprovals(workspaceId, runId, mission, active, observed)
              .catch((error) => `Command approver unavailable: ${String(error?.message || error).slice(0, 200)}`);
            if (note) state.detail = note;
          }
          saved = await runs({ workspaceId, runId });
          mission = saved.runs.find(entry => entry.id === runId && entry.workspace_id === workspaceId);
          if (!mission) throw new Error("Saved mission is unavailable");
        }
        reportRun(workspaceId, runId, state, mission, attention);
        const running = mission.nodes.some(node => node.state === "running");
        if (mission.cancelled || mission.nodes.some(node => ["held", "cancelled", "archived", "reserved"].includes(node.state))) {
          if (running) { state.detail = "Finishing already-sent turns; no more work will start"; await pause(); continue; }
          const helped = state.stopped ? null : await recoverHeld(workspaceId, mission).catch((error) => `Helper failed: ${error.message}`);
          if (helped?.startsWith("Helper retried")) {
            state.status = "held"; state.detail = helped;
            // The retry dropped the grant; start again once this loop has ended.
            setTimeout(() => { void startRun({ workspaceId, runId, executable }).catch(() => {}); }, 0);
            return;
          }
          state.status = "held";
          state.detail = helped || "Run stopped; inspect the saved cards";
          reportRun(workspaceId, runId, state, mission, state.stopped ? null : "stopped");
          return;
        }
        if (mission.nodes.every(node => node.state === "finished")) {
          state.status = "finished"; state.detail = undefined; reportRun(workspaceId, runId, state, mission); return;
        }
        if (mission.paused) { state.status = "paused"; state.detail = "Paused; queued work will not start"; await pause(); continue; }
        const capacity = Number(saved.worker_capacity?.[runId] ?? 0);
        const ready = mission.nodes.find(node => node.state === "pending"
          && (node.role !== "worker" || capacity > 0)
          && node.parents.every(parentId => mission.nodes.some(parent => parent.id === parentId && parent.state === "finished")));
        if (!ready) {
          if (running || capacity === 0) {
            if (mission.grant?.expires_at_ms && Date.now() >= mission.grant.expires_at_ms) throw new Error("Run grant expired while waiting for a worker slot");
            state.detail ||= "Waiting for a worker slot";
            await pause(); continue;
          }
          throw new Error("No card is ready; inspect dependencies");
        }
        if (externalAgent(ready)) {
          const sent = await dispatchExternal(workspaceId, runId, ready, mission.revision, true);
          if (sent.waiting) { state.detail = "Waiting for a worker slot or current graph revision"; await pause(); }
          continue;
        }
        const status = await harnessStatus({ workspaceId, runId, nodeId: ready.id });
        if (status.status?.connected && status.status.model !== ready.route.model) throw new Error("AO connected harness route changed");
        if (!status.status?.connected) {
          const connected = await connectAoHarness({ workspaceId, runId, nodeId: ready.id, executable }, true);
          if (connected.waiting) { state.detail = "Waiting for a harness slot"; await pause(); continue; }
        }
        const sent = await requestHeadless("/api/v1/ao/harness/execute", {
          workspace_id: workspaceId, run_id: runId, node_id: ready.id,
          expected_revision: mission.revision, confirm: false,
        });
        if (sent?.ok !== true) throw new Error("AO turn outcome unknown");
        if (sent.waiting) { state.detail = "Waiting for a worker slot or current graph revision"; await pause(); }
      }
    } catch (error) {
      state.status = "held";
      state.detail = String(error?.message || "AO stage outcome is uncertain; inspect the saved run before retrying")
        .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 500);
      reportRun(workspaceId, runId, state, null, state.stopped ? null : "error");
    } finally { state.driving = false; }
  }
  async function startRun(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["workspaceId", "runId", "executable"].includes(key))) {
      throw new Error("Renderer credential or unsupported AO start field was refused");
    }
    const { workspaceId, runId, executable } = input;
    const id = clean(workspaceId, 128);
    const run = clean(runId, 80);
    const selectedExecutable = codexExecutable(executable);
    const key = runKey(id, run);
    const existing = backgroundRuns.get(key);
    if (existing?.starting || existing?.driving || existing?.status === "running") {
      return { ok: true, started: false, status: existing.status };
    }
    const state = { status: "idle", starting: true, detail: "Awaiting local approval" };
    backgroundRuns.set(key, state);
    try {
      const saved = await runs({ workspaceId: id, runId: run });
      let mission = saved.runs.find((entry) => entry.id === run && entry.workspace_id === id);
      if (mission?.paused) throw new Error("Resume this paused mission from its local controls");
      // Starting a run whose card is held (and nothing still running) is an explicit retry.
      if (mission && !mission.cancelled && mission.nodes.some((node) => node.state === "held")
        && !mission.nodes.some((node) => ["running", "reserved"].includes(node.state))) {
        await controlRun({ workspaceId: id, runId: run, action: "retry" });
        const again = await runs({ workspaceId: id, runId: run });
        mission = again.runs.find((entry) => entry.id === run && entry.workspace_id === id);
      }
      if (!mission || mission.cancelled || !mission.nodes?.length
        || mission.nodes.some((node) => ["held", "cancelled", "archived", "reserved"].includes(node.state))) {
        throw new Error("AO run has an active or unresolved card; inspect it before starting");
      }
      if (mission.nodes.every((node) => node.state === "finished")) throw new Error("AO run is already finished");
      const resuming = mission.nodes.some((node) => node.state === "running");
      const selected = await resolveHarness({ workspaceId: id, runId: run, nodeId: mission.nodes[0].id,
        executable: selectedExecutable, model: mission.nodes[0].route.model });
      if (!/^[a-f0-9]{64}$/.test(selected?.expected_sha256 || "") || !path.isAbsolute(selected.executable)) {
        throw new Error("AO executable identity changed; select the current executable");
      }
      if (resuming && mission.grant?.executable_sha256 !== selected.expected_sha256) {
        throw new Error("AO running turn has no matching background grant");
      }
      if (!resuming) {
        const grant = await requestHeadless("/api/v1/ao/grant", {
          workspace_id: id, run_id: run, expected_revision: mission.revision,
          executable_sha256: selected.expected_sha256, confirm: true,
        }, { localConfirmation: true });
        if (grant?.ok !== true || grant.run?.id !== run || grant.run?.workspace_id !== id
          || grant.grant?.executable_sha256 !== selected.expected_sha256) {
          throw new Error("AO run grant outcome is unknown; inspect before retrying");
        }
      }
      state.status = "running";
      state.starting = false;
      state.detail = undefined;
      void driveRun(id, run, selectedExecutable, state);
      return { ok: true, started: true, status: "running" };
    } catch (error) {
      backgroundRuns.delete(key);
      throw error;
    }
  }

  async function create({ workspaceId, title, description = "", expectedRevision } = {}) {
    const name = clean(title, 240);
    const detail = clean(description, 8192, false);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Refresh the board revision");
    await write(workspaceId, {
      expected_revision: expectedRevision,
      change: { operation: "create", title: name, description: detail },
    });
    return board({ workspaceId });
  }

  async function append({ workspaceId, taskId, expectedRevision, clauses } = {}) {
    const id = clean(taskId, 128);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Refresh the board revision");
    const additions = clausesFrom({ clauses });
    if (!await confirm({
      message: "Add clauses to this Coding Tools plan?",
      detail: `${additions.length} clauses will be added to task ${id}. Existing clauses and evidence remain intact.`,
    })) return { ok: false, cancelled: true };
    await write(workspaceId, {
      expected_revision: expectedRevision,
      change: { operation: "append_clauses", id, clauses: additions },
    });
    return board({ workspaceId, taskId: id });
  }

  async function moveTask({ workspaceId, taskId, state, expectedRevision } = {}) {
    const id = clean(taskId, 128);
    if (!["backlog", "in_progress", "blocked", "done"].includes(state)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Refresh the board and choose a supported task state");
    }
    if (!await confirm({
      message: "Update this plan task?",
      detail: `Task ${id} will move to ${state}.`,
    })) return { ok: false, cancelled: true };
    await write(workspaceId, {
      expected_revision: expectedRevision,
      change: { operation: "move", id, state },
    });
    return board({ workspaceId });
  }

  async function moveClause({ workspaceId, taskId, clauseId, state, expectedRevision } = {}) {
    const id = clean(taskId, 128);
    const clause = clean(clauseId, 128);
    if (!["backlog", "in_progress", "blocked", "done"].includes(state)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Refresh the board and choose a supported clause state");
    }
    if (!await confirm({
      message: "Update a plan clause?",
      detail: `Clause ${clause} in task ${id} will move to ${state}.`,
    })) return { ok: false, cancelled: true };
    await write(workspaceId, {
      expected_revision: expectedRevision,
      change: { operation: "move_clause", id, clause_id: clause, state },
    });
    return board({ workspaceId, taskId: id });
  }

  async function next({ workspaceId } = {}) {
    const current = await board({ workspaceId });
    const actionable = (clause) => clause.state === "backlog" || clause.state === "in_progress";
    const task = (current.tasks ?? []).find((entry) => entry.state !== "blocked"
      && entry.state !== "done" && entry.clauses?.some(actionable));
    const clause = task?.clauses?.find(actionable);
    const detail = task ? await board({ workspaceId, taskId: task.id }) : null;
    const fullClause = detail?.task?.clauses?.find((entry) => entry.id === clause?.id);
    return { ok: true, taskId: task?.id ?? null, clause: fullClause ?? null,
      prompt: fullClause ? `Work on ${task.title}: ${fullClause.title}. ${fullClause.detail} Inspect the exact workspace and report evidence before marking this clause done.`.trim() : null };
  }

  // --- chat-first missions -------------------------------------------------------------
  // One chat is one board task. The first message creates the task (titled "New task" unless the
  // user names it) and starts a team run; a later message is appended to the task description and
  // starts a fresh run on the same task. Appending mid-run would change the run's graph fingerprint
  // and void its grant, so follow-ups wait until the chat's current run has settled.

  function runSettled(run) {
    return run.cancelled || (run.nodes ?? []).every((node) => ["finished", "cancelled", "archived"].includes(node.state));
  }

  // A chat starts as "New task"; once its run has started, name it after what was asked.
  function fallbackChatTitle(message) {
    const words = String(message).replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
    return words.length > 60 ? `${words.slice(0, 57).trimEnd()}...` : words || CHAT_TASK_TITLE;
  }

  async function nameChat(workspaceId, taskId, message) {
    let name = "";
    try {
      const { baseUrl, key } = connection();
      const model = (await models()).models[0];
      const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 30, messages: [{ role: "user", content:
          `Name this coding task in at most 6 words. Reply with the name only, no quotes.\n\n${String(message).slice(0, 2000)}` }] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) name = String((await response.json())?.choices?.[0]?.message?.content ?? "");
    } catch { /* CPA unavailable: fall back to the message itself. */ }
    name = name.replace(/["'`*#]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || fallbackChatTitle(message);
    const detail = await board({ workspaceId, taskId });
    // Only a chat still using the default name is renamed; a name the user chose wins.
    if (!detail.task || detail.task.title !== CHAT_TASK_TITLE || name === CHAT_TASK_TITLE) return;
    await write(workspaceId, { expected_revision: detail.revision,
      change: { operation: "edit", id: taskId, title: clean(name, 240), description: detail.task.description } });
  }

  // A previous run that is really working must finish or be stopped first. One that is stuck
  // (a failed start left its cards pending, a held card, a pause) is stopped and kept in history,
  // so an old task can always be continued or restarted.
  async function retireOpenRuns(id, task, runsOfWorkspace) {
    const open = runsOfWorkspace.filter((run) => run.project_id === task && !runSettled(run));
    for (const run of open) {
      const live = backgroundRuns.get(runKey(id, run.id));
      const working = Boolean(live && (live.starting || live.driving || live.status === "running"))
        || (run.nodes ?? []).some((node) => ["running", "reserved"].includes(node.state));
      if (working) throw new Error("This mission is still running; wait for it to finish or stop it first");
    }
    for (const run of open) {
      await updateRun({ workspaceId: id, change: { operation: "cancel", run_id: run.id, expected_revision: run.revision } });
    }
  }

  async function createTeamRun(id, task, team) {
    const current = await board({ workspaceId: id });
    const runId = randomUUID();
    await updateRun({ workspaceId: id, change: {
      operation: "create_from_team", run_id: runId, task_id: task,
      expected_board_revision: current.revision, team_revision: team.revision,
      worker_limit: Number.isSafeInteger(team.worker_limit) && team.worker_limit > 0 ? team.worker_limit : 3,
    } });
    return runId;
  }

  // Restart = a fresh run of the same task with the current team; the old run stays in history.
  async function restartRun({ workspaceId, runId, executable } = {}) {
    const id = clean(workspaceId, 128);
    const previous = clean(runId, 80);
    const selectedExecutable = codexExecutable(executable);
    const saved = await runs({ workspaceId: id });
    const mission = saved.runs.find((run) => run.id === previous && run.workspace_id === id);
    if (!mission) throw new Error("AO run unavailable");
    if (!mission.project_id) throw new Error("This mission has no task to restart");
    const team = saved.team;
    if (!team?.id || !Number.isSafeInteger(team.revision)) throw new Error("Save a team for this workspace first");
    await retireOpenRuns(id, mission.project_id, saved.runs);
    const next = await createTeamRun(id, mission.project_id, team);
    try {
      const started = await startRun({ workspaceId: id, runId: next, executable: selectedExecutable });
      return { ok: true, runId: next, status: started.status };
    } catch (error) {
      return { ok: true, runId: next, status: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async function chatSend({ workspaceId, taskId, title, message, executable } = {}) {
    const id = clean(workspaceId, 128);
    const text = clean(message, 8192, false);
    if (!text.trim()) throw new Error("Type a message to start the chat");
    const selectedExecutable = codexExecutable(executable);
    const saved = await runs({ workspaceId: id });
    const team = saved.team;
    if (!team?.id || !Number.isSafeInteger(team.revision)) throw new Error("Save a team for this workspace first");

    let task;
    if (taskId) {
      task = clean(taskId, 128);
      try {
        await retireOpenRuns(id, task, saved.runs);
      } catch (error) {
        if (/still running/.test(error?.message)) throw new Error("This chat is still running; wait for it to finish or stop it first");
        throw error;
      }
      const detail = await board({ workspaceId: id, taskId: task });
      if (!detail.task) throw new Error("This chat's task no longer exists");
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      const description = `${detail.task.description || ""}\n\nFollow-up (${stamp} UTC):\n${text}`.trim();
      if (description.length > 8192) throw new Error("This chat is full; start a new chat to continue");
      await write(id, { expected_revision: detail.revision,
        change: { operation: "edit", id: task, title: detail.task.title, description } });
    } else {
      const before = await board({ workspaceId: id });
      const known = new Set(before.tasks.map((entry) => entry.id));
      await write(id, { expected_revision: before.revision, change: {
        operation: "create", title: clean(title && String(title).trim() ? title : CHAT_TASK_TITLE, 240), description: text,
      } });
      const added = (await board({ workspaceId: id })).tasks.filter((entry) => !known.has(entry.id));
      if (added.length !== 1) throw new Error("The new chat's task needs review; refresh the board");
      task = added[0].id;
    }

    const runId = await createTeamRun(id, task, team);
    // The chat exists from here on: report a failed start inside it instead of losing the chat.
    try {
      const started = await startRun({ workspaceId: id, runId, executable: selectedExecutable });
      if (!taskId) void nameChat(id, task, text).catch(() => undefined);
      return { ok: true, taskId: task, runId, status: started.status };
    } catch (error) {
      return { ok: true, taskId: task, runId, status: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async function call(operation, args = {}) {
    switch (operation) {
      case "chat_send": return chatSend(args);
      case "codex_executable": return { ok: true, executable: findCodexExecutable() };
      case "inspect": return { ok: true, status: "graph_ready", source: "coding-tools-plan", plannerRoute: "webgpt-on-codex-required", execution: "not_connected" };
      case "board": return board(args);
      case "models": return models(args);
      case "harnesses": return harnesses();
      case "runs": return runs(args);
      case "update_run": return updateRun(args);
      case "team_update": return teamUpdate(args);
      case "harness_status": return harnessStatus(args);
      case "activity": return activity(args);
      case "connect_harness": return connectAoHarness(args);
      case "stop_harness": return stopAoHarness(args);
      case "observe": return observe(args);
      case "advance": return advance(args);
      case "start_run": return startRun(args);
      case "restart_run": return restartRun(args);
      case "control_run": return controlRun(args);
      case "run_status": return runStatus(args);
      case "approve_harness": return approveAoHarness(args);
      case "create": return create(args);
      case "append": return append(args);
      case "move_task": return moveTask(args);
      case "move_clause": return moveClause(args);
      case "next": return next(args);
      default: throw new Error("Unknown Agent Orchestrator operation");
    }
  }

  return Object.freeze({ call });
}

module.exports = { createAgentOrchestratorWorkflow, clausesFrom, resolveAoNativeConnection, findInstalledCodexExecutable, codexCliExecutable, aoWebCatalogForModel };
