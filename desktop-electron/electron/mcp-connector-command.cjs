"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

function isMcpConnectorCommand(argv) {
  return Array.isArray(argv) && argv.includes("--create-mcp-connector");
}

function createMcpConnectorCommand({ app, run }) {
  const reportFile = path.join(app.getPath("userData"), "mcp-connector-command.json");
  let inFlight = null;
  const begin = () => ({ version: 1, id: randomUUID(), pid: process.pid,
    appVersion: app.getVersion(), startedAt: new Date().toISOString() });
  const save = report => writePrivateFileAtomic(reportFile, JSON.stringify(report));
  return {
    request() {
      if (inFlight) return inFlight;
      const operation = begin();
      try {
        save({ ...operation, status: "running" });
      } catch (error) {
        return Promise.reject(error);
      }
      inFlight = Promise.resolve().then(run).then(result => {
        save({ ...operation, status: "completed", finishedAt: new Date().toISOString(), result: {
          created: result.created === true,
          name: String(result.name || "").slice(0, 120),
          href: String(result.href || "").slice(0, 512),
        } });
        return result;
      }).catch(error => {
        // Keep arbitrary errors, filesystem paths and credentials out of the automation receipt.
        const text = String(error?.message || "");
        const [code, message] = /denied access/i.test(text)
          ? ["mcp_access_denied", "The MCP server denied access. Check its authentication and workspace access."]
          : /verification|authenticate|sign.?in|cloudflare/i.test(text)
            ? ["verification_required", "ChatGPT verification is required in Coding Tools Browser."]
            : /busy|active.*turn|operation|switch|shutdown/i.test(text)
              ? ["busy", "Finish the active browser or setup operation before creating the connector."]
              : /too long|timed? out/i.test(text)
                ? ["timeout", "ChatGPT connector creation timed out."]
                : /configuration|automatic MCP harness|tunnel ID|production profile/i.test(text)
                  ? ["configuration_required", "Configure the saved automatic MCP harness first."]
                  : ["creation_failed", "Connector creation failed. Check Configuration in Coding Tools."];
        save({ ...operation, status: "failed", finishedAt: new Date().toISOString(), error: { code, message } });
        throw error;
      }).finally(() => { inFlight = null; });
      return inFlight;
    },
    failStartup() {
      save({ ...begin(), status: "failed", finishedAt: new Date().toISOString(),
        error: { code: "startup_failed", message: "Coding Tools could not finish starting. Check its local launcher log." } });
    },
  };
}

module.exports = { isMcpConnectorCommand, createMcpConnectorCommand };
