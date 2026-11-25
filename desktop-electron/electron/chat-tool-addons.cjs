"use strict";

const RECENT_LIMIT = 128;
const REPEAT_MS = 60_000;

function createChatToolRegistry(addons) {
  const owners = new Map();
  for (const [addon, names] of Object.entries(addons)) {
    for (const name of names) {
      if (!owners.has(name)) owners.set(name, []);
      owners.get(name).push(addon);
    }
  }
  const conflicts = [];
  for (const [capability, [existing, ...others]] of owners) {
    for (const addon of others) conflicts.push({ kind: "tool_group", addon, existing, capability });
  }
  const groupOf = name => {
    const groups = owners.get(name);
    return groups?.length === 1 ? groups[0] : null;
  };
  return Object.freeze({ groups: Object.freeze(Object.keys(addons)), groupOf, conflicts: Object.freeze(conflicts) });
}

function collectChatAddonTools({ registry, headless, local, reserved, allowed, report }) {
  const visible = new Map();
  for (const [origin, tools] of [["headless", headless], ["app", local]]) {
    for (const tool of Array.isArray(tools) ? tools : []) {
      const name = tool?.name;
      const addon = registry.groupOf(name);
      if (!addon || !allowed(name, addon) || (origin === "headless" && reserved.has(name))) continue;
      if (visible.has(name)) {
        report({ kind: "tool_definition", addon, existing: origin === "headless" ? "headless-catalog" : "app-catalog", capability: name });
        continue;
      }
      visible.set(name, tool);
    }
  }
  return [...visible.values()];
}

function createChatAddonConflictReporter(logger, now = Date.now) {
  const recent = new Map();
  return ({ kind, addon, existing, capability }) => {
    const warn = logger?.warnInMemory;
    if (typeof warn !== "function") return;
    const key = JSON.stringify([kind, addon, existing, capability]);
    const timestamp = now();
    if (recent.has(key) && timestamp - recent.get(key) < REPEAT_MS) return;
    recent.delete(key);
    recent.set(key, timestamp);
    if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value);
    try { warn.call(logger, "chat_addons.conflict", { kind, addon, existing, capability }); } catch { /* diagnostics must not block a chat */ }
  };
}

module.exports = Object.freeze({ createChatToolRegistry, collectChatAddonTools, createChatAddonConflictReporter });
