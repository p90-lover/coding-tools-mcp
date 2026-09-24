"use strict";

const { defineModule } = require("../lib/define-module.cjs");
const { inspectResult, runtimeUnavailable } = require("../lib/in-process-runtime.cjs");
const { classifyAnnealUnavailable, errorMessage, sanitizePublic } = require("../lib/sanitize.cjs");

const LOOPBACK = Object.freeze({
  web: "http://127.0.0.1:5173/",
  api: "http://127.0.0.1:3000/",
});

async function act(op, args, context) {
  if (typeof context.actUpstream !== "function") {
    return runtimeUnavailable("anneal", "anneal-runtime", "Anneal runtime is not started");
  }
  try {
    return sanitizePublic(await context.actUpstream({
      toolId: "anneal",
      op,
      endpoint: args.endpoint || context.loopback?.api || LOOPBACK.api,
      taskId: args.taskId,
      projectId: args.projectId,
      messageId: args.messageId,
      text: args.text,
      name: args.name,
      description: args.description,
      cwd: args.cwd,
    }));
  } catch (error) {
    const unavailable = classifyAnnealUnavailable(error);
    if (unavailable) {
      return {
        ok: false,
        softFail: true,
        unavailable: true,
        dependency: unavailable.dependency,
        detail: unavailable.message,
        error: unavailable.message,
      };
    }
    throw error;
  }
}

async function inProcessBoard(args, context) {
  const result = await act("board", args, context);
  if (result.ok === false) return result;
  const payload = result.body;
  const tasks = Array.isArray(payload) ? payload : payload?.tasks ?? payload?.items;
  if (!Array.isArray(tasks)) {
    return {
      ok: false,
      detail: "Anneal returned an invalid task listing",
    };
  }
  return sanitizePublic({
    ok: true,
    tasks,
    json: tasks,
    transport: "in-process",
    source: "managed-anneal-api",
  });
}

function createModule() {
  const extraOperations = {
      inspect: {
        readOnly: true,
        description: "Inspect the in-process Anneal handler and bundled source. Does not probe :3000/:5173.",
        run: () => inspectResult("anneal"),
      },
      listTasks: {
        readOnly: true,
        description: "List real tasks through the managed Anneal API. Reports unavailable if its runtime or database is down.",
        run: (args, context) => inProcessBoard(args, context),
      },
      preview: {
        readOnly: true,
        description: "Preview one Anneal task over the managed API.",
        run: (args, context) => act("preview", args, context),
      },
      create: {
        readOnly: false,
        description: "Create an Anneal task (BACKLOG) through Coding Tools.",
        run: (args, context) => act("create", args, context),
      },
      startTask: {
        readOnly: false,
        description: "POST /tasks/{id}/start on the managed Anneal API.",
        run: (args, context) => act("start", args, context),
      },
      retry: {
        readOnly: false,
        description: "POST /tasks/{id}/retry on the managed Anneal API.",
        run: (args, context) => act("retry", args, context),
      },
      hold: {
        readOnly: false,
        description: "POST /tasks/{id}/chain/hold on the managed Anneal API.",
        run: (args, context) => act("hold", args, context),
      },
      resume: {
        readOnly: false,
        description: "POST /tasks/{id}/chain/resume on the managed Anneal API.",
        run: (args, context) => act("resume", args, context),
      },
      archive: {
        readOnly: false,
        description: "POST /tasks/{id}/archive on the managed Anneal API.",
        run: (args, context) => act("archive", args, context),
      },
      unarchive: {
        readOnly: false,
        description: "POST /tasks/{id}/unarchive on the managed Anneal API.",
        run: (args, context) => act("unarchive", args, context),
      },
      inboxDecision: {
        readOnly: false,
        description: "POST an inbox decision on the managed Anneal API.",
        run: (args, context) => act("inbox_decision", args, context),
      },
      openFromReview: {
        readOnly: false,
        description: "Open an Anneal task from a Paseo review via the five-stack control plane.",
        run: async (args, context) => {
          const plane = typeof context.getFiveStack === "function" ? context.getFiveStack() : null;
          if (!plane?.ok || typeof plane.value?.callTool !== "function") {
            return runtimeUnavailable("anneal", "anneal-runtime", "Anneal runtime is not started");
          }
          try {
            return sanitizePublic(await plane.value.callTool("anneal_open_from_review", args, {
              workspaceId: args.workspaceId,
              requestId: args.requestId,
            }));
          } catch (error) {
            const unavailable = classifyAnnealUnavailable(error);
            if (unavailable) {
              return {
                ok: false,
                softFail: true,
                unavailable: true,
                dependency: unavailable.dependency,
                detail: unavailable.message,
                error: unavailable.message,
              };
            }
            throw error;
          }
        },
      },
  };
  extraOperations.board = extraOperations.listTasks;
  extraOperations.activity = {
    readOnly: true,
    description: "Read activity for one task from the managed Anneal API.",
    run: (args, context) => act("activity", args, context),
  };
  extraOperations["task-start"] = extraOperations.startTask;
  extraOperations.inbox_decision = extraOperations.inboxDecision;
  extraOperations.inbox_reply = {
    readOnly: false,
    description: "POST an inbox reply on the managed Anneal API.",
    run: (args, context) => act("inbox_reply", args, context),
  };
  extraOperations.inbox_close = {
    readOnly: false,
    description: "POST inbox close on the managed Anneal API.",
    run: (args, context) => act("inbox_close", args, context),
  };
  return defineModule({
    id: "anneal",
    name: "Anneal",
    loopback: LOOPBACK,
    extraOperations,
  });
}

module.exports = { createModule, LOOPBACK, classifyAnnealUnavailable, errorMessage };
