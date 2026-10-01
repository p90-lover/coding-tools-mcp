"use strict";

const { randomUUID } = require("node:crypto");

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

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
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
  const linked = record.linkedProjects ?? record.linked_projects;
  const linkedProjects = Array.isArray(linked) ? linked.flatMap((candidate) => {
    const project = asRecord(candidate);
    const alias = text(project.alias);
    const path = text(project.path);
    return alias && path ? [{ alias, name: text(project.name, alias), path, mode: text(project.mode, "read-only") }] : [];
  }) : [];
  return {
    id,
    name,
    path: pathValue,
    linkedProjects,
    mcpState: boundedMcpState(record.mcpState || record.mcp_state),
    policyRevision: Number.isInteger(record.policyRevision)
      ? record.policyRevision
      : Number.isInteger(record.policy_revision)
        ? record.policy_revision
        : index,
    permissionMode: text(record.permissionMode, text(record.permission_mode, "unknown")),
    approvalMode: text(record.approvalMode, text(record.approval_mode, "unknown")),
    toolProfile: text(record.toolProfile, text(record.tool_profile, "unknown")),
    mcpAuthType: text(record.mcpAuthType, text(record.mcp_auth_type, "unknown")),
    actionsAuthType: text(record.actionsAuthType, text(record.actions_auth_type, "unknown")),
    mcpLocalPort: Number.isInteger(record.mcpLocalPort) ? record.mcpLocalPort
      : Number.isInteger(record.mcp_local_port) ? record.mcp_local_port : null,
    actionsLocalPort: Number.isInteger(record.actionsLocalPort) ? record.actionsLocalPort
      : Number.isInteger(record.actions_local_port) ? record.actions_local_port : null,
    screenCaptureEnabled: typeof record.screenCaptureEnabled === "boolean" ? record.screenCaptureEnabled
      : typeof record.screen_capture_enabled === "boolean" ? record.screen_capture_enabled : null,
    mcpOAuthClientId: text(record.mcpOAuthClientId, text(record.mcp_oauth_client_id)),
    mcpOAuthRedirectUris: strings(record.mcpOAuthRedirectUris ?? record.mcp_oauth_redirect_uris),
    mcpUseSharedSecrets: typeof record.mcpUseSharedSecrets === "boolean" ? record.mcpUseSharedSecrets
      : typeof record.mcp_use_shared_secrets === "boolean" ? record.mcp_use_shared_secrets : null,
    actionsOAuthClientId: text(record.actionsOAuthClientId, text(record.actions_oauth_client_id)),
    actionsOAuthRedirectUris: strings(record.actionsOAuthRedirectUris ?? record.actions_oauth_redirect_uris),
    actionsOAuthScopes: text(record.actionsOAuthScopes, text(record.actions_oauth_scopes)),
    actionsUseSharedSecrets: typeof record.actionsUseSharedSecrets === "boolean" ? record.actionsUseSharedSecrets
      : typeof record.actions_use_shared_secrets === "boolean" ? record.actions_use_shared_secrets : null,
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
  headlessHost = null,
  updateController = null,
  getHeadlessHost,
  getUpdateController,
} = {}) {
  const resolveHost = () => (
    typeof getHeadlessHost === "function" ? getHeadlessHost() : headlessHost
  );
  const resolveUpdater = () => (
    typeof getUpdateController === "function" ? getUpdateController() : updateController
  );
  const requireHost = () => {
    const host = resolveHost();
    if (!host) throw new Error("Local Coding Tools service is unavailable");
    return host;
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

    async listTasks(event, input) {
      assertFocusedMainWindow(event, false);
      const workspaceId = text(input.workspaceId);
      if (!workspaceId) throw new Error("Workspace is required");
      const offset = Number.isInteger(input.cursor) && input.cursor > 0 ? input.cursor : 0;
      const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 25;
      const payload = await requestHeadless("/api/v1/tools/call", {
        request_id: `tasks-${randomUUID()}`,
        workspace_id: workspaceId,
        tool: "workflow_list",
        arguments: { offset, limit, include_archived: false },
      }, "POST");
      const operation = asRecord(payload?.operation);
      const result = asRecord(operation.result);
      if (operation.state !== "completed" || result.ok !== true) {
        throw new Error(text(operation.error, text(result.summary, "Task list is unavailable")));
      }
      if (!Array.isArray(result.tasks) || !Number.isInteger(result.revision)) {
        throw new Error("Task list returned an invalid durable workflow page");
      }
      return {
        items: result.tasks.flatMap((candidate) => {
          const row = asRecord(candidate);
          const id = text(row.id);
          if (!id) return [];
          return [{
            id,
            title: text(row.title, id),
            description: text(row.description),
            state: text(row.state, "unknown"),
          }];
        }),
        nextCursor: Number.isInteger(result.next_offset) ? result.next_offset : null,
        revision: result.revision,
      };
    },

    async searchHistory(event) {
      assertFocusedMainWindow(event, false);
      return emptyPage();
    },

    async nativeCodexStatus(event, input = {}) {
      assertFocusedMainWindow(event, false);
      const workspaceId = text(input.workspaceId);
      if (workspaceId) {
        return requestHeadless("/api/v1/native-codex/status", { workspace_id: workspaceId }, "POST");
      }
      const runtime = await this.runtimeStatus(event);
      return {
        available: runtime.ready === true,
        ready: runtime.ready === true,
      };
    },

    async integrationsSnapshot(event) {
      assertFocusedMainWindow(event, false);
      return {
        available: false,
        reason: "Paseo, Anneal, and provider integrations are owned by sibling Desktop panels.",
      };
    },

    async updatesStatus(event) {
      assertFocusedMainWindow(event, false);
      const updater = resolveUpdater();
      const snapshot = typeof updater?.getState === "function" ? updater.getState() : null;
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
