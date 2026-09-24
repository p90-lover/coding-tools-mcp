"use strict";

const { randomUUID } = require("node:crypto");
const { FIVE_STACK_ENDPOINTS } = require("./five-stack-cross-use.cjs");
const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");

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
  "runtime_open_task",
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
  return Object.freeze({
    workload: plan.workload,
    providerId: plan.provider.id,
    providerName: plan.provider.name,
    protocol: plan.provider.protocol,
    accountId: plan.account.id,
    accountLabel: plan.account.label,
    model: plan.model,
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
  if (providerId === "commandcode-proxy") return "commandcode";
  if (CPA_BACKEND_PROVIDERS.includes(providerId)) return "cpa";
  if (ROUTER_BACKEND_PROVIDERS.includes(providerId)) return "router";
  return "cpa";
}

function selectInAppBackend(providerId, backends, availability = {}) {
  const preferred = preferredKind(providerId);
  const order = preferred === "commandcode"
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
    loop: "runtime_open_task → paseo_plan → paseo_run → paseo_submit_result → paseo_review → anneal_open_from_review → anneal_preview",
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
      description: "Queue assignments for an external worker executor. This API records assignments; it does not itself execute a coding agent.",
      readOnly: false,
    }),
    Object.freeze({
      name: "paseo_submit_result",
      description: "Return a subagent result or issue to the Paseo orchestrator for review.",
      readOnly: false,
    }),
    Object.freeze({
      name: "paseo_review",
      description: "Collect submitted worker findings for the orchestrator to review. This is not a model-generated final verdict.",
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
    Object.freeze({
      name: "runtime_open_task",
      description: "Queue a visible Coding Tools task and worker assignments for Web GPT. Requires an external executor to run workers; supplied results are collected for a separate orchestrator review.",
      readOnly: false,
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
    if (typeof getServicesSnapshot !== "function") {
      return { cpa: null, router: null, commandcode: null, anneal: null, paseo: null };
    }
    try {
      return stackAvailability(await getServicesSnapshot());
    } catch {
      return { cpa: null, router: null, commandcode: null, anneal: null, paseo: null };
    }
  }

  function attachBackend(providerId, availability) {
    const selected = selectInAppBackend(providerId, backends, availability);
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

  async function plan(input = {}, workspaceId = "") {
    const brief = boundedText(input.brief, MAX_BRIEF, "brief");
    const orchestratorInput = asRecord(input.orchestrator);
    const snapshot = await snapshotForPlan();
    const availability = await readAvailability();
    const orchestratorPlan = planProvider(snapshot, {
      workload: "paseo",
      providerId: text(orchestratorInput.providerId) || undefined,
      accountId: text(orchestratorInput.accountId) || undefined,
      model: text(orchestratorInput.model) || undefined,
      allowFallback: orchestratorInput.allowFallback !== false,
    });
    const requested = (asList(input.workers).length ? asList(input.workers) : asList(input.subagents))
      .slice(0, MAX_SUBAGENTS);
    if (requested.length === 0) {
      throw new Error("Assign at least one worker");
    }
    const subagents = requested.map((entry, index) => {
      const row = asRecord(entry);
      const route = planProvider(snapshot, {
        workload: "subagent",
        providerId: text(row.providerId) || undefined,
        accountId: text(row.accountId) || undefined,
        model: text(row.model) || undefined,
        allowFallback: row.allowFallback !== false,
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
    const record = Object.freeze({
      id: nextId("plan"),
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

  function assertWorkspace(record, workspaceId) {
    if (workspaceId && record.workspaceId && record.workspaceId !== workspaceId) {
      throw new Error("Record does not belong to this workspace");
    }
  }

  function run(input = {}, workspaceId = "") {
    const selected = requirePlan(input.planId);
    if (workspaceId && selected.workspaceId && selected.workspaceId !== workspaceId) {
      throw new Error("Plan does not belong to this workspace");
    }
    const message = boundedText(input.message ?? selected.brief, MAX_BRIEF, "message");
    const assignments = selected.subagents.map((subagent) => Object.freeze({
      id: subagent.id,
      role: subagent.role,
      route: subagent.route,
      backend: subagent.backend,
      status: "awaiting_dispatch",
      summary: "",
      issues: Object.freeze([]),
    }));
    const record = Object.freeze({
      id: nextId("run"),
      planId: selected.id,
      workspaceId: selected.workspaceId || text(workspaceId),
      message,
      createdAt: nowIso(clock),
      orchestrator: selected.orchestrator,
      assignments,
      backends: selected.backends,
      status: "awaiting_dispatch",
      dispatchRequired: true,
      reason: "Assignments are queued; an external worker executor must run them and submit results.",
      liveModelCompletion: false,
    });
    boundedSet(runs, record.id, record);
    boundedSet(tasks, record.id, Object.freeze({
      id: record.id,
      workspaceId: record.workspaceId,
      title: selected.brief.slice(0, MAX_FINDING_TITLE),
      description: message,
      state: "BACKLOG",
      createdAt: record.createdAt,
      source: { kind: "paseo_run", planId: selected.id, runId: record.id },
      assignment: { orchestrator: selected.orchestrator, subagents: selected.subagents },
      handoff: { attempted: false, posted: false, remoteId: null },
    }));
    return record;
  }

  function submitResult(input = {}, workspaceId = "") {
    const selected = requireRun(input.runId);
    assertWorkspace(selected, workspaceId);
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
    if (input.ok === false && !issues.length) {
      issues.push(Object.freeze({
        id: nextId("find"),
        title: `${assignment.role} failed`.slice(0, MAX_FINDING_TITLE),
        detail: optionalText(input.summary, MAX_SUMMARY, "summary").slice(0, MAX_FINDING_DETAIL)
          || "Worker reported failure without findings.",
      }));
    }
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
    const remaining = assignments.some((item) => item.status === "awaiting_dispatch");
    const hasIssues = assignments.some((item) => item.issues.length > 0 || item.status === "issues_found");
    const next = Object.freeze({
      ...selected,
      assignments: Object.freeze(assignments),
      status: remaining ? "awaiting_results" : hasIssues ? "issues_found" : "returned",
      dispatchRequired: remaining,
      reason: remaining ? selected.reason : null,
    });
    runs.set(next.id, next);
    const task = tasks.get(next.id);
    if (task) tasks.set(task.id, Object.freeze({ ...task, state: remaining ? "BACKLOG" : "REVIEW" }));
    return next;
  }

  function review(input = {}, workspaceId = "") {
    const selected = requireRun(input.runId);
    assertWorkspace(selected, workspaceId);
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
      source: "submitted_worker_results",
      requiresOrchestratorReview: true,
      liveModelCompletion: selected.liveModelCompletion === true,
    });
    boundedSet(reviews, record.id, record);
    return record;
  }

  async function openRuntimeTask(input = {}, workspaceId = "") {
    const brief = input.brief || input.title || input.task;
    const planned = await plan({
      brief,
      orchestrator: input.orchestrator,
      workers: input.workers,
      subagents: input.subagents,
    }, workspaceId);
    let current = run({
      planId: planned.id,
      message: brief || planned.brief,
    }, workspaceId);
    const supplied = asList(input.results);
    supplied.forEach((entry, index) => {
      const assignment = current.assignments[index];
      if (!assignment) return;
      const row = asRecord(entry);
      current = submitResult({
        runId: current.id,
        assignmentId: assignment.id,
        ok: row.ok,
        summary: row.summary || row.response || row.content,
        issues: row.issues,
      });
    });
    const awaitingWorkers = current.assignments.some((item) => item.status === "awaiting_dispatch");
    const reviewed = awaitingWorkers ? null : review({ runId: current.id }, workspaceId);
    const workerLines = current.assignments
      .filter((item) => item.status !== "awaiting_dispatch")
      .map((item) => `${item.role}: ${item.summary || item.status}`);
    return Object.freeze({
      ok: true,
      taskId: current.id,
      runId: current.id,
      reviewId: reviewed?.id,
      workspaceId: planned.workspaceId,
      status: current.status,
      orchestrator: planned.orchestrator,
      workers: current.assignments,
      review: reviewed,
      awaitingWorkers,
      dispatchRequired: current.dispatchRequired,
      reason: current.reason,
      requiresOrchestratorReview: true,
      response: workerLines.join("\n"),
    });
  }

  async function openAnnealFromReview(input = {}, workspaceId = "") {
    const selected = requireReview(input.reviewId);
    assertWorkspace(selected, workspaceId);
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
    let posted = false;
    let remoteId = null;
    let handoffError = null;
    const availability = await readAvailability();
    if (availability.anneal !== false && typeof handoffAnnealTask === "function") {
      try {
        const remote = await handoffAnnealTask({
          projectId,
          path: `/projects/${projectId}/tasks`,
          body,
        });
        remoteId = text(asRecord(remote).id) || text(asRecord(remote).taskId) || null;
        if (asRecord(remote).ok === false || !remoteId) {
          throw new Error("Anneal did not acknowledge task creation with a task ID");
        }
        posted = true;
      } catch (error) {
        handoffError = error instanceof Error ? error.message : String(error);
      }
    }
    const record = Object.freeze({
      id: remoteId || localId,
      localId,
      workspaceId: selected.workspaceId || text(workspaceId),
      projectId,
      title,
      description,
      state: "BACKLOG",
      approvalGate: true,
      opensPullRequest: false,
      previewPath: `/tasks/${remoteId || localId}`,
      boardPath: "/tasks",
      handoff: Object.freeze({
        attempted: availability.anneal !== false && typeof handoffAnnealTask === "function",
        posted,
        remoteId,
        error: handoffError,
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
    if (tool === "paseo_submit_result") return submitResult(input, workspaceId);
    if (tool === "paseo_review") return review(input, workspaceId);
    if (tool === "anneal_open_from_review") return openAnnealFromReview(input, workspaceId);
    if (tool === "anneal_preview") return previewAnneal(input, workspaceId);
    if (tool === "runtime_open_task") return openRuntimeTask(input, workspaceId);
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
