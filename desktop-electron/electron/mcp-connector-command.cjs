"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writePrivateFileAtomic, writePrivateFileAtomicAsync } = require("./atomic-file.cjs");
const { SETUP_CHECK_MESSAGE } = require("./chatgpt-cloudflare-check.cjs");

const PREFLIGHT_FAILURES = new Map([
  ["manual_browser_inspection_disabled", "MCP connector setup is disabled in Zero Risk mode."],
  ["workspace_owner_required", "Only a verified owner of this ChatGPT workspace can create its MCP connector. Add or sign in to the workspace owner account, refresh its workspace details, then retry."],
  ["workspace_publish_required", "The workspace owner created the MCP connector, but ChatGPT did not make it available to this member. Publish the connector in that workspace's app settings, then retry."],
  ["workspace_admin_required", "No signed-in owner or admin of this ChatGPT workspace was found. Add or sign in to that workspace's owner/admin account in Browser Management, then retry."],
  ["workspace_publish_required", "The workspace admin created the MCP connector, but ChatGPT did not make it available to this member. Publish the connector in that workspace's app settings, then retry."],
  ["workspace_publish_required", "ChatGPT did not confirm workspace publication."],
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
  ["verification_required", SETUP_CHECK_MESSAGE],
].map(([code, message]) => [message, { code, message }]));

// The setup's own words for the ChatGPT page step that did not happen. Each names what to look at,
// where the catch-all "Connector creation failed" named nothing: on 2026-11-09 every Connect
// showed that line while the real cause was "ChatGPT did not confirm the selected workspace."
// Only these exact texts pass; anything else could carry the page's own words.
const CHATGPT_PAGE_FAILURES = new Set([
  "ChatGPT did not confirm the selected workspace.",
  "ChatGPT did not confirm connector creation.",
  "ChatGPT did not confirm the exact connector consent.",
  "ChatGPT did not confirm the exact connector state.",
  "ChatGPT did not confirm this plugin connection.",
  "ChatGPT did not confirm the connector and target workspace for publishing.",
  "ChatGPT did not expose one Personal plugins tab.",
  "ChatGPT did not expose one Tunnel option.",
  "ChatGPT did not expose one enabled Create action.",
  "ChatGPT did not expose one matching workspace. Select it in that account and retry.",
  "ChatGPT did not expose one workspace menu.",
  "ChatGPT did not expose the exact workspace connector.",
  "ChatGPT did not expose the name and Tunnel ID fields.",
  "ChatGPT did not expose the target workspace name.",
  "ChatGPT did not expose this plugin connection confirmation.",
  "ChatGPT did not finish loading this plugin connection.",
  "ChatGPT did not open its connector form.",
  "ChatGPT did not open its custom MCP server form.",
  "ChatGPT did not prepare the exact connector consent.",
  "ChatGPT did not prepare the exact tunnel connector.",
  "ChatGPT did not retain the configured connector values.",
]);

function mcpConnectorCommandFailure(error, action = "create") {
  if (action === "add-tunnel") return { code: "tunnel_add_failed", message: "MCP tunnel connection failed. The private input was retained for retry." };
  const text = String(error?.message || error || "");
  const known = PREFLIGHT_FAILURES.get(text);
  if (known) return { ...known };
  if (CHATGPT_PAGE_FAILURES.has(text)) return { code: "creation_failed", message: text };
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
  // The receipt is written off the main thread, one write at a time in the order asked: the
  // synchronous write held every window 9.4 s on the busy hard disk (2026-10-31). A request settles
  // only once its receipt is written, so whoever reads it after the request sees the outcome.
  let writes = Promise.resolve();
  const save = report => (writes = writes.catch(() => undefined)
    .then(() => writePrivateFileAtomicAsync(reportFile, JSON.stringify(report))));
  return {
    /** Resolves once every receipt asked for so far is written (or failed to be). */
    written: () => writes.then(() => undefined, () => undefined),
    /**
     * `source`: what asked ("settings": the main window's button, "command": a launch with one of
     * the MCP flags). Logged with the outcome: three failed connector attempts on 2026-10-31 left no
     * trace of who started them, or whether any had succeeded.
     */
    request(action = "create", source = "unknown") {
      if (!["create", "tunnel-settings", "primary-tunnel-settings", "add-tunnel"].includes(action)) return Promise.reject(new Error("Invalid MCP command action"));
      if (inFlight) {
        if (action !== inFlightAction) return Promise.reject(new Error("MCP setup is busy with another action"));
        logger?.info?.("mcp.command_requested", { action, source, joined: true });
        return inFlight;
      }
      logger?.info?.("mcp.command_requested", { action, source });
      const operation = begin(action);
      inFlightAction = action;
      // A receipt that cannot be written refuses the request before it runs, as before.
      inFlight = save({ ...operation, status: "running" }).then(() => Promise.resolve().then(() => run(action)).then(async result => {
        await save({ ...operation, status: "completed", finishedAt: new Date().toISOString(), result: action === "add-tunnel" ? {
          added: result.added === true,
        } : action !== "create" ? {
          opened: result.opened === true,
          name: String(result.name || "").slice(0, 120),
        } : {
          created: result.created === true,
          name: String(result.name || "").slice(0, 120),
          href: String(result.href || "").slice(0, 512),
        } });
        logger?.info?.("mcp.command_completed", { action, source, ...(action === "create" ? { created: result.created === true } : {}) });
        return result;
      }).catch(async error => {
        // Keep arbitrary errors, filesystem paths and credentials out of the automation receipt.
        const failure = mcpConnectorCommandFailure(error, action);
        logger?.warn("mcp.connector_creation_failed", failure);
        await save({ ...operation, status: "failed", finishedAt: new Date().toISOString(), error: failure });
        throw error;
      })).finally(() => { inFlight = null; inFlightAction = null; });
      return inFlight;
    },
    /** Written before returning: the app quits right after a failed start. */
    failStartup(action = "create") {
      writePrivateFileAtomic(reportFile, JSON.stringify({ ...begin(action), status: "failed", finishedAt: new Date().toISOString(),
        error: { code: "startup_failed", message: "Coding Tools could not finish starting. Check its local launcher log." } }));
    },
  };
}

module.exports = { isMcpConnectorCommand, mcpConnectorCommandAction, createMcpConnectorCommand, mcpConnectorCommandFailure };
