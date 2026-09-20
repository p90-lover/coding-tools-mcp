"use strict";

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toolName(entry) {
  if (typeof entry === "string") return entry.trim();
  const record = asRecord(entry);
  return String(record.name || record.tool || "").trim();
}

function mergeToolLists(...lists) {
  const seen = new Set();
  const tools = [];
  for (const list of lists) {
    for (const entry of asList(list)) {
      const name = toolName(entry);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (typeof entry === "string") {
        tools.push({ name: entry });
        continue;
      }
      tools.push({
        name,
        description: typeof recordDescription(entry) === "string" ? recordDescription(entry) : undefined,
        readOnly: entry.readOnly === true,
        via: typeof entry.via === "string" ? entry.via : undefined,
      });
    }
  }
  return tools;
}

function recordDescription(entry) {
  const record = asRecord(entry);
  return typeof record.description === "string" ? record.description : undefined;
}

module.exports = {
  id: "instant-mcp-tools",
  mergeToolLists,
  toolName,
};
