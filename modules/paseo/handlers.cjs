"use strict";

const { defineModule } = require("../lib/define-module.cjs");
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
    throw new Error("Paseo protocol actions are unavailable");
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
    throw new Error("Five-stack control plane is not ready");
  }
  return sanitizePublic(await plane.value.callTool(name, args, {
    workspaceId: args.workspaceId,
    requestId: args.requestId,
  }));
}

function createModule() {
  const extraOperations = {};
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
      run: (args, context) => fiveStack(tool, args, context),
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
