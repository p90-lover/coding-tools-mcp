"use strict";

const { mergeAppsCatalog } = require("./coding-tools-apps-mcp.cjs");
const { toWorkspaceSummary } = require("./coding-tools-shell-bridge.cjs");

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\/_codex-router\/[^/?#]+/g, "/_codex-router/[REDACTED]");
}

function createInstantMcpToolsServices({
  getHeadlessHost,
  getFiveStack,
  getAppsMcp,
} = {}) {
  function headlessHost() {
    return typeof getHeadlessHost === "function" ? getHeadlessHost() : null;
  }

  function fiveStack() {
    const plane = typeof getFiveStack === "function" ? getFiveStack() : null;
    return plane && plane.ok === true && plane.value ? plane : null;
  }

  function appsMcp() {
    return typeof getAppsMcp === "function" ? getAppsMcp() : null;
  }

  async function listWorkspaces() {
    const host = headlessHost();
    if (!host || typeof host.request !== "function") {
      return {
        ok: true,
        items: [],
        nextCursor: null,
        headlessUnavailable: true,
        reason: "Local Coding Tools service is unavailable",
        listening: false,
        dedicatedListenPort: false,
        transport: "in-process",
      };
    }
    try {
      const payload = await host.request("/api/v1/workspaces", null, { method: "GET" });
      const workspaces = asList(payload?.workspaces).map((entry, index) => (
        toWorkspaceSummary(entry, index)
      )).filter(Boolean);
      return {
        ok: true,
        items: workspaces,
        nextCursor: null,
        headlessUnavailable: false,
        listening: false,
        dedicatedListenPort: false,
        transport: "in-process",
      };
    } catch (error) {
      return {
        ok: true,
        items: [],
        nextCursor: null,
        softFail: true,
        headlessUnavailable: true,
        reason: publicError(error),
        listening: false,
        dedicatedListenPort: false,
        transport: "in-process",
      };
    }
  }

  async function listTools(input = {}) {
    const workspaceId = text(input.workspaceId);
    let headless = { tools: [], unavailable: true };
    const host = headlessHost();
    if (workspaceId && host && typeof host.request === "function") {
      try {
        const catalog = await host.request(
          `/api/v1/tools/catalog?workspace_id=${encodeURIComponent(workspaceId)}`,
          null,
          { method: "GET" },
        );
        headless = asRecord(catalog);
        if (!Array.isArray(headless.tools)) headless = { ...headless, tools: [] };
      } catch (error) {
        headless = {
          tools: [],
          unavailable: true,
          reason: publicError(error),
        };
      }
    }
    const plane = fiveStack();
    let merged = headless;
    let fiveStackUnavailable = !plane;
    if (plane?.value && typeof plane.value.mergeCatalog === "function") {
      try {
        merged = plane.value.mergeCatalog(headless);
        fiveStackUnavailable = false;
      } catch (error) {
        fiveStackUnavailable = true;
        merged = {
          ...headless,
          fiveStackUnavailable: true,
          reason: publicError(error),
        };
      }
    }
    const catalog = mergeAppsCatalog(merged);
    const tools = asList(catalog.tools);
    return {
      ok: true,
      tools,
      count: tools.length,
      workspaceId: workspaceId || null,
      headlessUnavailable: headless.unavailable === true,
      fiveStackUnavailable,
      listening: false,
      dedicatedListenPort: false,
      transport: "in-process",
      via: "codingTools.apps",
    };
  }

  async function runTool(input = {}) {
    const tool = text(input.tool) || text(input.name);
    const args = input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
      ? input.arguments
      : {};
    if (!tool) {
      return {
        ok: false,
        reason: "runTool requires tool",
        listening: false,
        dedicatedListenPort: false,
        transport: "in-process",
      };
    }
    const workspaceId = text(input.workspaceId) || undefined;
    const requestId = text(input.requestId) || `apps-${Date.now()}`;
    try {
      const overlay = appsMcp();
      if (overlay && typeof overlay.hasTool === "function" && overlay.hasTool(tool)) {
        const result = await overlay.callTool(tool, args, { workspaceId, requestId });
        return {
          ok: true,
          tool,
          result,
          via: "codingTools.apps",
          listening: false,
          dedicatedListenPort: false,
          transport: "in-process",
        };
      }
      const plane = fiveStack();
      if (plane?.value && typeof plane.value.hasTool === "function" && plane.value.hasTool(tool)
        && typeof plane.value.callTool === "function") {
        const result = await plane.value.callTool(tool, args, { workspaceId, requestId });
        return {
          ok: true,
          tool,
          result,
          via: "five-stack",
          listening: false,
          dedicatedListenPort: false,
          transport: "in-process",
        };
      }
      const host = headlessHost();
      if (!host || typeof host.request !== "function") {
        return {
          ok: false,
          softFail: true,
          unavailable: true,
          tool,
          reason: "MCP tool runtime is unavailable",
          listening: false,
          dedicatedListenPort: false,
          transport: "in-process",
        };
      }
      if (!workspaceId) {
        return {
          ok: false,
          softFail: true,
          unavailable: true,
          tool,
          reason: "runTool requires workspaceId for workspace MCP tools",
          listening: false,
          dedicatedListenPort: false,
          transport: "in-process",
        };
      }
      const result = await host.request("/api/v1/tools/call", {
        request_id: requestId,
        workspace_id: workspaceId,
        tool,
        arguments: args,
      }, { method: "POST" });
      return {
        ok: true,
        tool,
        result,
        via: "headless",
        listening: false,
        dedicatedListenPort: false,
        transport: "in-process",
      };
    } catch (error) {
      return {
        ok: false,
        softFail: true,
        unavailable: true,
        tool,
        reason: publicError(error),
        listening: false,
        dedicatedListenPort: false,
        transport: "in-process",
      };
    }
  }

  return Object.freeze({
    listWorkspaces,
    listTools,
    runTool,
  });
}

module.exports = Object.freeze({
  createInstantMcpToolsServices,
});
