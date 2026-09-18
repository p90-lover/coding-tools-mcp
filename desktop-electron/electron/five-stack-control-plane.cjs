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

const TOOL_NAMES = Object.freeze([
  "five_stack_api_map",
  "five_stack_status",
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
  "anneal_preview",
]);

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

function inAppBackends(endpoints) {
  return Object.freeze({
    cpa: endpoints.cpa.v1,
    router: endpoints["codex-router"].v1,
    commandcode: endpoints["commandcode-proxy"].v1,
    paseo: endpoints.paseo.ws,
    anneal: endpoints.anneal.api,
  });
}

function preferredBackend(providerId, backends) {
  if (providerId === "commandcode-proxy") return backends.commandcode;
  if (providerId === "cliproxyapi-antigravity" || providerId === "gemini-oauth") {
    return backends.cpa;
  }
  return backends.cpa;
}

function apiMap(endpoints) {
  const backends = inAppBackends(endpoints);
  return Object.freeze({
    control_plane: "coding-tools-five-stack",
    loop: "paseo_plan → paseo_run → paseo_submit_result → paseo_review → anneal_open_from_review → anneal_preview",
    stacks: Object.freeze({
      cpa: Object.freeze({
        id: "cpa",
        manage: Object.freeze(["launcher.managedComponentsSnapshot", "launcher.startExternalService"]),
        monitor: Object.freeze(["launcher.inspectExternalService", "five_stack_status"]),
        openai: backends.cpa,
        origin: endpoints.cpa.origin,
      }),
      "codex-router": Object.freeze({
        id: "codex-router",
        manage: Object.freeze(["launcher.syncCodexRouter", "launcher.startExternalService"]),
        monitor: Object.freeze(["launcher.inspectExternalService", "five_stack_status"]),
        openai: backends.router,
        origin: endpoints["codex-router"].origin,
      }),
      "commandcode-proxy": Object.freeze({
        id: "commandcode-proxy",
        manage: Object.freeze(["launcher.startExternalService"]),
        monitor: Object.freeze(["launcher.inspectExternalService", "five_stack_status"]),
        openai: backends.commandcode,
        origin: endpoints["commandcode-proxy"].origin,
      }),
      paseo: Object.freeze({
        id: "paseo",
        manage: Object.freeze(["paseo_plan", "paseo_run", "execution.update"]),
        monitor: Object.freeze(["paseo_review", "execution.read", "five_stack_status"]),
        origin: endpoints.paseo.origin,
        execution: endpoints.paseo.ws,
      }),
      anneal: Object.freeze({
        id: "anneal",
        manage: Object.freeze(["anneal_open_from_review", "execution.update"]),
        monitor: Object.freeze(["anneal_preview", "tasks.list", "five_stack_status"]),
        web: endpoints.anneal.web,
        api: endpoints.anneal.api,
      }),
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
      description: "Monitor in-app five-stack endpoints and Paseo/Anneal orchestrator records.",
      readOnly: true,
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
      readOnly: true,
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

  function resolveRole(input, index, fallback) {
    return optionalText(asRecord(input).role, MAX_ROLE, `subagent ${index + 1} role`) || fallback;
  }

  async function plan(input = {}, workspaceId = "") {
    const brief = boundedText(input.brief, MAX_BRIEF, "brief");
    const orchestratorInput = asRecord(input.orchestrator);
    const snapshot = await snapshotForPlan();
    const orchestratorPlan = planProvider(snapshot, {
      workload: "paseo",
      providerId: text(orchestratorInput.providerId) || undefined,
      accountId: text(orchestratorInput.accountId) || undefined,
      model: text(orchestratorInput.model) || undefined,
      allowFallback: orchestratorInput.allowFallback !== false,
    });
    const requested = asList(input.subagents).slice(0, MAX_SUBAGENTS);
    if (requested.length === 0) {
      throw new Error("Assign at least one subagent");
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
      return Object.freeze({
        id: nextId("sub"),
        role: resolveRole(row, index, `subagent-${index + 1}`),
        route: summarized,
        backend: preferredBackend(summarized.providerId, backends),
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
        backend: preferredBackend(orchestratorPlan.provider.id, backends),
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
      status: "dispatched",
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
      status: "awaiting_results",
      liveModelCompletion: false,
    });
    boundedSet(runs, record.id, record);
    return record;
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

  function review(input = {}) {
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

  function openAnnealFromReview(input = {}, workspaceId = "") {
    const selected = requireReview(input.reviewId);
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
    const record = Object.freeze({
      id: nextId("anneal"),
      workspaceId: selected.workspaceId || text(workspaceId),
      title,
      description: findings.map((item) => item.detail || item.title).join("\n"),
      state: "review",
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
        })),
      }),
      findings,
      createdAt: nowIso(clock),
    });
    boundedSet(tasks, record.id, record);
    return record;
  }

  function previewAnneal(input = {}, workspaceId = "") {
    const selected = requireTask(input.taskId);
    if (workspaceId && selected.workspaceId && selected.workspaceId !== workspaceId) {
      throw new Error("Anneal task does not belong to this workspace");
    }
    return selected;
  }

  function status(workspaceId = "") {
    const matchWorkspace = (record) => (
      !workspaceId || !record.workspaceId || record.workspaceId === workspaceId
    );
    return {
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
    if (tool === "paseo_plan") return plan(input, workspaceId);
    if (tool === "paseo_run") return run(input, workspaceId);
    if (tool === "paseo_submit_result") return submitResult(input);
    if (tool === "paseo_review") return review(input);
    if (tool === "anneal_open_from_review") return openAnnealFromReview(input, workspaceId);
    return previewAnneal(input, workspaceId);
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
  FIVE_STACK_CONTROL_PLANE_TOOLS: TOOL_NAMES,
  apiMap,
  createFiveStackControlPlane,
  mergeCatalog,
  mcpResources,
  mcpTools,
};
