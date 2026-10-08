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

// Keep the actual native profile ID. The consented runtime's profile metadata enforces
// availability/managed policy; the standalone command grant is independent and stays off.
async function resolveAoNativeConnection({ workspaceId, runId, nodeId, executable, model, permissionProfile = ":read-only",
  approvalPolicy, approvalsReviewer, userData }) {
  clean(permissionProfile, 128);
  if (permissionProfile === ":ao-default" || /[\x00-\x1F\x7F]/.test(permissionProfile)) throw new Error("Choose an actual native permission profile");
  if (approvalPolicy !== undefined && !["on-request", "never"].includes(approvalPolicy)) throw new Error("Unsupported native approval policy");
  if (approvalsReviewer !== undefined && !["user", "auto_review"].includes(approvalsReviewer)
    || approvalPolicy === "never" && approvalsReviewer === "auto_review") throw new Error("Unsupported native approvals reviewer selection");
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
    ...(approvalPolicy !== undefined ? { approval_policy: approvalPolicy } : {}),
    ...(approvalsReviewer !== undefined ? { approvals_reviewer: approvalsReviewer } : {}),
    request_limit: 3, lifetime_seconds: 900,
  };
}

function permissionText(profile) {
  if (profile === ":workspace") return "workspace (create, edit and delete inside the workspace)";
  if (profile === ":read-only") return "read-only";
  if (profile === ":danger-full-access") return "full access (no native sandbox)";
  return "native profile: " + String(profile ?? "unknown");
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
// (Claude Code: ANTHROPIC_*, Codex: a CPA-only CODEX_HOME, opencode: OPENAI_*). agy is not one:
// its gateway mode sends its tools only for Gemini ids it knows itself, none of which CPA serves
// under that name, so a CPA model on agy can chat but cannot read or write files.
const GATEWAY_AGENTS = new Set(["claude-code", "codex", "opencode"]);
// Gateway agents whose own model catalogs are not CPA or WebGPT models; they list only CPA models.
const CPA_ONLY_AGENTS = new Set(["claude-code", "opencode"]);
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

function delayToMilliseconds(value, unit) {
  const multiplier = {seconds:1000,minutes:60000,hours:3600000}[unit];
  const ms = value * multiplier;
  if (!Number.isSafeInteger(value) || value <= 0 || !multiplier || !Number.isSafeInteger(ms)) {
    throw new Error("Choose a positive whole number of seconds, minutes or hours");
  }
  return ms;
}
function createAgentOrchestratorWorkflow({ requestHeadless, cpaConnection, webBridgeConnection, webBridgeReadiness, webModelCatalog, confirm, resolveHarness, aoHarness, fetchImpl = fetch, findCodexExecutable = findInstalledCodexExecutable, exists = (file) => fs.existsSync(file), onRunState = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
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
      // Archived and deleted tasks stay listed; the chat list filters them by their lifecycle.
      limit: 100, include_archived: true,
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

  const tuningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
  const reportedEfforts = values => [...new Set((Array.isArray(values) ? values : [])
    .map(value => typeof value === "string" ? value : value?.effort)
    .filter(value => typeof value === "string" && tuningEfforts.has(value)))];

  function modelCapabilities(agent, model, info, viaCpa = false) {
    // Operating modes and unimplemented generic Chat effort are not reasoning setters.
    const nativeEffort = agent === "codex" || agent === "claude-code";
    const efforts = viaCpa || nativeEffort ? reportedEfforts(info?.efforts) : [];
    const capabilities = { efforts };
    if (!efforts.length) capabilities.effortReason = viaCpa
      ? "CPA did not advertise reasoning levels for this model."
      : "This harness/model has no verified reasoning-effort transport.";
    const limit = info?.contextLimit;
    if (Number.isSafeInteger(limit) && limit > 0) capabilities.contextLimit = limit;
    const base = model.split("(")[0].trim().toLowerCase();
    const claudeFixedWindow = agent === "claude-code"
      && (!base || ["default", "sonnet", "opus", "haiku", "fable"].includes(base) || model.toLowerCase().includes("claude") || model.toLowerCase().includes("[1m]"));
    const slash = model.indexOf("/");
    const unqualifiedOpenCode = agent === "opencode" && !viaCpa
      && (slash < 0 || !model.slice(0, slash).trim() || !model.slice(slash + 1).trim());
    if (GATEWAY_AGENTS.has(agent) && !claudeFixedWindow && !unqualifiedOpenCode && (!limit || limit >= 4096)) {
      capabilities.contextWindow = { min: 4096, max: Math.min(2000000, limit || 2000000), kind: "context" };
      capabilities.contextReason = "Client context declaration, not a larger provider limit. Client version/model applicability is checked again at launch.";
    } else capabilities.contextReason = claudeFixedWindow
      ? "Claude Code cannot override this recognized model's window while preserving compaction."
      : unqualifiedOpenCode ? "OpenCode context requires an explicit provider/model."
      : "This harness/model has no verified context-window setter.";
    return capabilities;
  }

  async function models({ harness, workspaceId } = {}) {
    if (typeof harness === "string" && harness.startsWith("ao:")) {
      const agent = harness.slice(3);
      // Claude Code's and opencode's own catalogs (fable/haiku/opus/opus[1m]/sonnet, provider
      // aliases) are neither CPA nor WebGPT models, so those agents offer only the CPA pool. Codex
      // keeps its own ChatGPT-account models. For a CPA-only agent a CPA failure is reported,
      // never silently replaced by its aliases; the renderer drops a rejected catalog and retries.
      const cpaOnly = CPA_ONLY_AGENTS.has(agent);
      const items = cpaOnly ? [] : (await harnessService().models(agent, workspaceId))
        .filter(item => item.id !== "default" && !item.id.startsWith("chatgpt-web/"));
      const capabilities = Object.fromEntries(items.map(item => [item.id, modelCapabilities(agent, item.id, item)]));
      let cpa = [];
      if (GATEWAY_AGENTS.has(agent)) {
        let catalog = null;
        try { catalog = await models(); }
        catch (error) {
          if (cpaOnly) throw new Error(`CPA model list is unavailable: ${String(error?.message || error).slice(0, 200)}`);
        }
        if (catalog) cpa = catalog.models.filter(id => !id.startsWith("chatgpt-web/")).map(id => {
          const routed = `${CPA_MODEL_PREFIX}${id}`;
          capabilities[routed] = modelCapabilities(agent, id, catalog.capabilities[id], true);
          return routed;
        });
      }
      return { ok: true, harness, models: [...new Set([...items.map(item => item.id), ...cpa])], capabilities };
    }
    if (harness === "codex-native") {
      // Native Codex runs WebGPT through the bridge and every CPA model through the shared pool.
      // Without CPA it still offers WebGPT.
      let pool = { models: [], capabilities: {} };
      try { pool = await models(); } catch {}
      const cpa = pool.models.filter(id => !id.startsWith("chatgpt-web/"));
      return { ok: true, harness, models: [...WEB_TIERS, ...LUNA_TIERS, ...cpa],
        capabilities: Object.fromEntries(cpa.map(id => [id, pool.capabilities[id]]).filter(([, value]) => value)) };
    }
    const { baseUrl, key } = connection();
    let rows;
    // The classic OpenAI list contains only IDs; the enhanced catalog carries capabilities.
    for (const suffix of ["?client_version=pi", ""]) {
      try {
        const response = await fetchImpl(`${baseUrl}/v1/models${suffix}`, {
          headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`CPA model catalog returned HTTP ${response.status}`);
        const payload = await response.json();
        rows = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : null;
        if (rows) break;
        throw new Error("CPA model catalog has an unsupported shape");
      } catch (error) { if (!suffix) throw error; }
    }
    const capabilities = Object.create(null);
    const ids = [];
    for (const entry of rows || []) {
      const id = entry?.slug ?? entry?.id;
      if (typeof id !== "string" || !id || id.length > 128 || entry.visibility === "hide" || ids.includes(id)) continue;
      const efforts = reportedEfforts(entry.supported_reasoning_levels ?? entry.thinking?.levels);
      const limit = entry.context_window ?? entry.context_length;
      capabilities[id] = { efforts, ...(!efforts.length ? { effortReason: "CPA did not advertise reasoning levels for this model." } : {}),
        ...(Number.isSafeInteger(limit) && limit > 0 ? { contextLimit: limit } : {}) };
      ids.push(id);
      if (ids.length === 100) break;
    }
    if (!ids.length) throw new Error("CPA has no available models");
    return { ok: true, models: ids, capabilities };
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
      if (node.route.effort || node.route.context_window != null) {
        const catalog = await models({ harness: node.route.harness_id, workspaceId });
        const baseModel = node.route.model.replace(/\((?:\d+|none|auto|minimal|low|medium|high|xhigh|max)\)$/i, "");
        const capability = catalog.capabilities[node.route.model] ?? catalog.capabilities[baseModel];
        if (node.route.effort && !capability?.efforts?.includes(node.route.effort)) {
          throw new Error("Reasoning effort is not supported by the current model/harness catalog");
        }
        if (node.route.context_window != null) {
          const setting = capability?.contextWindow, tokens = node.route.context_window;
          const maximum = Math.min(setting?.max ?? 2000000, capability?.contextLimit ?? 2000000);
          if (!setting || !Number.isSafeInteger(tokens) || tokens < setting.min || tokens > maximum) {
            throw new Error("Context limit for this model/harness is " + maximum + " tokens or no override is supported");
          }
        }
      }
      const reserved = await requestHeadless("/api/v1/ao/external/reserve", {
        workspace_id: workspaceId, run_id: runId, node_id: node.id,
        expected_revision: expectedRevision, confirm: !background,
      }, background ? undefined : { localConfirmation: true });
      if (reserved?.ok === true && reserved.waiting) return reserved;
      if (reserved?.ok !== true || typeof reserved.request_key !== "string") throw new Error("AO harness reservation outcome is unknown");
      let session = null;
      let failure = null;
      try {
        const profile = node.route.native_permission_profile ?? node.route.permission_profile;
        if ((node.route.approval_policy !== undefined || node.route.native_permission_profile !== undefined) && (!["claude-code", "codex"].includes(agent)
          || !(profile === ":workspace" && node.route.approval_policy === "on-request" && ["user", "auto_review"].includes(node.route.approvals_reviewer ?? "user")
            || profile === ":danger-full-access" && node.route.approval_policy === "never" && (node.route.approvals_reviewer ?? "user") === "user"))) {
          throw new Error("This adapter cannot honor the saved permission tuple; choose a supported mode explicitly.");
        }
        const viaCpa = node.route.model.startsWith(CPA_MODEL_PREFIX) ? node.route.model.slice(CPA_MODEL_PREFIX.length) : null;
        if (viaCpa && !GATEWAY_AGENTS.has(agent)) {
          throw new Error(`${node.settings?.name || "This card"}: ${agent} cannot use CPA models (${node.route.model}); choose one of its own models`);
        }
        // The gateway serves CPA through OpenAI- and Anthropic-compatible endpoints; opencode names
        // models as provider/model, so a CPA model is its OpenAI provider's "openai/<model>".
        let wireModel = viaCpa;
        if (viaCpa && node.route.effort) {
          if (!tuningEfforts.has(node.route.effort)) throw new Error("Choose a supported CPA reasoning level");
          // The suffix is session-local; the saved mission model and account remain unchanged.
          wireModel = viaCpa.replace(/\((?:\d+|none|auto|minimal|low|medium|high|xhigh|max)\)$/i, "") + "(" + node.route.effort + ")";
        }
        const agentModel = wireModel && agent === "opencode" ? `openai/${wireModel}` : wireModel ?? node.route.model;
        session = await harnessService().spawn({ workspaceId, agent, model: agentModel, prompt: reserved.prompt,
          name: node.settings?.name || "AO worker",
          ...(node.route.approval_policy ? { approvalMode: node.route.approval_policy === "never" ? "bypass-permissions"
            : node.route.approvals_reviewer === "auto_review" ? "auto" : "accept-edits" } : {}),
          ...(viaCpa ? { gateway: { provider: "cpa", model: wireModel } } : {}),
          ...(node.route.context_window != null ? { contextWindow: node.route.context_window } : {}),
          // Native effort validation stays skipped for foreign models; CPA reads the suffix.
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

  function missingModelNotice(team) {
    const invalid = Array.isArray(team?.nodes) ? team.nodes.find(node => !node.route?.model || node.route.model === "default") : null;
    return invalid ? `Choose an explicit model for ${String(invalid.settings?.name || invalid.role || "this role").slice(0,96)} in Team settings before sending.` : null;
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

  async function permissionProfiles({ workspaceId, runId, nodeId, route } = {}) {
    const id = clean(workspaceId, 128);
    const unavailable = reason => ({ ok: true, capability: { supported: false, profiles: [], reason } });
    if (route !== undefined) {
      if (!route || typeof route !== "object" || Array.isArray(route) || typeof route.harness_id !== "string") throw new Error("Choose a valid model route");
      if (runId || nodeId) {
        const saved = await savedNode(id, clean(runId, 80), clean(nodeId, 80));
        if (!saved.node) throw new Error("AO role not found");
        if (saved.node.route.harness_id !== route.harness_id) return unavailable("The selected harness has no connected attempt. Existing role permissions are unchanged.");
        route = saved.node.route;
      }
      if (route.harness_id !== "codex-native") {
        const agent = externalAgent({ route });
        if (!["claude-code", "codex"].includes(agent)) return unavailable("This adapter does not support the three permission modes.");
        const catalog = await harnessService().catalog();
        const adapter = catalog.find(item => item.id === agent && item.installed);
        if (!adapter) return unavailable("This harness is not installed.");
        // The bundled AO adapters accept approvalMode per session. This is not Native Codex
        // metadata or an effective-policy acknowledgement, and grants no shared MCP/app rights.
        return { ok: true, capability: {
          supported: true, source: "ao-adapter", requested_only: true,
          profiles: [{ id: ":workspace", allowed: agent !== "codex" || adapter.chat === true }, { id: ":danger-full-access", allowed: true }],
          ...(agent === "codex" && !adapter.chat ? { reason: "Workspace presets require the Codex chat driver; TUI inherits unverified sandbox settings." } : {}),
          approval_policies: ["on-request", "never"], approvals_reviewers: ["user", "auto_review"],
        } };
      }
    }
    if (!runId || !nodeId) return unavailable("Connect this Native Codex role with local consent before reading its runtime permission profiles.");
    const response = await requestHeadless("/api/v1/ao/harness/permission-profiles", {
      workspace_id: id, run_id: clean(runId, 80), node_id: clean(nodeId, 80),
    });
    if (response?.ok !== true || !response.capability) throw new Error("Native permission capability unavailable");
    return response;
  }

  // What each working card is doing now, for the chat and the cards: when it started, its
  // current step and when anything was last heard. Read-only; it never advances the run.
  function publicText(value, limit = 4096) {
    let text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, "[redacted]")
      .replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
    try {
      const key = cpaConnection?.().proxyApiKey;
      if (typeof key === "string" && key.length >= 8) text = text.replaceAll(key, "[redacted]");
    } catch { /* No CPA connection is needed for read-only output. */ }
    return text.slice(0, limit);
  }

  const activityFrames = new Map();
  const activityAttempt = (workspace, run, node) => JSON.stringify([
    workspace, run, node.id, node.receipt?.request_key || node.request_key || null,
    node.receipt?.thread_id || null, node.receipt?.turn_id || null,
    node.receipt?.started_at_ms || null, node.route?.model || null, node.settings?.revision || null,
  ]);

  async function activity({ workspaceId, runId } = {}) {
    const id = clean(workspaceId, 128), run = clean(runId, 80);
    const saved = await runs({ workspaceId: id, runId: run });
    const mission = saved.runs.find(entry => entry.id === run && entry.workspace_id === id);
    if (!mission) throw new Error("AO run not found");
    const working = mission.nodes.filter(node => ["reserved", "running"].includes(node.state));
    const keys = new Set(working.map(node => activityAttempt(id, run, node)));
    const scope = runKey(id, run);
    for (const [key, entry] of activityFrames) {
      if (entry.scope === scope && !keys.has(key)) {
        entry.retired = true; entry.frame = null;
        if (!entry.pending) activityFrames.delete(key);
      }
    }
    const nodes = {};
    for (const node of working) {
      const key = activityAttempt(id, run, node);
      const base = { state: node.state, started_at_ms: node.receipt?.started_at_ms ?? null,
        activity: "checking", output: "", pending: true };
      let entry = activityFrames.get(key);
      if (!entry) {
        // Keep in-flight tombstones until settled: bounded retention without duplicate requests.
        if (activityFrames.size >= 256) {
          const disposable = [...activityFrames].find(([, value]) => !value.pending);
          if (disposable) activityFrames.delete(disposable[0]);
        }
        if (activityFrames.size >= 256) { nodes[node.id] = base; continue; }
        entry = { scope, pending: null, frame: null, retired: false };
        activityFrames.set(key, entry);
      }
      if (!entry.pending) {
        entry.pending = (async () => {
          let frame;
          try {
            if (externalAgent(node)) {
              const session = node.receipt?.thread_id;
              if (!session) frame = { ...base, activity: "launching" };
              else {
                const observed = await harnessService().observe(session);
                const currentTurn = !node.receipt?.turn_id || observed.turnId === node.receipt.turn_id;
                frame = { ...base, turn_started: Boolean(observed.turnId),
                  activity: observed.needsInput ? "waiting for input" : observed.exited ? "exited" : publicText(observed.turnState || "working", 40),
                  step: publicText(observed.activity || observed.turnState || "working", 120),
                  output: currentTurn ? publicText(observed.liveOutput ?? observed.answer) : "",
                  error: publicText(observed.error, 500) };
              }
            } else {
              const status = (await harnessStatus({ workspaceId: id, runId: run, nodeId: node.id })).status || {};
              const thread = (Array.isArray(status.threads) ? status.threads : []).find(entry => entry.id === node.receipt?.thread_id);
              const turnStarted = Boolean(thread?.turn_id || node.receipt?.turn_id);
              frame = { ...base, turn_started: turnStarted,
                activity: !status.connected ? "not connected" : thread?.activity || (turnStarted ? "working" : "waiting for the turn to start"),
                step: publicText(thread?.activity || "working", 120), output: publicText(status.live_output || thread?.answer || thread?.output),
                error: publicText(status.live_error || thread?.error, 500),
                activity_at_ms: thread?.activity_at_ms || null, last_event_at_ms: thread?.last_event_at_ms || null,
                started_at_ms: base.started_at_ms ?? (thread?.started_at_ms || null) };
            }
            const latest = await savedNode(id, run, node.id);
            if (!latest.node || !["reserved", "running"].includes(latest.node.state)
              || activityAttempt(id, run, latest.node) !== key) {
              entry.retired = true; entry.frame = null; return;
            }
            if (!entry.retired && activityFrames.get(key) === entry) entry.frame = { ...frame, pending: false };
          } catch (error) {
            if (!entry.retired) entry.frame = { ...(entry.frame || base), pending: false,
              activity: "unknown", error: publicText(error?.message || error, 300) };
          }
        })().finally(() => {
          entry.pending = null;
          if (entry.retired && activityFrames.get(key) === entry) activityFrames.delete(key);
        });
      }
      nodes[node.id] = { ...(entry.frame || base), state: node.state, pending: Boolean(entry.pending) };
    }
    return { ok: true, now_ms: Date.now(), nodes };
  }

  async function requireWebReadiness(node) {
    if (node.route?.provider_id !== "chatgpt-web") return;
    if (typeof webBridgeReadiness !== "function") {
      throw new Error("Browser readiness is unavailable; open Browser and sign in to ChatGPT");
    }
    let state;
    try { state = await webBridgeReadiness({ nodeId: node.id, role: node.role, model: node.route.model }); }
    catch { throw new Error("Browser readiness is unavailable; open Browser and check the ChatGPT session"); }
    if (state?.authenticated === false) throw new Error("Sign in to ChatGPT in Browser before starting this role");
    if (state?.authenticated !== true || state?.ready !== true) {
      throw new Error("Browser is not ready; open Browser and check the ChatGPT session");
    }
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
      await requireWebReadiness(node);
    }
    const selected = await resolveHarness({ workspaceId, runId, nodeId, executable,
      model: route.model, providerId: route.provider_id, accountId: route.account_id, permissionProfile: route.permission_profile,
      approvalPolicy: route.approval_policy, approvalsReviewer: route.approvals_reviewer });
    if (!selected || selected.model !== route.model || selected.permission_profile !== route.permission_profile
      || selected.approval_policy !== route.approval_policy || selected.approvals_reviewer !== route.approvals_reviewer
      || selected.allow_model_usage !== true || selected.allow_command_execution !== false) {
      throw new Error("AO native connection does not match the saved route and permission");
    }
    if (!granted && !await confirm({
      message: "Connect this AO-owned Codex session?",
      detail: `Workspace: ${workspaceId}\nRun: ${runId}\nNode: ${nodeId}\nProvider: ${route.provider_id}\nAccount policy: ${route.account_id}\nModel: ${route.model}\nExecutable: ${selected.executable}\nSHA-256: ${selected.expected_sha256}\nPermission: ${permissionText(route.permission_profile)}; approval policy: ${route.approval_policy ?? 'legacy runtime default'}; reviewer: ${route.approvals_reviewer ?? 'legacy runtime default'}; standalone commands: off`.slice(0, 1200),
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

  async function approveAoHarness({ workspaceId, runId, nodeId, approvalId, allow, response, threadId, turnId } = {}) {
    const id = clean(workspaceId, 128), run = clean(runId, 80), node = clean(nodeId, 80);
    const approval = clean(approvalId, 128);
    const typed = response !== undefined;
    if (typed ? allow !== undefined || !response || typeof response !== "object" || Array.isArray(response)
      : typeof allow !== "boolean") throw new Error("Choose either a typed native reply or legacy Allow/Deny");
    let reply, thread, turn;
    if (typed) {
      if (typeof threadId !== "string" || typeof turnId !== "string") throw new Error("Native reply requires live thread/turn scope");
      thread = clean(threadId, 256); turn = clean(turnId, 256);
      const serialized = JSON.stringify(response);
      if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) throw new Error("Native reply exceeds the consent payload limit");
      reply = JSON.parse(serialized);
    }
    const current = await harnessStatus({ workspaceId: id, runId: run, nodeId: node });
    const pending = current.status?.pending_approvals?.find((entry) => entry.approval_id === approval);
    if (!pending) throw new Error("AO tool request is no longer pending");
    if (typed && (!pending.method || pending.thread_id !== thread || pending.turn_id !== turn)) {
      throw new Error("Native approval thread/turn scope changed; refresh the pending request");
    }
    const questions = Array.isArray(pending.request?.questions) ? pending.request.questions : [];
    const displayReply = typed && pending.kind === "questions"
      ? { ...reply, answers: Object.fromEntries(Object.entries(reply.answers ?? {}).map(([key, answer]) =>
        [key, questions.some(question => question.id === key && question.isSecret === true) ? "[redacted secret answer]" : answer])) }
      : reply;
    if (!await confirm({
      message: typed ? "Send this scoped native reply?" : allow ? "Allow this AO tool request once?" : "Deny this AO tool request?",
      detail: typed
        ? `Run: ${run}\nNode: ${node}\nThread: ${thread}\nTurn: ${turn}\nMethod: ${pending.method}\nRequest: ${JSON.stringify(pending.request || {})}\nSelected response: ${JSON.stringify(displayReply)}\nThe native runtime validates its offered decisions and requested permission subset; workspace MCP grants are not changed.`
        : pending.kind === "command"
          ? `Run: ${run}\nNode: ${node}\nCommand: ${String(pending.command || "")}\nWorking directory: ${String(pending.cwd || "")}\nReason: ${String(pending.reason || "")}\nRequested permissions: ${JSON.stringify(pending.permissions || {})}\nThis approves this command once, not the session. The native runtime may execute it beyond the default read-only sandbox.`
          : `Run: ${run}\nNode: ${node}\nPath: ${String(pending.path || "").slice(0, 500)}\nReason: ${String(pending.reason || "").slice(0, 500)}`,
    })) return { ok: false, cancelled: true };
    const result = await requestHeadless("/api/v1/ao/harness/approval", {
      workspace_id: id, run_id: run, node_id: node, approval_id: approval,
      ...(typed ? { response: reply, thread_id: thread, turn_id: turn } : { allow }), confirm: true,
    }, { localConfirmation: true });
    if (result?.ok !== true || result.result?.ok !== true) {
      throw new Error("AO tool approval outcome is unknown; inspect the card before retrying");
    }
    return result;
  }

  async function advance({ workspaceId, runId, executable } = {}) {
    const id = clean(workspaceId, 128);
    const run = clean(runId, 80);
    if (backgroundRuns.get(runKey(id, run))?.status === "running") {
      throw new Error("This AO run is already advancing in the background");
    }
    const saved = await runs({ workspaceId: id, runId: run });
    let mission = saved.runs.find((entry) => entry.id === run && entry.workspace_id === id);
    if (!mission || mission.cancelled) throw new Error("Select an active AO run");
    const active = mission.nodes.find((node) => ["reserved", "running"].includes(node.state));
    if (active) return observe({ workspaceId: id, runId: run, nodeId: active.id });
    const exhausted = mission.nodes.filter(node => node.role === "worker" && node.state === "held"
      && ((node.history?.length ?? 0) >= HELPER_ATTEMPT_LIMIT || POOL_EXHAUSTED.test(String(node.receipt?.error || ""))));
    if (exhausted.length) {
      if (!await confirm({ message: "Send failed work for review?", detail: "Keep partial answers and errors. This does not retry workers or repair accounts." })) return { ok: false, cancelled: true };
      for (const node of exhausted) await controlRun({ workspaceId: id, runId: run, action: "review_failures", nodeId: node.id });
      mission = (await runs({ workspaceId: id, runId: run })).runs.find(entry => entry.id === run && entry.workspace_id === id);
      if (!mission) throw new Error("Saved mission is unavailable");
    }
    const ready = mission.nodes.find((node) => node.state === "pending"
      && parentsReady(mission, node));
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
    const stalePolicy = status.status?.connected && (
      typeof status.status.permission_profile === "string" && status.status.permission_profile !== ready.route.permission_profile
      || ready.route.approval_policy !== undefined && status.status.approval_policy !== ready.route.approval_policy
      || ready.route.approvals_reviewer !== undefined && status.status.approvals_reviewer !== ready.route.approvals_reviewer);
    if (!status.status?.connected || stalePolicy) {
      const connected = await connectAoHarness({ workspaceId: id, runId: run,
        nodeId: ready.id, executable: selectedExecutable });
      if (connected.cancelled) return connected;
    }
    if (!await confirm({
      message: "Run this AO card?",
      detail: `Workspace: ${id}\nRun: ${run}\nNode: ${ready.id}\nRole: ${ready.role}\nModel: ${ready.route.model}\nPermission: ${permissionText(ready.route.permission_profile)}; approval policy: ${ready.route.approval_policy ?? "legacy runtime default"}; reviewer: ${ready.route.approvals_reviewer ?? "legacy runtime default"}; workspace MCP approvals are separate`.slice(0, 1200),
    })) return { ok: false, cancelled: true };
    await requireWebReadiness(ready);
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

  async function controlRun({ workspaceId, runId, action, executable, nodeId } = {}) {
    if (!["pause", "resume", "stop", "retry", "retry_auto", "review_failures"].includes(action)) throw new Error("Choose a mission control");
    const id = clean(workspaceId, 128), run = clean(runId, 80);
    const result = await requestHeadless("/api/v1/ao/control", { workspace_id: id, run_id: run, action, ...(nodeId ? { node_id: clean(nodeId, 80) } : {}), confirm: true }, { localConfirmation: true });
    if (result?.ok !== true || result.run?.workspace_id !== id) throw new Error("Mission control needs a fresh status check");
    if (action === "stop") {
      const saved = await runs({workspaceId:id});
      const life = taskLifecycle(saved,result.run.project_id);
      if (life.schedule?.run_id === run && !["cancelled","missed"].includes(life.schedule.state)) {
        await cancelSchedule({workspaceId:id,taskId:result.run.project_id,intentId:life.schedule.id});
      }
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
    } else if (current && !["retry", "retry_auto", "review_failures"].includes(action)) {
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
  const REVIEW_ROLES = new Set(["review_split", "sub_reviewer", "reviewer"]);

  function exhaustedWorkerFailure(mission) {
    const held = mission.nodes.filter(node => node.state === "held");
    return !mission.cancelled && held.length > 0 && held.every(node => node.role === "worker")
      && held.some(node => (node.history?.length ?? 0) >= HELPER_ATTEMPT_LIMIT)
      && !mission.nodes.some(node => ["cancelled", "archived", "reserved"].includes(node.state));
  }

  function parentsReady(mission, node) {
    if (node.role === "retry" && !mission.nodes.some(entry => entry.role === "worker" && entry.state === "held"
      && (entry.history?.length ?? 0) < HELPER_ATTEMPT_LIMIT && !POOL_EXHAUSTED.test(String(entry.receipt?.error || "")))) return false;
    return (node.parents || []).every(parentId => mission.nodes.some(parent => parent.id === parentId
      && (parent.state === "finished" || REVIEW_ROLES.has(node.role) && (parent.state === "failed"
        || parent.role === "worker" && parent.state === "pending" && blockedByFailure(mission, parent)))));
  }
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
    ? approvals.map((item) => {
      // Modern native commands carry escalation scope separately from item/permissions requests.
      const request = item?.request;
      const scoped = item?.kind === "command" && request
        && (Object.hasOwn(request, "additionalPermissions") || Object.hasOwn(request, "networkApprovalContext"))
        ? { ...item, permissions: { additionalPermissions: request.additionalPermissions ?? null,
          networkApprovalContext: request.networkApprovalContext ?? null } } : item;
      return approverAdvice.has(item?.approval_id)
        ? { ...scoped, recommendation: approverAdvice.get(item.approval_id) } : scoped;
    })
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
        if (approval?.kind !== "command" || !approval.approval_id || approverAdvice.has(approval.approval_id)) continue;
        const request = describeRequest(approval);
        // The command advisor must not decide from a truncated command or permission scope.
        const incomplete = request.length >= 1500 || JSON.stringify(approval.permissions ?? {}).length > 800;
        let advice = incomplete
          ? { action: "ask", reason: "Inspect the complete native command and requested permission scope yourself" }
          : HARD_DENY.some((pattern) => pattern.test(request))
            ? { action: "deny", reason: "Blocked by the command approver's safety rules" }
            : await askApprover({ approver, mission, approval });
        const offered = approval.request?.availableDecisions;
        if (Array.isArray(offered) && advice.action !== "ask"
          && !offered.includes(advice.action === "allow" ? "accept" : "decline")) {
          advice = { action: "ask", reason: "This native request requires a typed offered decision from you" };
        }
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

  const POOL_EXHAUSTED = /auth_unavailable|invalid[_ -]?auth|account[^\n]*(?:exhaust|unavail)|pool[^\n]*exhaust|sign[- ]?in|reauth|HTTP (?:401|403)/i;
  function blockedByFailure(mission, node, depth = 0) {
    return depth < mission.nodes.length && (node.parents || []).some(id => {
      const parent = mission.nodes.find(entry => entry.id === id);
      return parent?.state === "failed" || (parent?.role === "worker" && parent.state === "pending" && blockedByFailure(mission, parent, depth + 1));
    });
  }
  function missionSettled(mission) {
    return mission.nodes.filter(node => node.role !== "retry").every(node =>
      ["finished", "failed", "cancelled", "archived"].includes(node.state) ||
      (node.role === "worker" && node.state === "pending" && blockedByFailure(mission, node)));
  }

  async function recoverHeld(workspaceId, mission, state = {}) {
    const held = mission.nodes.filter(node => node.state === "held");
    if (!held.length || mission.cancelled) return null;
    if (mission.execution_mode === "single") return { detail: "Single model failed; inspect the saved answer and retry explicitly." };
    const workers = held.filter(node => node.role === "worker");
    const exhausted = workers.filter(node => (node.history?.length ?? 0) >= HELPER_ATTEMPT_LIMIT ||
      POOL_EXHAUSTED.test(String(node.receipt?.error || "")));
    if (exhausted.length) {
      for (const node of exhausted) await controlRun({ workspaceId, runId: mission.id, action: "review_failures", nodeId: node.id });
      return { changed: true, detail: "Retries or the account pool are exhausted; review will receive partial work and errors" };
    }
    const node = workers[0] || held.find(entry => entry.role !== "retry");
    if (!node) return null;
    if (REVIEW_ROLES.has(node.role) && (node.receipt?.verdict === "CHANGES_REQUIRED" || mission.nodes.some(entry => entry.role === "worker" && entry.state === "failed"))) {
      return { detail: "Reviewer next step: " + publicText(node.receipt?.answer || node.receipt?.error, 400) };
    }
    if ((node.history?.length ?? 0) >= HELPER_ATTEMPT_LIMIT) {
      return { detail: (node.settings?.name || node.role) + " failed 3 times; decide the next step yourself or send a follow-up" };
    }
    state.recoveryWaits ||= new Map();
    const workerAttempt = node.receipt?.request_key || node.id;
    if (state.recoveryWaits.has(workerAttempt)) return { detail: state.recoveryWaits.get(workerAttempt) };
    const retry = workers.length && mission.nodes.find(entry => entry.role === "retry");
    let decision;
    if (retry) {
      if (retry.state === "held" || retry.state === "failed") {
        await controlRun({ workspaceId, runId: mission.id, action: "review_failures", nodeId: node.id });
        if (retry.state === "held") await controlRun({ workspaceId, runId: mission.id, action: "review_failures", nodeId: retry.id });
        return { changed: true, detail: "Retry role failed; partial work and recovery errors go to review" };
      }
      if (retry.state !== "finished") return { detail: "The configured Retry role is deciding the failed step" };
      state.recoveryDecisions ||= new Map();
      const request = retry.receipt?.request_key || retry.id;
      const attempt = node.receipt?.request_key || node.id;
      const prior = state.recoveryDecisions.get(request);
      if ((prior && prior !== attempt) || (retry.receipt?.started_at_ms && node.receipt?.started_at_ms > retry.receipt.started_at_ms)) {
        await controlRun({ workspaceId, runId: mission.id, action: "retry", nodeId: retry.id });
        return { changed: true, detail: "Retry role is inspecting the new failed attempt" };
      }
      if (prior === attempt) return { detail: state.recoveryDetail || "Retry is waiting for your action" };
      try {
        const answer = String(retry.receipt?.answer || "").slice(0, 4000);
        decision = JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1));
        if (!["retry", "wait", "stop", "give_up"].includes(decision?.action)) throw new Error("Retry returned no bounded decision");
      } catch { decision = { action: "give_up", reason: "Retry returned no verifiable decision" }; }
      state.recoveryDecisions.set(request, attempt);
    } else {
      try {
        const task = (await board({ workspaceId, taskId: mission.project_id })).task;
        decision = await askRecoveryHelper({ mission, node, task });
      } catch {
        decision = TRANSIENT_FAILURE.test(String(node.receipt?.error || ""))
          ? { action: "retry", reason: "The failure looks transient" }
          : { action: "wait", reason: "The recovery helper is unavailable; inspect the failed step" };
      }
    }
    const detail = "Helper: " + publicText(decision.reason || decision.action, 300);
    state.recoveryDetail = detail;
    if (decision.action === "wait") state.recoveryWaits.set(workerAttempt, detail);
    if (decision.action === "retry") {
      await controlRun({ workspaceId, runId: mission.id, action: node.role === "worker" ? "retry_auto" : "retry", ...(node.role === "worker" ? { nodeId: node.id } : {}) });
      return { changed: true, retried: true, detail: "Helper retried " + (node.settings?.name || node.role) + ": " + publicText(decision.reason, 300) };
    }
    if (workers.length && ["stop", "give_up"].includes(decision.action)) {
      await controlRun({ workspaceId, runId: mission.id, action: "review_failures", nodeId: node.id });
      return { changed: true, detail };
    }
    return { detail };
  }

  // Connects the harnesses of all cards that are ready to run, concurrently, up to the worker
  // capacity. Failures are left to the launch loop, which reports them for the right card.
  async function connectReadyHarnesses(workspaceId, runId, mission, saved, executable) {
    let workers = saved.worker_capacity?.[runId] ?? 0;
    const ready = mission.nodes.filter((node) => node.state === "pending" && parentsReady(mission, node) && !externalAgent(node)
      && (node.role !== "worker" || workers-- > 0));
    if (ready.length < 2) return;
    await Promise.allSettled(ready.map(async (node) => {
      const status = await harnessStatus({ workspaceId, runId, nodeId: node.id });
      if (status.status?.connected) return;
      await connectAoHarness({ workspaceId, runId, nodeId: node.id, executable }, true);
    }));
  }

  async function driveRun(workspaceId, runId, executable, state) {
    const pause = () => new Promise(resolve => setTimeout(resolve, 500));
    const observing = new Map();
    state.driving = true;
    try {
      for (;;) {
        if (state.stopped) { reportRun(workspaceId, runId, state, null); return; }
        let saved = await runs({ workspaceId, runId });
        let mission = saved.runs.find(entry => entry.id === runId && entry.workspace_id === workspaceId);
        if (!mission) throw new Error("Saved mission is unavailable");
        if (!Number.isInteger(saved.worker_capacity?.[runId])) throw new Error("The installed AO service does not report worker capacity; update the matching runtime");
        // Start every ready Native Codex card's harness together first. Launching a Codex process
        // can take minutes on a slow disk; done one card at a time, a sibling worker waited for
        // it and the workers ran one after another instead of in parallel. The launches below
        // stay one at a time because each reserves against the latest mission revision.
        if (!state.stopped && !mission.cancelled && !mission.paused) await connectReadyHarnesses(workspaceId, runId, mission, saved, executable);
        // Reserve and launch with the latest revision; never await sibling output here.
        while (!state.stopped && !mission.cancelled && !mission.paused
          && !(mission.grant?.expires_at_ms && Date.now() >= mission.grant.expires_at_ms)) {
          const capacity = saved.worker_capacity[runId];
          const ready = mission.nodes.find(node => node.state === "pending" && parentsReady(mission, node) && (node.role !== "worker" || capacity > 0));
          if (!ready) break;
          let sent;
          try {
            if (externalAgent(ready)) sent = await dispatchExternal(workspaceId, runId, ready, mission.revision, true);
            else {
              const status = await harnessStatus({ workspaceId, runId, nodeId: ready.id });
              if (status.status?.connected && status.status.model !== ready.route.model) throw new Error("AO connected harness route changed");
              // A connected harness whose permission policy no longer matches the card is reconnected.
              const stalePolicy = status.status?.connected && (
                typeof status.status.permission_profile === "string" && status.status.permission_profile !== ready.route.permission_profile
                || ready.route.approval_policy !== undefined && status.status.approval_policy !== ready.route.approval_policy
                || ready.route.approvals_reviewer !== undefined && status.status.approvals_reviewer !== ready.route.approvals_reviewer);
              if (!status.status?.connected || stalePolicy) {
                const connected = await connectAoHarness({ workspaceId, runId, nodeId: ready.id, executable }, true);
                if (connected.waiting) { state.detail = "Waiting for a harness slot"; break; }
              }
              await requireWebReadiness(ready);
              sent = await requestHeadless("/api/v1/ao/harness/execute", {
                workspace_id: workspaceId, run_id: runId, node_id: ready.id,
                expected_revision: mission.revision, confirm: false,
              });
              if (sent?.ok !== true) throw new Error("AO turn outcome unknown");
            }
          } catch (error) {
            const fresh = await runs({ workspaceId, runId });
            const next = fresh.runs.find(entry => entry.id === runId && entry.workspace_id === workspaceId);
            // Recover only a persisted failed launch. An unknown send is never replayed.
            if (!next?.nodes.some(node => node.id === ready.id && node.state === "held")) throw error;
            saved = fresh; mission = next; continue;
          }
          if (sent.waiting) { state.detail = "Waiting for a worker slot or current graph revision"; break; }
          saved = await runs({ workspaceId, runId });
          mission = saved.runs.find(entry => entry.id === runId && entry.workspace_id === workspaceId);
          if (!mission) throw new Error("Saved mission is unavailable");
        }
        if (state.stopped) return;
        const active = mission.nodes.filter(node => node.state === "running");
        for (const [id] of observing) if (!active.some(node => node.id === id)) observing.delete(id);
        for (const node of active) {
          if (observing.has(node.id)) continue;
          const pending = { done: false };
          pending.promise = observe({ workspaceId, runId, nodeId: node.id })
            .then(result => { pending.result = result; }, error => { pending.error = error; })
            .finally(() => { pending.done = true; });
          observing.set(node.id, pending);
        }
        const completed = active.filter(node => observing.get(node.id)?.done);
        const observed = completed.map(node => observing.get(node.id).result || {});
        for (const node of completed) {
          const pending = observing.get(node.id);
          if (pending.error) state.detail = publicText(pending.error?.message || pending.error, 500);
          observing.delete(node.id);
        }
        const attention = observed.some(result => result.pending_approvals?.length) ? "pending_approval"
          : observed.some(result => result.needs_input) ? "needs_input" : null;
        if (attention) state.detail = attention === "pending_approval" ? "Waiting for your tool approval" : "An AO worker needs input on the Board";
        if (attention === "pending_approval") {
          const note = await screenApprovals(workspaceId, runId, mission, completed, observed)
            .catch(error => "Command approver unavailable: " + publicText(error?.message || error, 200));
          if (note) state.detail = note;
        }
        const helped = mission.paused || mission.cancelled ? null : await recoverHeld(workspaceId, mission, state);
        if (helped?.detail) state.detail = helped.detail;
        if (helped?.changed || completed.length) {
          saved = await runs({ workspaceId, runId });
          mission = saved.runs.find(entry => entry.id === runId && entry.workspace_id === workspaceId);
          if (!mission) throw new Error("Saved mission is unavailable");
          if (helped?.retried && !mission.grant) {
            state.status = "held";
            setTimeout(() => { void startRun({ workspaceId, runId, executable }).catch(() => {}); }, 0);
            return;
          }
          if (helped?.changed) continue;
        }
        reportRun(workspaceId, runId, state, mission, attention);
        if (missionSettled(mission)) {
          const failed = mission.nodes.some(node => node.state === "failed");
          state.status = failed ? "failed" : mission.cancelled ? "held" : "finished";
          state.detail = failed ? "Review contains failed or blocked work; inspect partial results before continuing" : undefined;
          reportRun(workspaceId, runId, state, mission, failed ? "error" : null); return;
        }
        const running = mission.nodes.some(node => ["running", "reserved"].includes(node.state));
        if (!running && !mission.paused && !mission.nodes.some(node => node.state === "pending" && parentsReady(mission, node))) {
          state.status = "held";
          state.detail ||= mission.nodes.some(node => node.role === "worker" && node.state === "pending" && blockedByFailure(mission, node))
            ? "Queued work is blocked by a failed dependency; inspect partial results" : "No card is ready; inspect dependencies and failed steps";
          reportRun(workspaceId, runId, state, mission, "stopped"); return;
        }
        if (mission.paused) { state.status = "paused"; state.detail = "Paused; queued work will not start"; }
        else if (mission.cancelled) { state.status = "held"; state.detail = "Finishing already-sent turns; no more work will start"; }
        else {
          state.status = "running";
          if (mission.grant?.expires_at_ms && Date.now() >= mission.grant.expires_at_ms) {
            state.status = "held"; state.detail = "Run grant expired; already-sent turns may finish, but queued work needs local approval";
            if (!running) { reportRun(workspaceId, runId, state, mission, "stopped"); return; }
          }
        }
        const pending = [...observing.values()].filter(entry => !entry.done).map(entry => entry.promise);
        if (pending.length) await Promise.race([...pending, pause()]);
        else if (running || mission.paused || saved.worker_capacity[runId] === 0) await pause();
      }
    } catch (error) {
      state.status = "held"; state.detail = publicText(error?.message || error, 500);
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
    const state = { status: "starting", starting: true, detail: "Awaiting local approval", recoveryDecisions: existing?.recoveryDecisions };
    backgroundRuns.set(key, state);
    try {
      const saved = await runs({ workspaceId: id, runId: run });
      let mission = saved.runs.find((entry) => entry.id === run && entry.workspace_id === id);
      if (mission?.paused) throw new Error("Resume this paused mission from its local controls");
      // Starting a run whose card is held (and nothing still running) is an explicit retry.
      if (mission && !mission.cancelled && mission.nodes.some((node) => node.state === "held" && (node.role !== "worker" || !mission.grant))
        && !mission.nodes.some((node) => ["running", "reserved"].includes(node.state))) {
        await controlRun({ workspaceId: id, runId: run, action: "retry" });
        const again = await runs({ workspaceId: id, runId: run });
        mission = again.runs.find((entry) => entry.id === run && entry.workspace_id === id);
      }
      if (!mission || mission.cancelled || !mission.nodes?.length
        || mission.nodes.some((node) => ["cancelled", "archived", "reserved"].includes(node.state))) {
        throw new Error("AO run has an active or unresolved card; inspect it before starting");
      }
      if (missionSettled(mission)) throw new Error("AO run is already finished");
      const resuming = mission.nodes.some((node) => node.state === "running") || Boolean(mission.grant && mission.nodes.some(node => ["held", "failed"].includes(node.state)));
      const readyWebRole = mission.nodes.find(node => node.state === "pending"
        && node.route?.provider_id === "chatgpt-web"
        && (node.parents ?? []).every(parent => mission.nodes.some(entry => entry.id === parent && entry.state === "finished")));
      if (readyWebRole) await requireWebReadiness(readyWebRole);
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
      state.status = "failed";
      state.starting = false;
      state.detail = publicText(error?.message || error, 500);
      reportRun(id, run, state, null, "error");
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

  // Codex "Rename" on a chat's task. It keeps the description, which holds the chat's messages.
  async function taskRename({ workspaceId, taskId, title } = {}) {
    const id = clean(taskId, 128);
    if (typeof title !== "string" || !title.trim()) throw new Error("Give the chat a name");
    const name = clean(title.trim(), 240);
    const current = await board({ workspaceId, taskId: id });
    if (!current.task || current.task.id !== id) throw new Error("This chat's task no longer exists");
    await write(workspaceId, {
      expected_revision: current.revision,
      change: { operation: "edit", id, title: name, description: current.task.description ?? "" },
    });
    return board({ workspaceId });
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
    return run.cancelled || missionSettled({ ...run, nodes: run.nodes ?? [] });
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

  async function createTeamRun(id, task, team, selection = {}, includeRun = false) {
    const current = await board({ workspaceId: id });
    const runId = randomUUID();
    const created = await updateRun({ workspaceId: id, change: {
      operation: "create_from_team", run_id: runId, task_id: task,
      expected_board_revision: current.revision,
      ...(selection.executionMode === "single" ? { execution_mode: "single", single_route: selection.singleRoute, worker_limit: 1 }
        : { team_revision: team.revision, team_id: team.id,
          worker_limit: Number.isSafeInteger(team.worker_limit) && team.worker_limit > 0 ? team.worker_limit : 3,
          ...(selection.executionMode === "team" ? { execution_mode: "team" } : {}) }),
    } });
    return includeRun ? { runId, run: created.run } : runId;
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
    const single = mission.execution_mode === "single";
    const team = mission.team?.id ? (saved.teams ?? [saved.team]).find(item => item?.id === mission.team.id) : saved.team;
    if (!single && (!team?.id || !Number.isSafeInteger(team.revision))) throw new Error("Save the selected team for this workspace first");
    let singleRoute;
    if (single) {
      const node = mission.nodes[0];
      if (!node?.route) throw new Error("Single model route unavailable");
      singleRoute = { ...node.route };
      const intent = mission.team?.permission_selections?.[node.template_role_id || node.id];
      if (intent?.permission_profile !== undefined) {
        singleRoute.native_permission_profile = intent.permission_profile;
        if (singleRoute.harness_id === "codex-native") singleRoute.permission_profile = intent.permission_profile;
      }
      if (intent?.approval_policy !== undefined) singleRoute.approval_policy = intent.approval_policy;
      if (intent?.approvals_reviewer !== undefined) singleRoute.approvals_reviewer = intent.approvals_reviewer;
    }
    if (!single) {
      const missingModel = missingModelNotice(team);
      if (missingModel) return { ok: false, reason: missingModel };
    }
    await retireOpenRuns(id, mission.project_id, saved.runs);
    const next = await createTeamRun(id, mission.project_id, team,
      single ? { executionMode: "single", singleRoute }
        : mission.team?.id ? { executionMode: "team" } : {});
    try {
      const started = await startRun({ workspaceId: id, runId: next, executable: selectedExecutable });
      return { ok: true, runId: next, status: started.status };
    } catch (error) {
      return { ok: true, runId: next, status: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async function chatSend({ workspaceId, taskId, title, message, executable, executionMode, singleRoute, teamId, teamRevision, deferStart } = {}) {
    const id = clean(workspaceId, 128);
    const text = clean(message, 8192, false);
    if (!text.trim()) throw new Error("Type a message to start the chat");
    const selectedExecutable = codexExecutable(executable);
    const saved = await runs({ workspaceId: id });
    if (executionMode !== undefined && !["single", "team"].includes(executionMode)) throw new Error("Choose single or team execution");
    if (deferStart !== undefined && typeof deferStart !== "boolean") throw new Error("Choose a valid deferred startup option");
    let team = saved.team;
    if (executionMode === "single") {
      const allowed = ["harness_id", "provider_id", "account_id", "model", "permission_profile", "native_permission_profile", "approval_policy", "approvals_reviewer", "effort", "context_window"];
      if (teamId !== undefined || teamRevision !== undefined || !singleRoute || typeof singleRoute !== "object" || Array.isArray(singleRoute)
        || Object.keys(singleRoute).some(key => !allowed.includes(key))
        || typeof singleRoute.model !== "string" || !singleRoute.model || singleRoute.model === "default") {
        throw new Error("Choose one explicit model route without saved-team fields");
      }
      clean(singleRoute.model, 128); clean(singleRoute.harness_id, 128); clean(singleRoute.permission_profile, 128);
    } else {
      if (singleRoute !== undefined) throw new Error("A team request cannot include a single model route");
      if (executionMode === "team" && (teamId === undefined || teamRevision === undefined)) {
        throw new Error("Saved team changed; refresh its identity and revision before sending");
      }
      // A follow-up keeps the team the task last ran with unless another is chosen.
      const previous = taskId ? saved.runs.filter(run => run.project_id === taskId).at(-1) : null;
      const selectedId = (teamId === undefined ? "" : clean(teamId, 80)) || previous?.team?.id;
      team = selectedId ? (saved.teams ?? (saved.team ? [saved.team] : [])).find(item => item?.id === selectedId) : saved.team;
      if (!team?.id || !Number.isSafeInteger(team.revision) || (team.workspace_id && team.workspace_id !== id)) throw new Error("Saved team changed or was not found; refresh before starting");
      if (teamRevision !== undefined && (!Number.isSafeInteger(teamRevision) || teamRevision < 0 || teamRevision !== team.revision)) {
        throw new Error("Saved team revision changed; refresh before starting");
      }
      const missingModel = missingModelNotice(team);
      if (missingModel) return { ok: false, reason: missingModel };
    }

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
        operation: "create", title: clean(title && String(title).trim() ? title : executionMode === "single" ? fallbackChatTitle(text) : CHAT_TASK_TITLE, 240), description: text,
      } });
      const added = (await board({ workspaceId: id })).tasks.filter((entry) => !known.has(entry.id));
      if (added.length !== 1) throw new Error("The new chat's task needs review; refresh the board");
      task = added[0].id;
    }

    const { runId, run: createdRun } = await createTeamRun(id, task, team, { executionMode, singleRoute }, true);
    if (deferStart === true) {
      // Keep the normal authorization path: an expired/missing local approval fails visibly.
      void startRun({ workspaceId: id, runId, executable: selectedExecutable }).then(() => {
        if (!taskId) void nameChat(id, task, text).catch(() => undefined);
      }).catch(() => undefined);
      return { ok: true, taskId: task, runId, run: createdRun, status: "starting" };
    }
    // The chat exists from here on: report a failed start inside it instead of losing the chat.
    try {
      const started = await startRun({ workspaceId: id, runId, executable: selectedExecutable });
      if (!taskId && executionMode !== "single") void nameChat(id, task, text).catch(() => undefined);
      return { ok: true, taskId: task, runId, status: started.status };
    } catch (error) {
      return { ok: true, taskId: task, runId, status: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  const configurationJobs = new Map();
  const ownTeamRevisions = new Map();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function lifecycleMutation(workspaceId, change) {
    const result = await requestHeadless("/api/v1/ao/update", {
      workspace_id: workspaceId, change: { operation: "lifecycle", change }, confirm: true,
    }, { localConfirmation: true });
    if (result?.ok !== true || result.lifecycle?.workspace_id !== workspaceId) {
      throw new Error("Mission intent needs a fresh status check; no replacement was assumed");
    }
    return result;
  }
  function taskLifecycle(saved, taskId) {
    return saved.task_lifecycle?.find(item => item.task_id === taskId) ?? { revision: 0, visibility: "active", reconfigure: [], schedule: null };
  }
  function visibleHandoff(mission) {
    const parts = [];
    for (const node of mission.nodes || []) {
      parts.push(`${node.settings?.name || node.role}: ${node.state}`);
      for (const receipt of [...(node.history || []), node.receipt].filter(Boolean)) {
        if (typeof receipt.answer === "string" && receipt.answer.trim()) parts.push(receipt.answer);
      }
    }
    const text = parts.join("\n\n");
    const characters = Array.from(text);
    return characters.length <= 8000 ? text : characters.slice(0, 7970).join("") + "\n[visible work truncated]";
  }
  // New replacement/hide paths require proof. The older manual control keeps its own behavior.
  async function stopOwned(workspaceId, mission) {
    const state = backgroundRuns.get(runKey(workspaceId, mission.id));
    if (state) { state.stopped = true; state.status = "held"; }
    const keys = () => [...dispatching].some(key => {
      const [ws, run] = JSON.parse(key); return ws === workspaceId && run === mission.id;
    });
    for (let attempt = 0; keys() && attempt < 40; attempt++) await delay(250);
    if (keys()) throw new Error("Owned launch is still pending; stop needs attention");
    const current = await runs({ workspaceId, runId: mission.id });
    const latest = current.runs.find(run => run.id === mission.id && run.workspace_id === workspaceId);
    if (!latest) throw new Error("Owned mission disappeared while stopping");
    const external = latest.nodes.filter(node => externalAgent(node)
      && (["running","reserved"].includes(node.state) || node.request_key && node.state !== "finished" && node.receipt?.status !== "completed"));
    if (external.some(node => !node.receipt?.thread_id)) throw new Error("Owned session identity is unknown; stop needs attention");
    const result = await requestHeadless("/api/v1/ao/control", {
      workspace_id: workspaceId, run_id: mission.id, action: "stop", confirm: true,
    }, { localConfirmation: true });
    if (result?.ok !== true || result.run?.id !== mission.id || result.run?.workspace_id !== workspaceId
        || result.run.nodes.some(node => ["running", "reserved"].includes(node.state))) {
      throw new Error("Owned native stop was not acknowledged; no replacement was started");
    }
    for (const node of external) {
      await harnessService().interrupt(node.receipt.thread_id);
      let stopped = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const observation = await harnessService().observe(node.receipt.thread_id);
        stopped = observation.exited === true || (["completed", "failed", "interrupted", "cancelled"].includes(observation.turnState)
          && !["working", "running", "starting"].includes(observation.status));
        if (stopped) break;
        await delay(250);
      }
      if (!stopped) throw new Error("Owned turn is still working; stop needs attention, no replacement was started");
    }
    return result.run;
  }
  async function resolveStoppedIntents(workspaceId,taskId,saved) {
    let life=taskLifecycle(saved,taskId);
    for(const intent of life.reconfigure || []) {
      if (!["prepared","needs_attention"].includes(intent.phase)) continue;
      const record=await runs({workspaceId,runId:intent.previous_run_id});
      const mission=record.runs.find(run=>run.id===intent.previous_run_id && run.project_id===taskId);
      if (!mission) throw new Error("Unconfirmed owned mission needs attention");
      await stopOwned(workspaceId,mission);
      const fresh=taskLifecycle(await runs({workspaceId}),taskId);
      const result=await lifecycleMutation(workspaceId,{operation:"reconfigure_stopped",task_id:taskId,
        intent_id:intent.id,expected_revision:fresh.revision,stopped_attempts:intent.required_attempts || []});
      life=result.lifecycle;
    }
    return life;
  }
  async function reconfigureRun(input = {}) {
    const workspaceId = clean(input.workspaceId, 128), previous = clean(input.runId, 80);
    if (Object.keys(input).some(key => !["workspaceId", "runId", "taskId", "team", "intentId", "executable"].includes(key))) {
      throw new Error("Unsupported mission configuration field");
    }
    const first = await runs({ workspaceId, runId: previous });
    const captured = first.runs.find(run => run.id === previous && run.workspace_id === workspaceId);
    if (!captured || input.taskId && captured.project_id !== input.taskId) throw new Error("Mission is not owned by the captured task");
    const taskId = captured.project_id, key = JSON.stringify([workspaceId, taskId]);
    const draft = structuredClone(input.team);
    const operation = (configurationJobs.get(key) || Promise.resolve()).catch(() => undefined).then(async () => {
      let saved = await runs({ workspaceId });
      let life = await resolveStoppedIntents(workspaceId,taskId,saved);
      saved = await runs({workspaceId});
      if (life.visibility !== "active") throw new Error("Restore this task before changing its configuration");
      let runId = previous;
      const seen = new Set();
      while (!seen.has(runId)) {
        seen.add(runId);
        const replacement = life.reconfigure?.find(intent => intent.previous_run_id === runId && intent.phase === "replaced")?.replacement_run_id;
        if (!replacement) break;
        runId = replacement;
      }
      if (life.schedule && ["scheduled","missed","needs_attention","cancelled","claimed"].includes(life.schedule.state)) runId = life.schedule.run_id;
      let mission = saved.runs.find(run => run.id === runId && run.workspace_id === workspaceId && run.project_id === taskId);
      if (!mission) mission = (await runs({ workspaceId, runId })).runs.find(run => run.id === runId && run.project_id === taskId);
      if (!mission) throw new Error("Current task-owned mission was not found");
      if (!draft || draft.workspace_id !== workspaceId || !Array.isArray(draft.nodes)) throw new Error("Choose a valid workspace team");
      const invalid = draft.nodes.find(node => !node.route?.model || node.route.model === "default");
      if (invalid) throw new Error(`Choose an explicit model for ${invalid.settings?.name || invalid.role}; configuration was not applied`);
      const currentTeam = (saved.teams || [saved.team]).find(team => team?.id === draft.id);
      if (!currentTeam) throw new Error("Saved team identity changed; reopen its settings");
      const known = ownTeamRevisions.get(JSON.stringify([workspaceId, draft.id]));
      if (draft.revision !== currentTeam.revision && known !== currentTeam.revision) throw new Error("Team changed in another window; refresh before retrying");
      const response = await teamUpdate({ workspaceId, change: { operation: "save_team",
        expected_revision: currentTeam.revision, team: { ...draft, revision: currentTeam.revision } } });
      const team = response.team;
      ownTeamRevisions.set(JSON.stringify([workspaceId, team.id]), team.revision);
      const intentId = input.intentId ? clean(input.intentId, 128) : randomUUID();
      const prepared = await lifecycleMutation(workspaceId, { operation: "prepare_reconfigure", task_id: taskId,
        intent_id: intentId, expected_revision: life.revision, run_id: mission.id, run_revision: mission.revision,
        team_id: team.id, team_revision: team.revision });
      try {
        const stopped = await stopOwned(workspaceId, mission);
        const intent = prepared.lifecycle.reconfigure.find(item => item.id === intentId);
        if (!intent) throw new Error("Prepared replacement identity was not returned");
        // The durable kernel compares these exact identities with its prepared reservation set.
        const finished = await lifecycleMutation(workspaceId, { operation: "finish_reconfigure", task_id: taskId,
          intent_id: intentId, expected_revision: prepared.lifecycle.revision,
          replacement_run_id: randomUUID(), stopped_attempts: intent.required_attempts, handoff: visibleHandoff(mission) });
        const replacement = finished.run;
        if (!replacement?.id || replacement.workspace_id !== workspaceId) throw new Error("Replacement outcome needs inspection");
        if (finished.lifecycle.schedule && ["scheduled","missed","needs_attention","cancelled","claimed"].includes(finished.lifecycle.schedule.state)) {
          armSchedule(workspaceId, finished.lifecycle);
          return { ok: true, taskId, previousRunId: mission.id, runId: replacement.id, team, status: finished.lifecycle.schedule.state,
            detail: finished.lifecycle.schedule.state === "scheduled" ? "Original deadline preserved" : "Configuration applied; explicit schedule recovery is required." };
        }
        try {
          const started = await startRun({ workspaceId, runId: replacement.id, ...(input.executable ? { executable: input.executable } : {}) });
          return { ok: true, taskId, previousRunId: mission.id, runId: replacement.id, team, status: started.status };
        } catch {
          return { ok: true, taskId, previousRunId: mission.id, runId: replacement.id, team, status: "failed",
            detail: "Configuration applied; the new mission could not start. Check its harness and start it explicitly." };
        }
      } catch (error) {
        await lifecycleMutation(workspaceId, { operation: "reconfigure_attention", task_id: taskId, intent_id: intentId,
          expected_revision: prepared.lifecycle.revision, message: "Owned stop or replacement needs inspection; no automatic replay." }).catch(() => undefined);
        throw error;
      }
    });
    configurationJobs.set(key, operation);
    try { return await operation; } finally { if (configurationJobs.get(key) === operation) configurationJobs.delete(key); }
  }

  const scheduleTimers = new Map();
  let schedulerDisposed = false;
  const scheduleKey = (workspaceId, taskId) => JSON.stringify([workspaceId, taskId]);
  function clearSchedule(workspaceId, taskId) {
    const key = scheduleKey(workspaceId, taskId);
    const timer = scheduleTimers.get(key);
    if (timer !== undefined) clearTimer(timer);
    scheduleTimers.delete(key);
  }
  function armSchedule(workspaceId, life) {
    clearSchedule(workspaceId, life.task_id);
    const job = life.schedule;
    if (schedulerDisposed || life.visibility !== "active" || job?.state !== "scheduled") return;
    const key = scheduleKey(workspaceId, life.task_id);
    const handle = setTimer(async () => {
      scheduleTimers.delete(key);
      if (schedulerDisposed) return;
      try {
        const saved = await runs({ workspaceId });
        const current = taskLifecycle(saved, life.task_id), latest = current.schedule;
        if (current.visibility !== "active" || latest?.id !== job.id || latest.state !== "scheduled") return;
        if (latest.due_at_ms > now()) { armSchedule(workspaceId, current); return; }
        const claim = await lifecycleMutation(workspaceId, { operation:"claim_schedule", task_id:life.task_id,
          intent_id:latest.id, expected_revision:current.revision });
        if (schedulerDisposed) return;
        try {
          await startRun({ workspaceId, runId:claim.run.id });
          await lifecycleMutation(workspaceId, { operation:"recover_schedule", task_id:life.task_id,
            intent_id:latest.id, expected_revision:claim.lifecycle.revision, action:"started" });
        } catch {
          const fresh = taskLifecycle(await runs({ workspaceId }), life.task_id);
          if (fresh.schedule?.id === latest.id && fresh.schedule.state === "claimed") {
            await lifecycleMutation(workspaceId, { operation:"recover_schedule", task_id:life.task_id,
              intent_id:latest.id, expected_revision:fresh.revision, action:"needs_attention" });
          }
        }
      } catch {
        // Reconcile a lost claim response, but never repeat a start from uncertainty.
        try {
          const fresh=taskLifecycle(await runs({workspaceId}),life.task_id);
          if(fresh.schedule?.id===job.id && fresh.schedule.state==="claimed") {
            await lifecycleMutation(workspaceId,{operation:"recover_schedule",task_id:life.task_id,
              intent_id:job.id,expected_revision:fresh.revision,action:"needs_attention"});
          } else if(fresh.schedule?.id===job.id && fresh.schedule.state==="scheduled" && fresh.schedule.due_at_ms<=now()) {
            await lifecycleMutation(workspaceId,{operation:"recover_schedule",task_id:life.task_id,
              intent_id:job.id,expected_revision:fresh.revision,action:"missed"});
          }
        } catch { /* Keep the durable uncertain intent for explicit recovery. */ }
      }
    }, Math.min(2_147_483_647, Math.max(1, job.due_at_ms - now())));
    handle?.unref?.();
    scheduleTimers.set(key, handle);
  }
  async function restoreSchedules(workspaces = []) {
    schedulerDisposed = false;
    for (const workspace of workspaces) {
      const workspaceId = clean(typeof workspace === "string" ? workspace : workspace.id, 128);
      const saved = await runs({ workspaceId });
      for (const life of saved.task_lifecycle || []) {
        const job = life.schedule;
        if (!job || life.visibility !== "active") continue;
        if (job.state === "claimed" || job.state === "scheduled" && job.due_at_ms <= now()) {
          await lifecycleMutation(workspaceId, { operation:"recover_schedule", task_id:life.task_id,
            intent_id:job.id, expected_revision:life.revision,
            action:job.state === "claimed" ? "needs_attention" : "missed" });
        } else armSchedule(workspaceId, life);
      }
    }
  }
  async function scheduleStart(input = {}) {
    const key=JSON.stringify([clean(input.workspaceId,128),clean(input.taskId,128)]);
    const previous=configurationJobs.get(key);
    const operation=(previous || Promise.resolve()).catch(()=>undefined).then(()=>scheduleStartNow(input));
    configurationJobs.set(key,operation);
    try { return await operation; }
    finally { if(configurationJobs.get(key)===operation) configurationJobs.delete(key); }
  }
  async function scheduleStartNow({ workspaceId, taskId, runId, delay: value, unit, intentId, team: draft } = {}) {
    const id = clean(workspaceId,128), task = clean(taskId,128), duration = delayToMilliseconds(value,unit);
    let due = now() + duration;
    if (!Number.isSafeInteger(due) || due > 8_640_000_000_000_000) throw new Error("Delay exceeds the supported date range");
    const saved = await runs({workspaceId:id});
    const source = saved.runs.find(run=>run.id===runId && run.workspace_id===id && run.project_id===task);
    if (!source) throw new Error("Select this task's saved mission before scheduling");
    if (saved.runs.some(run=>run.project_id===task && run.nodes.some(node=>["running","reserved"].includes(node.state)))) {
      throw new Error("Stop this task before scheduling a delayed start");
    }
    let team = (saved.teams || [saved.team]).find(team=>team?.id === source.team?.id) || saved.team;
    if (!team?.id) throw new Error("Save a valid team before scheduling");
    if (!await confirm({message:"Schedule this mission once?",detail:`${task}\nStart after ${value} ${unit}. The app must stay running; a missed start requires recovery.`})) return {ok:true,cancelled:true};
    if (draft) {
      if(draft.id!==team.id || draft.workspace_id!==id || !Array.isArray(draft.nodes)) throw new Error("Choose this task's saved team");
      const missing=missingModelNotice(draft);if(missing) throw new Error(missing);
      const known=ownTeamRevisions.get(JSON.stringify([id,draft.id]));
      if(draft.revision!==team.revision && known!==team.revision) throw new Error("Team changed in another window; refresh before scheduling");
      const updated=await teamUpdate({workspaceId:id,change:{operation:"save_team",expected_revision:team.revision,
        team:{...draft,revision:team.revision}}});
      team=updated.team;ownTeamRevisions.set(JSON.stringify([id,team.id]),team.revision);
    }
    await resolveStoppedIntents(id,task,saved);
    const refreshed=await runs({workspaceId:id});
    for(const old of refreshed.runs.filter(run=>run.project_id===task && run.nodes.some(node=>node.request_key && node.state==="cancelled" && node.receipt?.status!=="completed"))) await stopOwned(id,old);
    const life = taskLifecycle(await runs({workspaceId:id}),task);
    due=now()+duration;
    const result = await lifecycleMutation(id,{operation:"schedule_start",task_id:task,
      intent_id:intentId ? clean(intentId,128) : randomUUID(),expected_revision:life.revision,
      run_id:randomUUID(),team_id:team.id,team_revision:team.revision,due_at_ms:due});
    armSchedule(id,result.lifecycle);
    return {ok:true,taskId:task,runId:result.run.id,status:"scheduled",dueAtMs:due};
  }
  async function cancelSchedule({workspaceId,taskId,intentId} = {}) {
    const id=clean(workspaceId,128),task=clean(taskId,128);
    clearSchedule(id,task);
    const saved=await runs({workspaceId:id}),life=taskLifecycle(saved,task);
    if (!life.schedule || intentId && life.schedule.id !== intentId) throw new Error("The selected schedule changed");
    for (const mission of saved.runs.filter(run=>run.project_id===task && run.nodes.some(node=>["running","reserved"].includes(node.state)
      || node.request_key && node.state !== "finished" && node.receipt?.status !== "completed"))) await stopOwned(id,mission);
    const fresh=taskLifecycle(await runs({workspaceId:id}),task);
    return lifecycleMutation(id,{operation:"cancel_schedule",task_id:task,intent_id:fresh.schedule.id,expected_revision:fresh.revision});
  }
  async function visibilityAction({workspaceId,taskId} = {},visibility) {
    const id=clean(workspaceId,128),task=clean(taskId,128);
    const detail=await board({workspaceId:id,taskId:task});
    if (!detail.task) throw new Error("The selected task was not found");
    if (visibility !== "active" && !await confirm({message:`${visibility === "deleted" ? "Delete" : "Archive"} "${detail.task.title}"?`,
      detail:"Stop only this task's owned work and cancel its delayed start. Original input and history remain recoverable."})) return {ok:true,cancelled:true};
    clearSchedule(id,task);
    const queued=configurationJobs.get(JSON.stringify([id,task]));
    if (queued) await queued.catch(()=>undefined);
    const saved=await runs({workspaceId:id});
    if (visibility !== "active") {
      for (const mission of saved.runs.filter(run=>run.project_id===task && (!runSettled(run)
        || run.nodes.some(node=>["running","reserved"].includes(node.state)
          || node.request_key && node.state !== "finished" && node.receipt?.status !== "completed")))) await stopOwned(id,mission);
    }
    const life=await resolveStoppedIntents(id,task,await runs({workspaceId:id}));
    return lifecycleMutation(id,visibility === "active"
      ? {operation:"restore_task",task_id:task,expected_revision:life.revision}
      : {operation:"set_visibility",task_id:task,expected_revision:life.revision,visibility});
  }
  function dispose() {
    schedulerDisposed = true;
    for (const timer of scheduleTimers.values()) clearTimer(timer);
    scheduleTimers.clear();
  }

  async function call(operation, args = {}) {
    switch (operation) {
      case "chat_send": return chatSend(args);
      case "codex_executable": return { ok: true, executable: findCodexExecutable() };
      case "inspect": return { ok: true, status: "graph_ready", source: "coding-tools-plan", plannerRoute: "webgpt-on-codex-required", execution: "not_connected" };
      case "board": return board(args);
      case "task_rename": return taskRename(args);
      case "models": return models(args);
      case "harnesses": return harnesses();
      case "runs": return runs(args);
      case "update_run": return updateRun(args);
      case "team_update": return teamUpdate(args);
      case "harness_status": return harnessStatus(args);
      case "permission_profiles": return permissionProfiles(args);
      case "activity": return activity(args);
      case "connect_harness": return connectAoHarness(args);
      case "stop_harness": return stopAoHarness(args);
      case "observe": return observe(args);
      case "advance": return advance(args);
      case "start_run": return startRun(args);
      case "restart_run": return restartRun(args);
      case "reconfigure_run": return reconfigureRun(args);
      case "schedule_start": return scheduleStart(args);
      case "cancel_schedule": return cancelSchedule(args);
      case "recover_schedule": return args.action === "cancel" ? cancelSchedule(args) : scheduleStart(args);
      case "archive_task": return visibilityAction(args, "archived");
      case "delete_task": return visibilityAction(args, "deleted");
      case "restore_task": return visibilityAction(args, "active");
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

  return Object.freeze({ call, restoreSchedules, dispose });
}

module.exports = { createAgentOrchestratorWorkflow, delayToMilliseconds, clausesFrom, resolveAoNativeConnection, findInstalledCodexExecutable, codexCliExecutable, aoWebCatalogForModel };
