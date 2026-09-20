"use strict";

const { defineModule } = require("../lib/define-module.cjs");
const { inspectResult, runtimeUnavailable } = require("../lib/in-process-runtime.cjs");
const { publicError } = require("../lib/openai.cjs");
const { sanitizePublic } = require("../lib/sanitize.cjs");
const { mergeToolLists } = require("./source/registry.cjs");

const MODULE_ID = "instant-mcp-tools";

const LOOPBACK = Object.freeze({
  origin: "",
  note: "No dedicated listen port. Product surface is in-process codingTools.apps.",
});

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function jsonArgs(args) {
  const record = asRecord(args);
  const nested = record.arguments;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  if (record.args && typeof record.args === "object" && !Array.isArray(record.args)) return record.args;
  return {};
}

function inProcessReady(action = "inspect") {
  const inspected = inspectResult(MODULE_ID);
  return sanitizePublic({
    ...inspected,
    action,
    startRequired: false,
    dedicatedListenPort: false,
    listening: false,
    runtimeStarted: false,
    via: "codingTools.apps",
  });
}

async function callService(context, name, args, label) {
  const fn = context.services?.[name];
  if (typeof fn !== "function") return null;
  try {
    return sanitizePublic(await fn(args && typeof args === "object" ? args : {}));
  } catch (error) {
    return {
      ok: false,
      softFail: true,
      unavailable: true,
      reason: `${label} is unavailable: ${publicError(error)}`,
      listening: false,
      dedicatedListenPort: false,
      transport: "in-process",
    };
  }
}

function fiveStackPlane(context) {
  const plane = typeof context.getFiveStack === "function" ? context.getFiveStack() : null;
  return plane && plane.ok === true && plane.value && typeof plane.value === "object" ? plane : null;
}

async function listToolsFallback(args, context) {
  const plane = fiveStackPlane(context);
  let catalog = { tools: [] };
  if (plane?.value && typeof plane.value.mergeCatalog === "function") {
    try {
      catalog = plane.value.mergeCatalog({ tools: [], unavailable: true });
    } catch (error) {
      return {
        ok: true,
        tools: [],
        count: 0,
        fiveStackUnavailable: true,
        reason: publicError(error),
        listening: false,
        dedicatedListenPort: false,
        transport: "in-process",
        via: "codingTools.apps",
      };
    }
  } else if (plane?.value && typeof plane.value.mcpTools === "function") {
    catalog = { tools: plane.value.mcpTools() };
  }
  const tools = mergeToolLists(catalog.tools);
  return sanitizePublic({
    ok: true,
    tools,
    count: tools.length,
    workspaceId: text(args.workspaceId) || null,
    headlessUnavailable: true,
    fiveStackUnavailable: !plane,
    listening: false,
    dedicatedListenPort: false,
    transport: "in-process",
    via: "codingTools.apps",
  });
}

async function listTools(args, context) {
  const injected = await callService(context, "listTools", args, "MCP tool listing");
  if (injected) {
    const tools = mergeToolLists(injected.tools);
    return sanitizePublic({
      ...injected,
      ok: injected.ok !== false,
      tools,
      count: Number.isInteger(injected.count) ? injected.count : tools.length,
      listening: false,
      dedicatedListenPort: false,
      transport: "in-process",
      via: injected.via || "codingTools.apps",
    });
  }
  return listToolsFallback(args, context);
}

async function listWorkspaces(args, context) {
  const injected = await callService(context, "listWorkspaces", args, "Workspace listing");
  if (injected) {
    const items = asList(injected.items);
    return sanitizePublic({
      ...injected,
      ok: injected.ok !== false,
      items,
      nextCursor: injected.nextCursor ?? null,
      listening: false,
      dedicatedListenPort: false,
      transport: "in-process",
    });
  }
  return sanitizePublic({
    ok: true,
    items: [],
    nextCursor: null,
    headlessUnavailable: true,
    reason: "Workspace listing is unavailable",
    listening: false,
    dedicatedListenPort: false,
    transport: "in-process",
  });
}

async function runTool(args, context) {
  const tool = text(args.tool) || text(args.name);
  if (!tool) {
    return {
      ok: false,
      reason: "runTool requires tool",
      listening: false,
      dedicatedListenPort: false,
      transport: "in-process",
    };
  }
  const payload = {
    ...asRecord(args),
    tool,
    arguments: jsonArgs(args),
  };
  const injected = await callService(context, "runTool", payload, "MCP tool execution");
  if (injected) {
    return sanitizePublic({
      ...injected,
      ok: injected.ok !== false,
      tool,
      listening: false,
      dedicatedListenPort: false,
      transport: "in-process",
    });
  }
  const plane = fiveStackPlane(context);
  if (plane?.value && typeof plane.value.hasTool === "function" && plane.value.hasTool(tool)
    && typeof plane.value.callTool === "function") {
    try {
      const result = await plane.value.callTool(tool, payload.arguments, {
        workspaceId: payload.workspaceId,
        requestId: payload.requestId,
      });
      return sanitizePublic({
        ok: true,
        tool,
        result,
        via: "five-stack",
        listening: false,
        dedicatedListenPort: false,
        transport: "in-process",
      });
    } catch (error) {
      return {
        ok: false,
        softFail: true,
        tool,
        reason: publicError(error),
        listening: false,
        dedicatedListenPort: false,
        transport: "in-process",
      };
    }
  }
  return runtimeUnavailable(MODULE_ID, "mcp-runtime", "MCP tool runtime is unavailable");
}

function createModule() {
  const extraOperations = {
    inspect: {
      readOnly: true,
      description: "Inspect the in-process Instant MCP Tools handler. Ready without a dedicated listen port or Start.",
      run: () => inProcessReady("inspect"),
    },
    start: {
      readOnly: false,
      description: "No-op ready. Instant MCP Tools is in-process; there is no dedicated Start or listen port.",
      run: () => inProcessReady("start"),
    },
    stop: {
      readOnly: false,
      description: "No-op. Instant MCP Tools does not own a listen port.",
      run: () => inProcessReady("stop"),
    },
    restart: {
      readOnly: false,
      description: "No-op ready. Instant MCP Tools stays in-process.",
      run: () => inProcessReady("restart"),
    },
    repair: {
      readOnly: false,
      description: "Re-inspect the bundled Instant MCP Tools handler. Does not download or bind a port.",
      run: () => inProcessReady("repair"),
    },
    install: {
      readOnly: false,
      description: "Bundled in-tree. Prefer local extraResources; does not download to use.",
      run: () => inProcessReady("install"),
    },
    listTools: {
      readOnly: true,
      description: "List Desktop MCP tools (apps overlay, five-stack, workspace catalog). Equivalent to the MCP page tool list.",
      run: (args, context) => listTools(args, context),
    },
    runTool: {
      readOnly: false,
      description: "Run a Desktop MCP tool with a JSON object of arguments. Equivalent to the MCP page Run tool / 執行工具 control.",
      run: (args, context) => runTool(args, context),
    },
    listWorkspaces: {
      readOnly: true,
      description: "List Coding Tools workspaces for Instant MCP Tools. Soft-fails empty when headless MCP is down.",
      run: (args, context) => listWorkspaces(args, context),
    },
  };
  extraOperations.tools = extraOperations.listTools;
  extraOperations["list-tools"] = extraOperations.listTools;
  extraOperations.callTool = extraOperations.runTool;
  extraOperations["run-tool"] = extraOperations.runTool;
  return defineModule({
    id: MODULE_ID,
    name: "Instant MCP Tools",
    loopback: LOOPBACK,
    extraOperations,
  });
}

module.exports = { createModule, LOOPBACK, MODULE_ID };
