"use strict";

const MCP_STATES = new Set(["stopped", "starting", "running", "stopping", "error"]);

function emptyPage() {
  return Object.freeze({ items: Object.freeze([]), nextCursor: null });
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function boundedMcpState(value) {
  return MCP_STATES.has(value) ? value : "stopped";
}

function toWorkspaceSummary(workspace, index = 0) {
  const record = asRecord(workspace);
  const id = text(record.id, text(record.workspace_id));
  const name = text(record.name, id);
  const pathValue = text(record.path, text(record.workspace_path));
  if (!id || !name || !pathValue) return null;
  return {
    id,
    name,
    path: pathValue,
    mcpState: boundedMcpState(record.mcpState || record.mcp_state),
    policyRevision: Number.isInteger(record.policyRevision)
      ? record.policyRevision
      : Number.isInteger(record.policy_revision)
        ? record.policy_revision
        : index,
  };
}

function pageWorkspaces(workspaces, cursor = 0, limit = 25) {
  const start = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
  const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 25;
  const items = workspaces.slice(start, start + size);
  return {
    items,
    nextCursor: start + items.length < workspaces.length ? start + items.length : null,
  };
}

function createCodingToolsShellBridge({
  assertFocusedMainWindow,
  headlessHost,
  managedAppApi,
  updateController,
}) {
  const requireHost = () => {
    if (!headlessHost) throw new Error("Local Coding Tools service is unavailable");
    return headlessHost;
  };
  const requireManagedAppApi = () => {
    if (!managedAppApi) throw new Error("Managed application API is unavailable");
    return managedAppApi;
  };

  const requestHeadless = (pathname, body = null, method) => requireHost().request(pathname, body, { method });

  const listWorkspaceRecords = async () => {
    const payload = await requestHeadless("/api/v1/workspaces", null, "GET");
    const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
    return workspaces.map((workspace, index) => toWorkspaceSummary(workspace, index)).filter(Boolean);
  };

  return {
    async runtimeStatus(event) {
      assertFocusedMainWindow(event, false);
      const payload = await requestHeadless("/api/v1/state", null, "GET");
      const lifecycle = asRecord(payload?.lifecycle);
      return {
        ready: payload?.ok === true,
        accepting: lifecycle.accepting !== false,
        active_requests: Number.isInteger(lifecycle.active_requests) ? lifecycle.active_requests : 0,
        automatic_replay: payload?.automatic_replay === true,
        version: text(payload?.version, ""),
        workspace_count: Array.isArray(payload?.workspaces) ? payload.workspaces.length : 0,
      };
    },

    async listWorkspaces(event, input = {}) {
      assertFocusedMainWindow(event, false);
      return pageWorkspaces(await listWorkspaceRecords(), input.cursor, input.limit);
    },

    async permissionsSnapshot(event, input) {
      assertFocusedMainWindow(event, false);
      const workspace = (await listWorkspaceRecords()).find((item) => item.id === input.workspaceId);
      if (!workspace) throw new Error("Workspace was not found");
      return {
        workspaceId: workspace.id,
        path: workspace.path,
        mcpState: workspace.mcpState,
        policyRevision: workspace.policyRevision,
      };
    },

    async computerStatus(event) {
      assertFocusedMainWindow(event, false);
      return {
        available: false,
        reason: "Computer control remains a separate Desktop pairing surface.",
      };
    },

    async listTasks(event) {
      assertFocusedMainWindow(event, false);
      return emptyPage();
    },

    async searchHistory(event) {
      assertFocusedMainWindow(event, false);
      return emptyPage();
    },

    async nativeCodexStatus(event) {
      assertFocusedMainWindow(event, false);
      const runtime = await this.runtimeStatus(event);
      return {
        available: runtime.ready === true,
        ready: runtime.ready === true,
      };
    },

    async integrationsSnapshot(event) {
      assertFocusedMainWindow(event, false);
      return requireManagedAppApi().snapshot();
    },

    async managedAppsSnapshot(event) {
      assertFocusedMainWindow(event, false);
      return requireManagedAppApi().snapshot();
    },

    async managedAppInvoke(event, input) {
      const mutating = ["install", "repair", "start", "stop", "restart", "sync"]
        .includes(input?.operation);
      assertFocusedMainWindow(event, mutating);
      return requireManagedAppApi().invoke(input);
    },

    async updatesStatus(event) {
      assertFocusedMainWindow(event, false);
      const snapshot = typeof updateController?.getState === "function" ? updateController.getState() : null;
      return asRecord(snapshot);
    },

    async diagnosticsSnapshot(event) {
      assertFocusedMainWindow(event, false);
      const runtime = await this.runtimeStatus(event);
      return {
        runtime,
        workspaces: await listWorkspaceRecords(),
      };
    },

    async toolsCatalog(event, input) {
      assertFocusedMainWindow(event, false);
      const workspaceId = encodeURIComponent(input.workspaceId);
      return requestHeadless(`/api/v1/tools/catalog?workspace_id=${workspaceId}`, null, "GET");
    },

    async toolsCall(event, input) {
      assertFocusedMainWindow(event, true);
      return requestHeadless("/api/v1/tools/call", {
        request_id: text(input.requestId, `ui-${Date.now()}`),
        workspace_id: input.workspaceId,
        tool: input.tool,
        arguments: input.arguments ?? {},
      }, "POST");
    },
  };
}

module.exports = Object.freeze({
  createCodingToolsShellBridge,
  pageWorkspaces,
  toWorkspaceSummary,
});
