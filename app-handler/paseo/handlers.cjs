"use strict";

const { defineModule } = require("../lib/define-module.cjs");
const { inspectResult, moduleSnapshot, runtimeUnavailable } = require("../lib/in-process-runtime.cjs");
const { sanitizePublic } = require("../lib/sanitize.cjs");

const LOOPBACK = Object.freeze({
  origin: "http://127.0.0.1:6768/",
  execution: "ws://127.0.0.1:6768/ws",
});

const PROTOCOL_OPS = Object.freeze(["send", "resume", "cancel", "archive", "permission", "create"]);
const FIVE_STACK_OPS = Object.freeze({
  plan: "paseo_plan",
  run: "paseo_run",
  submitResult: "paseo_submit_result",
  review: "paseo_review",
});

async function act(op, args, context) {
  if (typeof context.actUpstream !== "function") {
    return runtimeUnavailable("paseo", "paseo-runtime", "Paseo protocol actions are unavailable");
  }
  return sanitizePublic(await context.actUpstream({
    toolId: "paseo",
    op,
    endpoint: args.endpoint || context.loopback?.execution || LOOPBACK.execution,
    agentId: args.agentId,
    sessionId: args.sessionId,
    text: args.text,
    provider: args.provider,
    cwd: args.cwd,
    requestId: args.requestId,
    behavior: args.behavior,
  }));
}

async function fiveStack(name, args, context) {
  const plane = typeof context.getFiveStack === "function" ? context.getFiveStack() : null;
  if (!plane?.ok || typeof plane.value?.callTool !== "function") {
    return runtimeUnavailable("paseo", "paseo-runtime", "Paseo runtime is not started");
  }
  return sanitizePublic(await plane.value.callTool(name, args, {
    workspaceId: args.workspaceId,
    requestId: args.requestId,
  }));
}

async function inProcessPlan(args, context) {
  const plane = typeof context.getFiveStack === "function" ? context.getFiveStack() : null;
  if (plane?.ok && typeof plane.value?.callTool === "function") {
    return sanitizePublic(await plane.value.callTool("paseo_plan", args, {
      workspaceId: args.workspaceId,
      requestId: args.requestId,
    }));
  }
  const snapshot = moduleSnapshot("paseo");
  if (!snapshot.present) {
    return runtimeUnavailable("paseo", "paseo-source", "Paseo bundled source is missing");
  }
  return sanitizePublic({
    ok: true,
    tool: "paseo_plan",
    status: "planned",
    brief: typeof args.brief === "string" ? args.brief : "",
    workspaceId: args.workspaceId || "",
    subagents: Array.isArray(args.subagents) ? args.subagents : [],
    listening: false,
    runtimeStarted: false,
    transport: "in-process",
    source: snapshot.source,
    vendor: snapshot.vendor,
  });
}

function createModule() {
  const extraOperations = {
    inspect: {
      readOnly: true,
      description: "Inspect the in-process Paseo handler and bundled source. Does not probe :6768.",
      run: () => inspectResult("paseo"),
    },
  };
  for (const op of PROTOCOL_OPS) {
    extraOperations[op] = {
      readOnly: false,
      description: `Allowlisted Paseo protocol v1 ${op}. Calls the managed daemon, not a standalone GUI.`,
      run: (args, context) => act(op, args, context),
    };
  }
  for (const [operation, tool] of Object.entries(FIVE_STACK_OPS)) {
    extraOperations[operation] = {
      readOnly: operation === "review",
      description: `Coding Tools five-stack ${tool}.`,
      run: (args, context) => (
        operation === "plan" ? inProcessPlan(args, context) : fiveStack(tool, args, context)
      ),
    };
  }
  return defineModule({
    id: "paseo",
    name: "Paseo",
    loopback: LOOPBACK,
    extraOperations,
  });
}

module.exports = { createModule, LOOPBACK };
