"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const PREFLIGHT_FAILURES = new Map([
  ["tunnel_owner_unknown", "Platform tunnel ownership is unknown. Open the intended Platform organization and retry."],
  ["tunnel_owner_mismatch", "The selected tunnel belongs to a different Platform user. Choose a tunnel created by the signed-in account."],
  ["platform_account_mismatch", "Platform authentication is different from the selected ChatGPT account. Sign in to the intended Platform account."],
  ["tunnel_permission_required", "Platform tunnel access requires read and use permissions in the selected organization."],
  ["workspace_context_unknown", "ChatGPT workspace context is unknown. Reload the intended workspace and retry."],
  ["workspace_access_denied", "ChatGPT workspace access was denied. Select an accessible workspace and retry."],
  ["workspace_context_changed", "The MCP account or workspace context changed. Retry in the intended workspace."],
  ["workspace_context_changed", "The MCP authentication or workspace context changed. Retry in the intended workspace."],
  ["workspace_context_changed", "ChatGPT authentication changed. Sign in to the intended account and retry."],
  ["workspace_context_changed", "The browser account changed during MCP setup."],
  ["workspace_context_changed", "The browser navigation changed during MCP context inspection."],
  ["owner_context_unavailable", "MCP ownership metadata is unavailable or exceeded its bound."],
  ["owner_context_unavailable", "MCP metadata inspection is unavailable in this browser window."],
  ["owner_context_unavailable", "MCP metadata inspection disconnected."],
  ["owner_context_unavailable", "MCP context inspection did not finish."],
  ["connector_identity_unverified", "Existing connector exact tunnel identity is unverified. Creation and connection were not attempted."],
  ["busy", "Browser account switching or shutdown is in progress"],
  ["creation_failed", "The account's MCP tunnel is not ready. Reconnect it before creating the connector."],
  ["creation_failed", "The account's MCP tunnel changed or is not ready."],
].map(([code, message]) => [message, { code, message }]));

function mcpConnectorCommandFailure(error, action = "create") {
  if (action === "add-tunnel") return { code: "tunnel_add_failed", message: "MCP tunnel connection failed. The private input was retained for retry." };
  const text = String(error?.message || error || "");
  const known = PREFLIGHT_FAILURES.get(text);
  if (known) return { ...known };
  const [code, message] = /denied access/i.test(text)
    ? ["mcp_access_denied", "The MCP server denied access. Check its authentication and workspace access."]
    : /verification|authenticate|sign.?in|cloudflare/i.test(text)
      ? ["verification_required", "ChatGPT verification is required in Coding Tools Browser."]
      : /busy|active.*turn|operation|switch|shutdown/i.test(text)
        ? ["busy", "Finish the active browser or setup operation before creating the connector."]
        : /too long|timed? out/i.test(text)
          ? ["timeout", "ChatGPT connector creation timed out."]
          : /active MCP configuration|saved automatic MCP harness|production profile/i.test(text)
            ? ["configuration_required", "Configure the saved automatic MCP harness first."]
            : ["creation_failed", "Connector creation failed. Check Configuration in Coding Tools."];
  return { code, message };
}

function mcpConnectorCommandAction(argv) {
  if (!Array.isArray(argv)) return null;
  if (argv.includes("--add-mcp-tunnel")) return "add-tunnel";
  if (argv.includes("--open-primary-mcp-tunnel-settings")) return "primary-tunnel-settings";
  if (argv.includes("--open-mcp-tunnel-settings")) return "tunnel-settings";
  return argv.includes("--create-mcp-connector") ? "create" : null;
}

function isMcpConnectorCommand(argv) {
  return mcpConnectorCommandAction(argv) !== null;
}

function createMcpConnectorCommand({ app, run, logger }) {
  const reportFile = path.join(app.getPath("userData"), "mcp-connector-command.json");
  let inFlight = null;
  let inFlightAction = null;
  const begin = (action = "create") => ({ version: 1, id: randomUUID(), pid: process.pid, action,
    appVersion: app.getVersion(), startedAt: new Date().toISOString() });
  const save = report => writePrivateFileAtomic(reportFile, JSON.stringify(report));
  return {
    request(action = "create") {
      if (!["create", "tunnel-settings", "primary-tunnel-settings", "add-tunnel"].includes(action)) return Promise.reject(new Error("Invalid MCP command action"));
      if (inFlight) return action === inFlightAction ? inFlight : Promise.reject(new Error("MCP setup is busy with another action"));
      const operation = begin(action);
      try {
        save({ ...operation, status: "running" });
      } catch (error) {
        return Promise.reject(error);
      }
      inFlightAction = action;
      inFlight = Promise.resolve().then(() => run(action)).then(result => {
        save({ ...operation, status: "completed", finishedAt: new Date().toISOString(), result: action === "add-tunnel" ? {
          added: result.added === true,
        } : action !== "create" ? {
          opened: result.opened === true,
          name: String(result.name || "").slice(0, 120),
        } : {
          created: result.created === true,
          name: String(result.name || "").slice(0, 120),
          href: String(result.href || "").slice(0, 512),
        } });
        return result;
      }).catch(error => {
        // Keep arbitrary errors, filesystem paths and credentials out of the automation receipt.
        const failure = mcpConnectorCommandFailure(error, action);
        logger?.warn("mcp.connector_creation_failed", failure);
        save({ ...operation, status: "failed", finishedAt: new Date().toISOString(), error: failure });
        throw error;
      }).finally(() => { inFlight = null; inFlightAction = null; });
      return inFlight;
    },
    failStartup(action = "create") {
      save({ ...begin(action), status: "failed", finishedAt: new Date().toISOString(),
        error: { code: "startup_failed", message: "Coding Tools could not finish starting. Check its local launcher log." } });
    },
  };
}

module.exports = { isMcpConnectorCommand, mcpConnectorCommandAction, createMcpConnectorCommand, mcpConnectorCommandFailure };
