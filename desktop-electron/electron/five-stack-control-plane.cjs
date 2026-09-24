"use strict";

const { randomUUID } = require("node:crypto");
const { FIVE_STACK_ENDPOINTS } = require("./five-stack-cross-use.cjs");
const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");
const { parsePlannerTasks, parseReviewerVerdict } = require("./orchestration-output.cjs");

const MAX_BRIEF = 8192;
const MAX_ROLE = 80;
const MAX_SUMMARY = 4096;
const MAX_FINDING_TITLE = 240;
const MAX_FINDING_DETAIL = 2048;
const MAX_SUBAGENTS = 8;
const MAX_FINDINGS = 32;
const MAX_RECORDS = 50;

const STACK_IDS = Object.freeze([
  "cpa",
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);
const MANAGE_ACTIONS = Object.freeze(["start", "stop", "restart", "repair"]);

const TOOL_NAMES = Object.freeze([
  "five_stack_api_map",
  "five_stack_status",
  "five_stack_inspect",
  "five_stack_manage",
  "paseo_plan",
  "paseo_run",
  "paseo_submit_result",
  "paseo_review",
  "anneal_open_from_review",
  "anneal_preview",
]);

const READ_ONLY_TOOLS = new Set([
  "five_stack_api_map",
  "five_stack_status",
  "five_stack_inspect",
  "anneal_preview",
]);

const SENSITIVE_KEY = /(?:^|_)(?:access_token|refresh_token|api_key|private_key|client_secret|password|secret|token|credential|bearer|authorization|caller_key|proxy_api_key|management_key)(?:_|$)/i;

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function boundedText(value, max, label) {
  const next = text(value);
  if (!next) throw new Error(`${label} is required`);
  if (next.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return next;
}

function optionalText(value, max, label) {
  const next = text(value);
  if (!next) return "";
  if (next.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return next;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-.\s]+/g, "_");
}

function sanitizePublic(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizePublic(entry));
  if (!value || typeof value !== "object") return value;
  const snapshot = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (SENSITIVE_KEY.test(normalized) && typeof entry !== "boolean") continue;
    snapshot[key] = sanitizePublic(entry);
  }
  return snapshot;
}

function requiredStackId(value) {
  const id = text(value);
  if (!STACK_IDS.includes(id)) throw new Error("Stack must be cpa, codex-router, commandcode-proxy, paseo or anneal");
  return id;
}

function requiredManageAction(value) {
  const action = text(value);
  if (!MANAGE_ACTIONS.includes(action)) {
    throw new Error("Manage action must be start, stop, restart or repair");
  }
  return action;
}

function nowIso(clock) {
  return typeof clock === "function" ? clock() : new Date().toISOString();
}

function boundedSet(map, key, value) {
  map.set(key, value);
  while (map.size > MAX_RECORDS) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function routeSummary(plan) {
  const routeId = plan.proxy?.mode === "profile" ? text(plan.proxy.profile?.id) : null;
  if (plan.proxy?.mode === "profile" && !routeId) throw new Error("Selected proxy route is unavailable");
  return Object.freeze({
    workload: plan.workload,
    providerId: plan.provider.id,
    providerName: plan.provider.name,
    protocol: plan.provider.protocol,
    accountId: plan.account.id,
    accountLabel: plan.account.label,
    model: plan.model,
    routeId,
    proxyMode: plan.proxy?.mode ?? "direct",
    fallbackUsed: plan.fallbackUsed === true,
  });
}

const CPA_BACKEND_PROVIDERS = Object.freeze([
  "cliproxyapi-antigravity",
  "gemini-oauth",
  "gemini-api",
  "gemini-reverse-proxy",
  "ai-studio-reverse-proxy",
  "aistudio-to-api",
]);
const ROUTER_BACKEND_PROVIDERS = Object.freeze([
  "codex-oauth",
  "openai-api",
  "chatgpt-web",
]);

function inAppBackends(endpoints) {
  return Object.freeze({
    web: endpoints.web.v1,
    cpa: endpoints.cpa.v1,
    router: endpoints["codex-router"].v1,
    commandcode: endpoints["commandcode-proxy"].v1,
    paseo: endpoints.paseo.ws,
    anneal: endpoints.anneal.api,
  });
}

function serviceRows(snapshot) {
  if (Array.isArray(snapshot?.services)) return snapshot.services;
  if (Array.isArray(snapshot)) return snapshot;
  return [];
}

function flagUp(row) {
  if (!row || typeof row !== "object") return null;
  if (row.status === "ready" || row.running === true) return true;
  if (row.status === "error" || row.status === "stopped" || row.running === false) return false;
  return null;
}

function stackAvailability(snapshot) {
  const rows = serviceRows(snapshot);
  const byId = new Map(rows.map((row) => [text(row?.id), row]));
  return Object.freeze({
    cpa: flagUp(byId.get("cpa")),
    router: flagUp(byId.get("codex-router")),
    commandcode: flagUp(byId.get("commandcode-proxy")),
    anneal: flagUp(byId.get("anneal")),
    paseo: flagUp(byId.get("paseo")),
  });
}

function preferredKind(providerId) {
  if (providerId === "chatgpt-web") return "web";
  if (providerId === "commandcode-proxy") return "commandcode";
  if (CPA_BACKEND_PROVIDERS.includes(providerId)) return "cpa";
  if (ROUTER_BACKEND_PROVIDERS.includes(providerId)) return "router";
  return "cpa";
}

function selectInAppBackend(providerId, backends, availability = {}) {
  const preferred = preferredKind(providerId);
  const order = preferred === "web"
    ? ["web"]
    : preferred === "commandcode"
    ? ["commandcode"]
    : preferred === "router"
      ? ["router", "cpa", "commandcode"]
      : ["cpa", "router", "commandcode"];
  for (const kind of order) {
    if (availability[kind] === false) continue;
    return Object.freeze({
      url: backends[kind],
      kind,
      fallback: kind !== preferred,
      available: availability[kind] !== false,
    });
  }
  return Object.freeze({
    url: backends.commandcode,
    kind: "commandcode",
    fallback: preferred !== "commandcode",
    available: false,
  });
}

function preferredBackend(providerId, backends, availability = {}) {
  return selectInAppBackend(providerId, backends, availability).url;
}

function safeProjectId(value, fallback) {
  const raw = text(value) || text(fallback) || "coding-tools";
  return raw.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 80) || "coding-tools";
}

function annealHandoffBody({ title, description, cwd = "." } = {}) {
  return Object.freeze({
    name: boundedText(title, MAX_FINDING_TITLE, "task name"),
    description: optionalText(description, MAX_SUMMARY, "task description") || boundedText(title, MAX_FINDING_TITLE, "task name"),
    status: "BACKLOG",
    workingDirectory: text(cwd) || ".",
    assigneeType: "AGENT",
    approvalGate: true,
    opensPullRequest: false,
    scheduleKind: "NOW",
    chainIndex: 0,
  });
}

function apiMap(endpoints) {
  const backends = inAppBackends(endpoints);
  return Object.freeze({
    control_plane: "coding-tools-five-stack",
    loop: "paseo_plan → paseo_run → paseo_submit_result → paseo_review → anneal_open_from_review → anneal_preview",
    stacks: Object.freeze({
      cpa: Object.freeze({
        id: "cpa",
        manage: Object.freeze(["five_stack_manage", "launcher.startExternalService"]),
        monitor: Object.freeze(["five_stack_status", "five_stack_inspect", "launcher.inspectExternalService"]),
        openai: backends.cpa,
        origin: endpoints.cpa.origin,
        bundleOwner: "pr-194",
      }),
      "codex-router": Object.freeze({
        id: "codex-router",
        manage: Object.freeze(["five_stack_manage", "launcher.syncCodexRouter", "launcher.startExternalService"]),
        monitor: Object.freeze(["five_stack_status", "five_stack_inspect", "launcher.inspectExternalService"]),
        openai: backends.router,
        origin: endpoints["codex-router"].origin,
        bundleOwner: "pr-194",
      }),
      "commandcode-proxy": Object.freeze({
        id: "commandcode-proxy",
        manage: Object.freeze(["five_stack_manage", "launcher.startExternalService"]),
        monitor: Object.freeze(["five_stack_status", "five_stack_inspect", "launcher.inspectExternalService"]),
        openai: backends.commandcode,
        origin: endpoints["commandcode-proxy"].origin,
      }),
      paseo: Object.freeze({
        id: "paseo",
        manage: Object.freeze(["five_stack_manage", "paseo_plan", "paseo_run", "execution.update"]),
        monitor: Object.freeze(["five_stack_status", "five_stack_inspect", "paseo_review", "execution.read"]),
        origin: endpoints.paseo.origin,
        execution: endpoints.paseo.ws,
      }),
      anneal: Object.freeze({
        id: "anneal",
        manage: Object.freeze(["five_stack_manage", "anneal_open_from_review", "execution.update"]),
        monitor: Object.freeze(["five_stack_status", "five_stack_inspect", "anneal_preview", "tasks.list"]),
        web: endpoints.anneal.web,
        api: endpoints.anneal.api,
      }),
    }),
    compose: Object.freeze({
      cpaRouterBundle: "pr-194",
      commandcodeLongrun: "pr-193",
    }),
    mcp: Object.freeze({
      tools: TOOL_NAMES.slice(),
      resources: Object.freeze([
        Object.freeze({
          uri: "coding-tools://five-stack/api-map",
          name: "Five-stack API map",
          mimeType: "application/json",
        }),
        Object.freeze({
          uri: "coding-tools://five-stack/status",
          name: "Five-stack status",
          mimeType: "application/json",
        }),
      ]),
    }),
  });
}

function mcpTools() {
  return Object.freeze([
    Object.freeze({
      name: "five_stack_api_map",
      description: "Return the per-stack manage/monitor API map used by Desktop and MCP.",
      readOnly: true,
    }),
    Object.freeze({
      name: "five_stack_status",
      description: "Monitor in-app five-stack endpoints, managed runtimes, and Paseo/Anneal records.",
      readOnly: true,
    }),
    Object.freeze({
      name: "five_stack_inspect",
      description: "Inspect one five-stack runtime using the same launcher inspect API as the Desktop panel.",
      readOnly: true,
    }),
    Object.freeze({
      name: "five_stack_manage",
      description: "Start, stop, restart, or repair one five-stack runtime. Same controller as the Desktop panel; does not download.",
      readOnly: false,
    }),
    Object.freeze({
      name: "paseo_plan",
      description: "Configure the Paseo orchestrator provider and assign subagent providers.",
      readOnly: false,
    }),
    Object.freeze({
      name: "paseo_run",
      description: "Dispatch the orchestrator message onto each assigned subagent route.",
      readOnly: false,
    }),
    Object.freeze({
      name: "paseo_submit_result",
      description: "Return a subagent result or issue to the Paseo orchestrator for review.",
      readOnly: false,
    }),
    Object.freeze({
      name: "paseo_review",
      description: "Read the orchestrator review of subagent results.",
      readOnly: false,
    }),
    Object.freeze({
      name: "anneal_open_from_review",
      description: "Open a new Anneal task from Paseo review findings, with assignment preview.",
      readOnly: false,
    }),
    Object.freeze({
      name: "anneal_preview",
      description: "Preview an Anneal task and its orchestrator→subagent assignment structure.",
      readOnly: true,
    }),
  ]);
}

function mcpResources() {
  return apiMap(FIVE_STACK_ENDPOINTS).mcp.resources;
}

function mergeCatalog(headless = {}) {
  const tools = [];
  const seen = new Set();
  for (const tool of mcpTools()) {
    seen.add(tool.name);
    tools.push(tool);
  }
  for (const tool of asList(headless.tools)) {
    const name = typeof tool === "string" ? tool : text(asRecord(tool).name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tools.push(tool);
  }
  return {
    tools,
    resources: [
      ...mcpResources(),
      ...asList(headless.resources).filter((resource) => {
        const uri = typeof resource === "string" ? resource : text(asRecord(resource).uri);
        return Boolean(uri) && !uri.startsWith("coding-tools://five-stack/");
      }),
    ],
    control_plane: "coding-tools-five-stack",
    headlessUnavailable: headless.unavailable === true,
  };
}

function createFiveStackControlPlane({
  clock,
  idFactory,
  planProvider = createProviderExecutionPlan,
  getProviderSnapshot,
  getServicesSnapshot,
  getWebBridgeStatus,
  readWorkflow,
  readExecution,
  updateTask,
  reserveOrchestration,
  updateOrchestrationStatus,
  registerPaseoProviders,
  missionAdapter,
  inspectService,
  manageService,
  handoffAnnealTask = null,
  fetchAnnealTask = null,
  endpoints = FIVE_STACK_ENDPOINTS,
} = {}) {
  const plans = new Map();
  const runs = new Map();
  const reviews = new Map();
  const tasks = new Map();
  const backends = inAppBackends(endpoints);

  const nextId = (prefix) => {
    const raw = typeof idFactory === "function" ? idFactory() : randomUUID();
    return `${prefix}-${String(raw).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || randomUUID().slice(0, 8)}`;
  };

  async function snapshotForPlan() {
    if (typeof getProviderSnapshot !== "function") {
      throw new Error("Provider network snapshot is required");
    }
    return getProviderSnapshot();
  }

  async function readAvailability() {
    let web = false;
    try { web = typeof getWebBridgeStatus === "function" && await getWebBridgeStatus() === true; }
    catch {}
    if (typeof getServicesSnapshot !== "function") {
      return { web, cpa: null, router: null, commandcode: null, anneal: null, paseo: null };
    }
    try {
      return { ...stackAvailability(await getServicesSnapshot()), web };
    } catch {
      return { web, cpa: null, router: null, commandcode: null, anneal: null, paseo: null };
    }
  }

  function attachBackend(providerId, availability) {
    const selected = selectInAppBackend(providerId, backends, availability);
    if (selected.fallback || availability[selected.kind] !== true) {
      throw new Error(`No ready backend for selected provider ${providerId}`);
    }
    return Object.freeze({
      backend: selected.url,
      backendKind: selected.kind,
      backendFallback: selected.fallback === true,
      backendAvailable: selected.available === true,
    });
  }

  function resolveRole(input, index, fallback) {
    return optionalText(asRecord(input).role, MAX_ROLE, `subagent ${index + 1} role`) || fallback;
  }

  function exactBinding(view, route, workspaceId) {
    const execution = asRecord(view.execution || view);
    const matches = asList(execution.bindings).filter((binding) => (
      binding.workspace_id === workspaceId && binding.engine === "paseo"
      && binding.provider === route.providerId && binding.account_id === route.accountId
      && binding.model === route.model && (binding.route_id ?? null) === route.routeId
      && binding.enabled === true && binding.connected === true
      && binding.current_scope_valid === true && text(binding.generation)
    ));
    if (matches.length !== 1) throw new Error(`Select one connected Paseo binding for ${route.providerId}/${route.model}`);
    return { bindingId: matches[0].id, bindingGeneration: matches[0].generation };
  }

  function storedRoute(view, workspaceId, bindingId, generation, providerId, model) {
    const execution = asRecord(view.execution || view);
    const binding = asList(execution.bindings).find((item) => item.id === bindingId && item.workspace_id === workspaceId);
    if (!binding || binding.generation !== generation || binding.engine !== "paseo"
      || binding.provider !== providerId || binding.model !== model
      || !text(binding.account_id) || binding.enabled !== true || binding.connected !== true
      || binding.current_scope_valid !== true) {
      throw new Error("Approved Paseo binding changed or disconnected");
    }
    return { providerId, accountId: binding.account_id, model, routeId: binding.route_id ?? null };
  }

  async function plan(input = {}, workspaceId = "") {
    const brief = boundedText(input.brief, MAX_BRIEF, "brief");
    const orchestratorInput = asRecord(input.orchestrator);
    if (![orchestratorInput.providerId, orchestratorInput.accountId, orchestratorInput.model].every((value) => text(value))) {
      throw new Error("Select an exact orchestrator provider, account and model");
    }
    if (text(orchestratorInput.providerId) !== "chatgpt-web" || text(orchestratorInput.model) !== "chatgpt-web/high") {
      throw new Error("Web GPT orchestrator requires chatgpt-web/high");
    }
    const requested = asList(input.subagents).slice(0, MAX_SUBAGENTS);
    if (requested.length === 0) throw new Error("Assign at least one subagent");
    for (const entry of requested) {
      const row = asRecord(entry);
      if (![row.providerId, row.accountId, row.model].every((value) => text(value))) {
        throw new Error("Select an exact subagent provider, account and model");
      }
      if (text(row.providerId) !== "cliproxyapi-antigravity" || text(row.model) !== "gemini-3.8-flash-high") {
        throw new Error("Gemini worker requires gemini-3.8-flash-high through CPA");
      }
    }
    const snapshot = await snapshotForPlan();
    const availability = await readAvailability();
    const orchestratorPlan = planProvider(snapshot, {
      workload: "paseo",
      providerId: text(orchestratorInput.providerId) || undefined,
      accountId: text(orchestratorInput.accountId) || undefined,
      model: text(orchestratorInput.model) || undefined,
      allowFallback: false,
    });
    const subagents = requested.map((entry, index) => {
      const row = asRecord(entry);
      const route = planProvider(snapshot, {
        workload: "subagent",
        providerId: text(row.providerId) || undefined,
        accountId: text(row.accountId) || undefined,
        model: text(row.model) || undefined,
        allowFallback: false,
      });
      const summarized = routeSummary(route);
      const selected = attachBackend(summarized.providerId, availability);
      return Object.freeze({
        id: nextId("sub"),
        role: resolveRole(row, index, `subagent-${index + 1}`),
        route: summarized,
        ...selected,
      });
    });
    const durableCallbacks = [readWorkflow, readExecution, reserveOrchestration,
      registerPaseoProviders, missionAdapter?.ensureStarted];
    const durable = durableCallbacks.every((callback) => typeof callback === "function");
    if (!durable && durableCallbacks.some((callback) => typeof callback === "function")) {
      throw new Error("Paseo orchestration service is incomplete");
    }
    const runId = text(input.runId);
    const taskId = text(input.taskId);
    if (durable && (!/^[A-Za-z0-9_-]{1,80}$/.test(runId) || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId))) {
      throw new Error("Select a stable Orchestrator run ID and existing task ID");
    }
    const record = Object.freeze({
      id: durable ? runId : nextId("plan"),
      workspaceId: text(workspaceId),
      brief,
      createdAt: nowIso(clock),
      orchestrator: Object.freeze({
        role: "orchestrator",
        route: routeSummary(orchestratorPlan),
        ...attachBackend(orchestratorPlan.provider.id, availability),
      }),
      subagents,
      backends,
      status: "planned",
    });
    if (durable) {
      const view = await readExecution({ workspaceId, missionId: null, refreshSource: false });
      const plannerBinding = exactBinding(view, record.orchestrator.route, workspaceId);
      const workerBindings = subagents.map((worker) => exactBinding(view, worker.route, workspaceId));
      const board = await readWorkflow({ workspaceId, taskId });
      const task = asList(board.tasks).find((item) => item.id === taskId);
      if (!task || !Number.isInteger(board.revision)) throw new Error("Select an existing task in this workspace");
      const roles = subagents.map((worker, index) => ({ id: `worker-${index + 1}`, label: worker.role }));
      if (new Set(roles.map((role) => role.label)).size !== roles.length) {
        throw new Error("Choose a unique role for every Gemini worker");
      }
      const plannerPrompt = boundedText(
        `Plan the following task for the selected worker roles ${JSON.stringify(roles)}. Return only JSON with exactly this shape: {"tasks":[{"role":"worker-1","brief":"bounded task instructions"}]}, with one task for each listed role id. Do not choose providers, accounts, workspaces, permissions, or tools.\nTask: ${boundedText(task.title, 240, "task title")}\n${text(task.description)}`,
        MAX_BRIEF,
        "planner prompt",
      );
      await registerPaseoProviders();
      const stored = await reserveOrchestration({
        workspaceId, id: runId, taskId, expectedBoardRevision: board.revision, plannerPrompt,
        planner: { ...plannerBinding, missionId: `${runId}-planner`, requestKey: `${runId}-planner-start` },
        workers: subagents.map((worker, index) => ({
          ...workerBindings[index], missionId: `${runId}-worker-${index + 1}`,
          requestKey: `${runId}-worker-${index + 1}-start`,
        })),
        reviewer: { ...plannerBinding, missionId: `${runId}-reviewer`, requestKey: `${runId}-reviewer-start` },
      });
      const workersMatch = asList(stored?.worker_binding_ids).length === subagents.length
        && subagents.every((_, index) => (
          stored.worker_binding_ids[index] === workerBindings[index].bindingId
          && stored.worker_binding_generations?.[index] === workerBindings[index].bindingGeneration
          && stored.worker_mission_ids?.[index] === `${runId}-worker-${index + 1}`
          && stored.worker_request_keys?.[index] === `${runId}-worker-${index + 1}-start`
          && text(stored.worker_task_ids?.[index])
        ));
      if (stored?.id !== runId || stored?.workspace_id !== workspaceId || stored?.task_id !== taskId
        || !text(stored.planner_task_id) || stored.planner_binding_id !== plannerBinding.bindingId
        || stored.planner_binding_generation !== plannerBinding.bindingGeneration
        || stored.planner_mission_id !== `${runId}-planner` || stored.planner_request_key !== `${runId}-planner-start`
        || stored.reviewer_binding_id !== plannerBinding.bindingId
        || stored.reviewer_binding_generation !== plannerBinding.bindingGeneration
        || stored.reviewer_mission_id !== `${runId}-reviewer` || stored.reviewer_request_key !== `${runId}-reviewer-start`
        || !text(stored.reviewer_task_id) || !workersMatch) {
        throw new Error("Durable Paseo reservation does not match the selected run and route");
      }
      const planner = await missionAdapter.ensureStarted({
        workspaceId, taskId: stored.planner_task_id, missionId: stored.planner_mission_id,
        bindingId: stored.planner_binding_id, bindingGeneration: stored.planner_binding_generation,
        route: record.orchestrator.route, createKey: `${stored.planner_mission_id}-create`,
        startKey: stored.planner_request_key,
      });
      const active = Object.freeze({ ...record, status: "planning", planner });
      boundedSet(plans, active.id, active);
      return active;
    }
    boundedSet(plans, record.id, record);
    return record;
  }

  function requirePlan(planId) {
    const record = plans.get(text(planId));
    if (!record) throw new Error("Paseo plan was not found");
    return record;
  }

  function requireRun(runId) {
    const record = runs.get(text(runId));
    if (!record) throw new Error("Paseo run was not found");
    return record;
  }

  function requireReview(reviewId) {
    const record = reviews.get(text(reviewId));
    if (!record) throw new Error("Paseo review was not found");
    return record;
  }

  function requireTask(taskId) {
    const record = tasks.get(text(taskId));
    if (!record) throw new Error("Anneal task was not found");
    return record;
  }

  async function advanceOrchestration(stored, status) {
    if (typeof updateOrchestrationStatus !== "function") return stored;
    const phases = ["planning", "executing", "ready_for_review", "reviewing"];
    const terminal = ["passed", "needs_changes"];
    let current = stored;
    if (current.status === status) return current;
    if (terminal.includes(current.status)) throw new Error("Finished orchestration cannot change status");
    let steps;
    if (status === "held" || status === "uncertain") {
      steps = [status];
    } else if (terminal.includes(status)) {
      steps = current.status === "held" || current.status === "uncertain"
        ? ["reviewing", status]
        : [...phases.slice(Math.max(0, phases.indexOf(current.status) + 1)), status];
    } else if (current.status === "held" || current.status === "uncertain") {
      steps = [status];
    } else {
      const from = phases.indexOf(current.status);
      const to = phases.indexOf(status);
      if (from < 0 || to < 0) throw new Error("Durable orchestration status is invalid");
      steps = phases.slice(from + 1, to + 1);
    }
    for (const next of steps) {
      if (current.status === next) continue;
      current = await updateOrchestrationStatus({ workspaceId: current.workspace_id,
        id: current.id, expectedRevision: current.revision, status: next });
      if (current?.id !== stored.id || current?.status !== next || !Number.isInteger(current.revision)) {
        throw new Error("Durable orchestration status update did not match the run");
      }
    }
    return current;
  }

  async function run(input = {}, workspaceId = "") {
    if (typeof readExecution !== "function" || typeof readWorkflow !== "function"
      || typeof updateTask !== "function" || typeof missionAdapter?.ownedReply !== "function"
      || typeof missionAdapter?.ensureStarted !== "function") {
      const selected = requirePlan(input.planId);
      if (workspaceId && selected.workspaceId && selected.workspaceId !== workspaceId) {
        throw new Error("Plan does not belong to this workspace");
      }
      throw new Error("Paseo execution service is unavailable; no subagent was dispatched");
    }
    const view = await readExecution({ workspaceId, missionId: null, refreshSource: false });
    const execution = asRecord(view.execution || view);
    const stored = asList(execution.orchestrations).find((item) => item.id === text(input.planId));
    if (!stored || stored.workspace_id !== workspaceId) throw new Error("Paseo run was not found in this workspace");
    storedRoute(view, workspaceId, stored.planner_binding_id, stored.planner_binding_generation,
      "chatgpt-web", "chatgpt-web/high");
    const planner = await missionAdapter.ownedReply({
      workspaceId, missionId: stored.planner_mission_id,
      bindingGeneration: stored.planner_binding_generation, startKey: stored.planner_request_key,
    });
    if (!planner) throw new Error("Planner output is not ready");
    const workerIds = asList(stored.worker_mission_ids);
    if (!workerIds.length || workerIds.length > MAX_SUBAGENTS
      || asList(stored.worker_task_ids).length !== workerIds.length
      || asList(stored.worker_binding_ids).length !== workerIds.length
      || asList(stored.worker_binding_generations).length !== workerIds.length
      || asList(stored.worker_request_keys).length !== workerIds.length) {
      throw new Error("Durable Gemini worker assignments are incomplete");
    }
    const roles = workerIds.map((_, index) => `worker-${index + 1}`);
    const proposed = new Map(parsePlannerTasks(planner.text, roles).tasks.map((task) => [task.role, task.brief]));
    let progress = await advanceOrchestration(stored, "executing");
    for (const [index, taskId] of stored.worker_task_ids.entries()) {
      const board = await readWorkflow({ workspaceId, taskId });
      const task = asList(board.tasks).find((item) => item.id === taskId);
      if (!task || !Number.isInteger(board.revision)) throw new Error("Reserved Gemini task was not found");
      const brief = proposed.get(roles[index]);
      if (task.description === brief) continue;
      if (text(task.description)) throw new Error("Reserved Gemini task was edited; review it before dispatch");
      await updateTask({ workspaceId, taskId, title: task.title,
        description: brief, expectedRevision: board.revision });
    }
    const completedWorkers = [];
    for (const [index, missionId] of workerIds.entries()) {
      const route = storedRoute(view, workspaceId, stored.worker_binding_ids[index],
        stored.worker_binding_generations[index], "cliproxyapi-antigravity", "gemini-3.8-flash-high");
      const reply = await missionAdapter.ownedReply({ workspaceId, missionId,
        bindingGeneration: stored.worker_binding_generations[index], startKey: stored.worker_request_keys[index] });
      if (reply) {
        completedWorkers.push({ missionId, ...reply });
        continue;
      }
      const active = await missionAdapter.ensureStarted({
        workspaceId, taskId: stored.worker_task_ids[index], missionId,
        bindingId: stored.worker_binding_ids[index], bindingGeneration: stored.worker_binding_generations[index],
        route, createKey: `${missionId}-create`, startKey: stored.worker_request_keys[index],
      });
      if (active.phase === "failed" || active.phase === "closed") {
        throw new Error(`Gemini worker failed without an owned result: ${missionId}`);
      }
      const status = active.phase === "unknown" ? "uncertain"
        : ["held", "scheduling_held", "hold_requested", "changes_requested"].includes(active.phase)
          ? "held" : "executing";
      progress = await advanceOrchestration(progress, status);
      return { id: stored.id, planId: stored.id, status,
        activeWorker: { missionId, phase: active.phase }, completedWorkers };
    }
    await advanceOrchestration(progress, "ready_for_review");
    return { id: stored.id, planId: stored.id, status: "ready_for_review", completedWorkers };
  }

  function submitResult(input = {}) {
    const selected = requireRun(input.runId);
    const assignmentId = text(input.assignmentId);
    const assignment = selected.assignments.find((item) => item.id === assignmentId);
    if (!assignment) throw new Error("Subagent assignment was not found");
    const issues = asList(input.issues).slice(0, MAX_FINDINGS).map((entry, index) => {
      const row = asRecord(entry);
      return Object.freeze({
        id: nextId("find"),
        title: boundedText(row.title || `issue-${index + 1}`, MAX_FINDING_TITLE, "finding title"),
        detail: optionalText(row.detail, MAX_FINDING_DETAIL, "finding detail"),
      });
    });
    const nextAssignment = Object.freeze({
      ...assignment,
      status: issues.length ? "issues_found" : "returned",
      summary: optionalText(input.summary, MAX_SUMMARY, "summary")
        || (issues.length ? "Issues returned for orchestrator review." : "Subagent returned without issues."),
      ok: input.ok !== false && issues.length === 0,
      issues: Object.freeze(issues),
    });
    const assignments = selected.assignments.map((item) => (
      item.id === assignmentId ? nextAssignment : item
    ));
    const remaining = assignments.some((item) => item.status === "dispatched");
    const hasIssues = assignments.some((item) => item.issues.length > 0 || item.status === "issues_found");
    const next = Object.freeze({
      ...selected,
      assignments: Object.freeze(assignments),
      status: remaining ? "awaiting_results" : hasIssues ? "issues_found" : "returned",
    });
    runs.set(next.id, next);
    return next;
  }

  async function review(input = {}, workspaceId = "") {
    if (typeof readExecution === "function" && typeof readWorkflow === "function"
      && typeof updateTask === "function" && typeof missionAdapter?.ownedReply === "function"
      && typeof missionAdapter?.ensureStarted === "function") {
      const view = await readExecution({ workspaceId, missionId: null, refreshSource: false });
      const execution = asRecord(view.execution || view);
      const stored = asList(execution.orchestrations).find((item) => item.id === text(input.runId));
      if (!stored || stored.workspace_id !== workspaceId) throw new Error("Paseo run was not found in this workspace");
      const workerIds = asList(stored.worker_mission_ids);
      if (!workerIds.length || workerIds.length > MAX_SUBAGENTS
        || asList(stored.worker_binding_ids).length !== workerIds.length
        || asList(stored.worker_binding_generations).length !== workerIds.length
        || asList(stored.worker_request_keys).length !== workerIds.length) {
        throw new Error("Durable Gemini worker assignments are incomplete");
      }
      const completedWorkers = [];
      for (const [index, missionId] of workerIds.entries()) {
        storedRoute(view, workspaceId, stored.worker_binding_ids[index],
          stored.worker_binding_generations[index], "cliproxyapi-antigravity", "gemini-3.8-flash-high");
        const reply = await missionAdapter.ownedReply({ workspaceId, missionId,
          bindingGeneration: stored.worker_binding_generations[index], startKey: stored.worker_request_keys[index] });
        if (!reply) throw new Error("Current child output is required before review");
        completedWorkers.push({ missionId, ...reply });
      }
      storedRoute(view, workspaceId, stored.planner_binding_id, stored.planner_binding_generation,
        "chatgpt-web", "chatgpt-web/high");
      const planner = await missionAdapter.ownedReply({ workspaceId, missionId: stored.planner_mission_id,
        bindingGeneration: stored.planner_binding_generation, startKey: stored.planner_request_key });
      if (!planner) throw new Error("Current planner output is required before review");
      const reviewerRoute = storedRoute(view, workspaceId, stored.reviewer_binding_id,
        stored.reviewer_binding_generation, "chatgpt-web", "chatgpt-web/high");
      const parentBoard = await readWorkflow({ workspaceId, taskId: stored.task_id });
      const parent = asList(parentBoard.tasks).find((item) => item.id === stored.task_id);
      if (!parent) throw new Error("Parent task was not found for review");
      const reviewInstructions = 'Review the Gemini worker outputs. Return only JSON such as {"verdict":"pass","findings":[]}. If changes are needed, use verdict "needs_changes" with nonempty findings containing title and detail. Do not pass if any output is truncated or task description is incomplete.\n';
      const description = text(parent.description);
      let maxWorkerChars = Math.max(...completedWorkers.map((worker) => worker.text.length));
      let reviewPrompt;
      for (;;) {
        reviewPrompt = reviewInstructions + JSON.stringify({
          task: { title: parent.title, description: description.slice(0, 512),
            descriptionTruncated: description.length > 512 },
          workers: completedWorkers.map((worker) => ({
            missionId: worker.missionId, agentId: worker.agentId, turnId: worker.turnId,
            text: worker.text.slice(0, maxWorkerChars), truncated: worker.text.length > maxWorkerChars,
          })),
        });
        if (reviewPrompt.length <= MAX_BRIEF) break;
        if (maxWorkerChars === 0) throw new Error("Review evidence metadata exceeds task limit");
        maxWorkerChars = Math.max(0, maxWorkerChars - Math.ceil((reviewPrompt.length - MAX_BRIEF) / completedWorkers.length));
      }
      const reviewBoard = await readWorkflow({ workspaceId, taskId: stored.reviewer_task_id });
      const reviewTask = asList(reviewBoard.tasks).find((item) => item.id === stored.reviewer_task_id);
      if (!reviewTask || !Number.isInteger(reviewBoard.revision)) throw new Error("Reserved reviewer task was not found");
      const reviewer = await missionAdapter.ownedReply({ workspaceId, missionId: stored.reviewer_mission_id,
        bindingGeneration: stored.reviewer_binding_generation, startKey: stored.reviewer_request_key });
      if (reviewer) {
        if (reviewTask.description !== reviewPrompt) {
          throw new Error("Review evidence changed after the reviewer started");
        }
        if (planner.agentId === reviewer.agentId || planner.turnId === reviewer.turnId
          || completedWorkers.some((worker) => worker.agentId === reviewer.agentId || worker.turnId === reviewer.turnId)) {
          throw new Error("Review requires a distinct Web GPT reviewer turn");
        }
        const verdict = parseReviewerVerdict(reviewer.text);
        if (verdict.verdict === "pass"
          && (description.length > 512 || completedWorkers.some((worker) => worker.text.length > maxWorkerChars))) {
          throw new Error("Web GPT cannot pass a review with truncated evidence");
        }
        await advanceOrchestration(stored,
          verdict.verdict === "pass" ? "passed" : "needs_changes");
        const result = Object.freeze({
          id: `${stored.id}-review`, runId: stored.id, planId: stored.id, workspaceId,
          status: verdict.verdict === "pass" ? "passed" : "needs_changes",
          liveModelCompletion: true,
          findings: verdict.findings.map((finding, index) => ({ id: `${stored.id}-finding-${index + 1}`, ...finding })),
          reviewer: { missionId: stored.reviewer_mission_id, ...reviewer },
          workers: completedWorkers,
          orchestrator: { route: reviewerRoute },
          assignments: completedWorkers.map((worker, index) => ({
            id: worker.missionId, role: `worker-${index + 1}`,
            route: storedRoute(view, workspaceId, stored.worker_binding_ids[index],
              stored.worker_binding_generations[index], "cliproxyapi-antigravity", "gemini-3.8-flash-high"),
          })),
        });
        boundedSet(reviews, result.id, result);
        return result;
      }
      if (reviewTask.description !== reviewPrompt) {
        if (text(reviewTask.description)) throw new Error("Reserved reviewer task was edited; review it before dispatch");
        await updateTask({ workspaceId, taskId: stored.reviewer_task_id, title: reviewTask.title,
          description: reviewPrompt, expectedRevision: reviewBoard.revision });
      }
      let progress = await advanceOrchestration(stored, "reviewing");
      const active = await missionAdapter.ensureStarted({ workspaceId, taskId: stored.reviewer_task_id,
        missionId: stored.reviewer_mission_id, bindingId: stored.reviewer_binding_id,
        bindingGeneration: stored.reviewer_binding_generation, route: reviewerRoute,
        createKey: `${stored.reviewer_mission_id}-create`, startKey: stored.reviewer_request_key });
      if (active.phase === "failed" || active.phase === "closed") {
        throw new Error("Web GPT reviewer failed without an owned result");
      }
      const status = active.phase === "unknown" ? "uncertain"
        : ["held", "scheduling_held", "hold_requested", "changes_requested"].includes(active.phase)
          ? "held" : "reviewing";
      progress = await advanceOrchestration(progress, status);
      return { id: `${stored.id}-review`, runId: stored.id, status,
        liveModelCompletion: false, reviewer: { missionId: stored.reviewer_mission_id, phase: active.phase },
        workers: completedWorkers };
    }
    const selected = requireRun(input.runId);
    const findings = selected.assignments.flatMap((assignment) => (
      assignment.issues.map((issue) => Object.freeze({
        ...issue,
        assignmentId: assignment.id,
        role: assignment.role,
      }))
    ));
    const record = Object.freeze({
      id: nextId("review"),
      runId: selected.id,
      planId: selected.planId,
      workspaceId: selected.workspaceId,
      createdAt: nowIso(clock),
      orchestrator: selected.orchestrator,
      assignments: selected.assignments,
      findings,
      status: findings.length ? "issues_found" : selected.status,
      liveModelCompletion: selected.liveModelCompletion === true,
    });
    boundedSet(reviews, record.id, record);
    return record;
  }

  async function openAnnealFromReview(input = {}, workspaceId = "") {
    const selected = requireReview(input.reviewId);
    if (workspaceId && selected.workspaceId !== workspaceId) {
      throw new Error("Review does not belong to this workspace");
    }
    if (!selected.findings.length) {
      throw new Error("Anneal tasks open from review findings; this review has none");
    }
    const wanted = new Set(asList(input.findingIds).map((value) => text(value)).filter(Boolean));
    const findings = wanted.size
      ? selected.findings.filter((item) => wanted.has(item.id))
      : selected.findings;
    if (!findings.length) throw new Error("No matching review findings");
    const planRecord = plans.get(selected.planId);
    const title = optionalText(input.title, MAX_FINDING_TITLE, "title")
      || findings[0].title;
    const description = findings.map((item) => item.detail || item.title).join("\n").slice(0, MAX_SUMMARY);
    const localId = nextId("anneal");
    const projectId = safeProjectId(input.projectId, selected.workspaceId || workspaceId);
    const body = annealHandoffBody({
      title,
      description,
      cwd: text(input.cwd) || ".",
    });
    const availability = await readAvailability();
    if (availability.anneal !== true || typeof handoffAnnealTask !== "function") {
      throw new Error("Anneal is not ready for a review handoff");
    }
    let remote;
    try {
      remote = await handoffAnnealTask({ projectId, path: `/projects/${projectId}/tasks`, body });
    } catch {
      throw new Error("Anneal task handoff failed");
    }
    const remoteId = text(asRecord(remote).id) || text(asRecord(remote).taskId);
    if (!remoteId) throw new Error("Anneal did not return a task ID");
    const record = Object.freeze({
      id: remoteId,
      localId,
      workspaceId: selected.workspaceId || text(workspaceId),
      projectId,
      title,
      description,
      state: "BACKLOG",
      approvalGate: true,
      opensPullRequest: false,
      previewPath: `/tasks/${remoteId}`,
      boardPath: "/tasks",
      handoff: Object.freeze({
        attempted: true,
        posted: true,
        remoteId,
        error: null,
      }),
      source: Object.freeze({
        kind: "paseo_review",
        reviewId: selected.id,
        runId: selected.runId,
        planId: selected.planId,
      }),
      assignment: Object.freeze({
        orchestrator: selected.orchestrator,
        subagents: (planRecord?.subagents ?? selected.assignments).map((item) => Object.freeze({
          id: item.id,
          role: item.role,
          route: item.route,
          backend: item.backend,
          backendKind: item.backendKind || null,
        })),
      }),
      findings,
      createdAt: nowIso(clock),
    });
    boundedSet(tasks, record.id, record);
    return record;
  }

  async function previewAnneal(input = {}, workspaceId = "") {
    const selected = requireTask(input.taskId);
    if (workspaceId && selected.workspaceId && selected.workspaceId !== workspaceId) {
      throw new Error("Anneal task does not belong to this workspace");
    }
    if (selected.handoff?.posted === true && typeof fetchAnnealTask === "function") {
      try {
        const remote = await fetchAnnealTask({
          taskId: selected.id,
          path: selected.previewPath,
        });
        return Object.freeze({
          ...selected,
          remote: sanitizePublic(remote),
        });
      } catch {
        return selected;
      }
    }
    return selected;
  }

  async function status(workspaceId = "") {
    const matchWorkspace = (record) => (
      !workspaceId || !record.workspaceId || record.workspaceId === workspaceId
    );
    const payload = {
      endpoints: backends,
      plans: [...plans.values()].filter(matchWorkspace).map((item) => ({
        id: item.id,
        status: item.status,
        brief: item.brief,
        orchestrator: item.orchestrator.route.providerId,
        subagents: item.subagents.length,
      })),
      runs: [...runs.values()].filter(matchWorkspace).map((item) => ({
        id: item.id,
        planId: item.planId,
        status: item.status,
        assignments: item.assignments.length,
      })),
      reviews: [...reviews.values()].filter(matchWorkspace).map((item) => ({
        id: item.id,
        runId: item.runId,
        status: item.status,
        findings: item.findings.length,
      })),
      annealTasks: [...tasks.values()].filter(matchWorkspace),
    };
    if (typeof getServicesSnapshot !== "function") return payload;
    try {
      payload.services = sanitizePublic(await getServicesSnapshot());
    } catch {
      payload.servicesUnavailable = true;
    }
    return payload;
  }

  async function inspectStack(input = {}) {
    if (typeof inspectService !== "function") {
      throw new Error("Five-stack inspect controller is unavailable");
    }
    const stack = requiredStackId(input.stack);
    return sanitizePublic(await inspectService(stack));
  }

  async function manageStack(input = {}) {
    if (typeof manageService !== "function") {
      throw new Error("Five-stack manage controller is unavailable");
    }
    const stack = requiredStackId(input.stack);
    const action = requiredManageAction(input.action);
    return sanitizePublic(await manageService(stack, action));
  }

  function readResource(uri) {
    if (uri === "coding-tools://five-stack/api-map") return apiMap(endpoints);
    if (uri === "coding-tools://five-stack/status") return status();
    throw new Error("Unknown five-stack resource");
  }

  async function callTool(name, args = {}, context = {}) {
    const tool = text(name);
    if (!TOOL_NAMES.includes(tool)) throw new Error(`Unknown five-stack tool ${name}`);
    const input = asRecord(args);
    const workspaceId = text(context.workspaceId);
    if (tool === "five_stack_api_map") return apiMap(endpoints);
    if (tool === "five_stack_status") return status(workspaceId);
    if (tool === "five_stack_inspect") return inspectStack(input);
    if (tool === "five_stack_manage") return manageStack(input);
    if (tool === "paseo_plan") return plan(input, workspaceId);
    if (tool === "paseo_run") return run(input, workspaceId);
    if (tool === "paseo_submit_result") return submitResult(input);
    if (tool === "paseo_review") return review(input, workspaceId);
    if (tool === "anneal_open_from_review") return openAnnealFromReview(input, workspaceId);
    if (tool === "anneal_preview") return previewAnneal(input, workspaceId);
    throw new Error(`Unknown five-stack tool ${name}`);
  }

  return {
    apiMap: () => apiMap(endpoints),
    hasTool: (name) => TOOL_NAMES.includes(text(name)),
    isReadOnly: (name) => READ_ONLY_TOOLS.has(text(name)),
    callTool,
    mergeCatalog,
    readResource,
    status,
    mcpTools,
  };
}

module.exports = {
  CPA_BACKEND_PROVIDERS,
  FIVE_STACK_CONTROL_PLANE_TOOLS: TOOL_NAMES,
  FIVE_STACK_IDS: STACK_IDS,
  ROUTER_BACKEND_PROVIDERS,
  annealHandoffBody,
  apiMap,
  createFiveStackControlPlane,
  mergeCatalog,
  mcpResources,
  mcpTools,
  preferredBackend,
  sanitizePublic,
  selectInAppBackend,
  stackAvailability,
};
