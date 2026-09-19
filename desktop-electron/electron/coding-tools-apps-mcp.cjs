"use strict";

const { requireAppHandler } = require("./app-handler-paths.cjs");

function loadSanitizePublic() {
  try {
    return requireAppHandler("lib/sanitize.cjs").sanitizePublic;
  } catch {
    return (value) => value;
  }
}

const sanitizePublic = loadSanitizePublic();

const PROXY_SEED = "http://127.0.0.1:17891";
const TOOL_NAMES = Object.freeze([
  "apps_list",
  "apps_catalog",
  "apps_call",
  "apps_invoke",
  "apps_status",
]);
const READ_ONLY_TOOLS = new Set(["apps_list", "apps_catalog", "apps_status"]);

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function toolName(entry) {
  if (typeof entry === "string") return text(entry);
  return text(asRecord(entry).name);
}

function mcpTools() {
  return Object.freeze([
    Object.freeze({
      name: "apps_list",
      description: "List registered Coding Tools modules. Maps to codingTools.apps.list(); in-process, no dedicated listen ports.",
      readOnly: true,
      via: "codingTools.apps.list",
    }),
    Object.freeze({
      name: "apps_catalog",
      description: "Catalog in-process module operations. Maps to codingTools.apps.catalog().",
      readOnly: true,
      via: "codingTools.apps.catalog",
    }),
    Object.freeze({
      name: "apps_call",
      description: "Call an in-process module handler. Maps to codingTools.apps.call({ moduleId, operation, arguments }).",
      readOnly: false,
      via: "codingTools.apps.call",
    }),
    Object.freeze({
      name: "apps_invoke",
      description: "Invoke an in-process module handler. Maps to codingTools.apps.invoke({ handle, operation, arguments }).",
      readOnly: false,
      via: "codingTools.apps.invoke",
    }),
    Object.freeze({
      name: "apps_status",
      description: "Report handler registration and inspect-ready state without spawning dedicated listen ports. Inspect only.",
      readOnly: true,
      via: "codingTools.apps.call",
    }),
  ]);
}

function mergeAppsCatalog(catalog = {}) {
  const record = asRecord(catalog);
  const existing = asList(record.tools);
  const seen = new Set(existing.map((entry) => toolName(entry)).filter(Boolean));
  const tools = [];
  for (const tool of mcpTools()) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push({
      name: tool.name,
      description: tool.description,
      readOnly: tool.readOnly === true,
      via: tool.via,
    });
  }
  for (const tool of existing) tools.push(tool);
  return {
    ...record,
    tools,
    apps: Object.freeze({
      via: "codingTools.apps",
      transport: "in-process",
      dedicatedListenPorts: false,
      proxySeed: PROXY_SEED,
      tools: TOOL_NAMES.slice(),
    }),
  };
}

function inspectStatus(payload) {
  const wrapped = asRecord(payload);
  const result = asRecord(wrapped.result);
  return text(result.status) || text(wrapped.status);
}

function isModuleReady(payload) {
  return inspectStatus(payload) === "ready";
}

function createCodingToolsAppsMcp({ getHost } = {}) {
  function hostOrNull() {
    if (typeof getHost === "function") return getHost() || null;
    return getHost || null;
  }

  function requireHost() {
    const host = hostOrNull();
    if (!host) throw new Error("Apps host is unavailable");
    return host;
  }

  function hasTool(name) {
    return TOOL_NAMES.includes(text(name));
  }

  function isReadOnly(name, args = {}) {
    const tool = text(name);
    if (READ_ONLY_TOOLS.has(tool)) return true;
    if (tool !== "apps_call" && tool !== "apps_invoke") return false;
    const host = hostOrNull();
    const input = asRecord(args);
    const id = text(input.moduleId) || text(input.handle);
    const operation = text(input.operation);
    if (!host || typeof host.isReadOnly !== "function" || !id || !operation) return false;
    return host.isReadOnly(id, operation) === true;
  }

  async function status() {
    const host = requireHost();
    const listed = host.list();
    const modules = [];
    for (const entry of asList(listed.modules)) {
      let inspect = null;
      try {
        inspect = await host.call(entry.id, "inspect", {});
      } catch (error) {
        inspect = {
          ok: false,
          moduleId: entry.id,
          operation: "inspect",
          transport: "in-process",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      modules.push({
        id: entry.id,
        name: entry.name || entry.id,
        transport: "in-process",
        handlerRegistered: true,
        ready: isModuleReady(inspect),
        listening: false,
        dedicatedListenPort: false,
        operations: asList(entry.operations),
        inspect: sanitizePublic(inspect),
        legacyLoopback: entry.legacyLoopback || null,
      });
    }
    return sanitizePublic({
      version: 1,
      host: "coding-tools-apps",
      via: "codingTools.apps",
      transport: "in-process",
      dedicatedListenPorts: false,
      listening: false,
      proxySeed: PROXY_SEED,
      modules,
    });
  }

  async function callTool(name, args = {}) {
    const tool = text(name);
    if (!hasTool(tool)) throw new Error(`Unknown apps MCP tool ${name}`);
    const input = asRecord(args);
    const host = requireHost();
    if (tool === "apps_list") {
      return sanitizePublic({
        ...host.list(),
        via: "codingTools.apps.list",
        dedicatedListenPorts: false,
        proxySeed: PROXY_SEED,
      });
    }
    if (tool === "apps_catalog") {
      return sanitizePublic({
        ...host.catalog(),
        via: "codingTools.apps.catalog",
        dedicatedListenPorts: false,
        proxySeed: PROXY_SEED,
      });
    }
    if (tool === "apps_status") return status();
    if (tool === "apps_call") {
      const moduleId = text(input.moduleId) || text(input.handle);
      const operation = text(input.operation);
      if (!moduleId) throw new Error("apps_call requires moduleId");
      if (!operation) throw new Error("apps_call requires operation");
      const result = await host.call(moduleId, operation, asRecord(input.arguments));
      return sanitizePublic({
        ...result,
        via: "codingTools.apps.call",
        dedicatedListenPorts: false,
      });
    }
    const handle = text(input.handle) || text(input.moduleId);
    const operation = text(input.operation);
    if (!handle) throw new Error("apps_invoke requires handle");
    if (!operation) throw new Error("apps_invoke requires operation");
    if (typeof host.invoke !== "function") {
      const result = await host.call(handle, operation, asRecord(input.arguments));
      return sanitizePublic({
        ...result,
        via: "codingTools.apps.invoke",
        dedicatedListenPorts: false,
      });
    }
    const invoked = await host.invoke({
      handle,
      moduleId: handle,
      operation,
      arguments: asRecord(input.arguments),
    });
    return sanitizePublic({
      ...invoked,
      via: "codingTools.apps.invoke",
      dedicatedListenPorts: false,
    });
  }

  return Object.freeze({
    hasTool,
    isReadOnly,
    callTool,
    mergeCatalog: mergeAppsCatalog,
    mcpTools,
    status,
    toolNames: TOOL_NAMES.slice(),
  });
}

module.exports = Object.freeze({
  APPS_MCP_TOOLS: TOOL_NAMES,
  PROXY_SEED,
  createCodingToolsAppsMcp,
  mergeAppsCatalog,
  mcpTools,
});
