"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const TOOL_NAMES = new Set(["Bash", "PowerShell"]);
const HARNESSES = new Set(["ao:claude-code", "ao:codex"]);
const COMMANDS = new Map([
  ["location", { title: "Show the current folder", commands: ["pwd", "Get-Location"] }],
  ["git-state", { title: "Inspect Git branch and repository root", commands: ["git symbolic-ref --quiet --short HEAD", "git rev-parse --show-toplevel"] }],
  ["versions", { title: "Check installed tool versions", commands: ["git --version", "node --version", "bun --version"] }],
]);
const ASK = Object.freeze({ action: "ask", unresolved: true, judged: true });

function acceptsAutobot(route) {
  return HARNESSES.has(route?.harness_id) && route.approval_policy === "on-request"
    && (route.approvals_reviewer ?? "user") === "user"
    && (route.native_permission_profile ?? route.permission_profile) === ":workspace";
}

function scopeKey(workspaceId, taskId) {
  const valid = (id) => typeof id === "string" && /^[a-z0-9_.:-]{1,128}$/i.test(id);
  if (!valid(workspaceId) || !valid(taskId)) throw new Error("Open an existing chat to configure Autobot Roll Out.");
  return JSON.stringify([workspaceId, taskId]);
}

function createAutobotPermission() {
  const enabled = new Map();
  let revision = 0;
  const options = [...COMMANDS].map(([id, entry]) => ({ id, title: entry.title, commands: entry.commands }));
  function read(workspaceId, taskId) {
    const active = enabled.get(scopeKey(workspaceId, taskId));
    return { enabled: Boolean(active), selected: active?.selected ?? [], options, summary: active?.summary ?? "No commands preapproved." };
  }
  function describe(selected) {
    if (!Array.isArray(selected) || selected.length === 0 || selected.length > options.length
      || selected.some(id => typeof id !== "string" || !COMMANDS.has(id)) || new Set(selected).size !== selected.length) {
      throw new Error("Choose at least one of the listed read-only command groups.");
    }
    const commands = selected.flatMap(id => COMMANDS.get(id).commands);
    return { selected: [...selected], commands,
      summary: `In this chat’s working folder only: ${commands.join("; ")}. Nothing else is locally preapproved.` };
  }
  return {
    read, describe, revision: () => revision,
    get: (workspaceId, taskId) => {
      try { return enabled.get(scopeKey(workspaceId, taskId)) ?? null; } catch { return null; }
    },
    enable(workspaceId, taskId, selected) {
      const key = scopeKey(workspaceId, taskId);
      const info = describe(selected);
      if (!enabled.has(key) && enabled.size >= 200) throw new Error("Disable Autobot in another chat first.");
      enabled.set(key, { ...info, revision: ++revision });
      return read(workspaceId, taskId);
    },
    disable(workspaceId, taskId) {
      enabled.delete(scopeKey(workspaceId, taskId));
      revision += 1;
      return read(workspaceId, taskId);
    },
  };
}

async function matchLocalCommand(config, approval, root, realpath = fs.realpath) {
  if (!config.commands.includes(approval.command) || !TOOL_NAMES.has(approval.tool)
    || !approval.cwd || !path.isAbsolute(approval.cwd) || !path.isAbsolute(root || "")
    || approval.permissions || approval.toolInput || approval.path) return false;
  try {
    const [workdir, owned] = await Promise.all([realpath(approval.cwd), realpath(root)]);
    return path.relative(owned, workdir) === "";
  } catch { return false; }
}

async function reviewAutobot({ config, approval, hardDenial, incomplete, root, guardian, model, mayMeter }) {
  if (hardDenial) return hardDenial;
  if (incomplete || approval.source !== "ao" || !approval.thread_id || !approval.turn_id || approval.guardianRequiresHuman
    || approval.guardianUnsupported || !["command", "permission"].includes(approval.kind)) {
    return { ...ASK, reason: "This request needs your decision; Autobot cannot verify its full scope." };
  }
  if (approval.kind === "command" && config.commands.includes(approval.command)
    && await matchLocalCommand(config, approval, await root())) {
    return { action: "allow", actor: "autobot", reason_code: "autobot_local", reason: "Matches this chat’s confirmed Autobot command list." };
  }
  const verdict = await guardian();
  if (verdict?.action === "allow" || verdict?.action === "deny") return verdict;
  if (verdict?.guardianUnavailable !== true) return { ...ASK, reason: verdict?.reason || "Guardian did not confirm this action. Check it yourself." };
  if (!mayMeter()) return { ...ASK, quotaBlocked: true, reason: "Guardian is unavailable. Model Judge and quota-based reviews must both be on for fallback." };
  const fallback = await model();
  if (mayMeter() && (fallback?.action === "allow" || fallback?.action === "deny")) return { ...fallback, autobotMetered: true };
  return { ...ASK, reason: "The model reviewer did not confirm this request. Check it yourself." };
}

module.exports = { acceptsAutobot, createAutobotPermission, reviewAutobot };
