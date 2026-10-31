"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writePrivateFileAtomic, writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

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
        const text = String(error?.message || error || "");
        const [code, message] = action === "add-tunnel"
          ? ["tunnel_add_failed", "MCP tunnel connection failed. The private input was retained for retry."]
          : /denied access/i.test(text)
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
        logger?.warn("mcp.connector_creation_failed", { code, message: action === "add-tunnel" ? message : text });
        await save({ ...operation, status: "failed", finishedAt: new Date().toISOString(), error: { code, message } });
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

module.exports = { isMcpConnectorCommand, mcpConnectorCommandAction, createMcpConnectorCommand };
