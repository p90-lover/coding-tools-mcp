"use strict";

const { createHash } = require("node:crypto");

const CHECKS = new Set([
  "config", "browser-host", "chrome", "login", "codex", "service", "proxy",
  "tunnel-binary", "tunnel-key", "tunnel-service", "tunnel-runtime", "connector", "tools",
  "runtime", "dev-profile", "dev-tunnel-credentials", "dev-tunnel-runtime", "responses-listener",
]);
const MODULES = new Set(["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]);
const CHECK_STATES = new Set(["ok", "warning", "error"]);
const INSTALL_STATES = new Set(["installed", "not-installed", "repair-required", "error"]);

function repairFacts({ workspaceId, doctor, services, bridge } = {}) {
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(workspaceId)) {
    throw new Error("A valid workspace ID is required");
  }
  const checks = (Array.isArray(doctor?.checks) ? doctor.checks : [])
    .filter((row) => CHECKS.has(row?.id) && CHECK_STATES.has(row?.status))
    .map(({ id, status }) => ({ id, status }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 32);
  const modules = (Array.isArray(services?.services) ? services.services : [])
    .filter((row) => MODULES.has(row?.id) && INSTALL_STATES.has(row?.managedInstall?.state))
    .map(({ id, managedInstall, status }) => ({
      id, installState: managedInstall.state, running: status === "ready",
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 16);
  const activeTurns = Number.isInteger(bridge?.activeTurns) && bridge.activeTurns >= 0
    ? Math.min(bridge.activeTurns, 1000)
    : null;
  const facts = {
    kind: "coding_tools_repair",
    workspaceId,
    checks,
    modules,
    bridge: { installed: bridge?.installed === true, active: bridge?.active === true, activeTurns },
  };
  return {
    ...facts,
    revision: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  };
}

module.exports = { repairFacts };
