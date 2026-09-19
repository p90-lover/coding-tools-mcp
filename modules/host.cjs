"use strict";

const { sanitizePublic } = require("./lib/sanitize.cjs");
const { defaultRegistry } = require("./handler-registry.cjs");

const MODULE_IDS = Object.freeze([
  "cpa",
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);

function createCodingToolsAppsHost({
  services = null,
  actUpstream = null,
  getFiveStack = () => ({ ok: false }),
  registry = defaultRegistry,
} = {}) {
  function contextFor(moduleId) {
    return {
      services,
      act: actUpstream,
      actUpstream,
      inspect: typeof services?.inspect === "function"
        ? () => services.inspect(moduleId)
        : undefined,
      getFiveStack,
    };
  }

  function requireId(moduleId) {
    const id = String(moduleId || "").trim();
    if (!registry.has(id)) throw new Error(`Unknown Coding Tools module: ${id || "missing"}`);
    return id;
  }

  function list() {
    return {
      version: 1,
      host: "coding-tools-apps",
      transport: "in-process",
      modules: MODULE_IDS.filter((id) => registry.has(id)).map((id) => {
        const snap = registry.snapshot(id);
        return {
          id,
          name: snap?.name || id,
          transport: snap?.transport || "in-process",
          legacyLoopback: snap?.legacyLoopback || null,
          operations: registry.operations(id),
        };
      }),
    };
  }

  function catalog() {
    const listed = list();
    return {
      ...listed,
      modules: listed.modules.map((entry) => ({
        ...entry,
        operations: registry.operations(entry.id).map((name) => ({
          name,
          readOnly: isReadOnly(entry.id, name),
          description: "",
        })),
      })),
    };
  }

  function isReadOnly(moduleId, operation) {
    const handler = registry.get(moduleId)?.handler;
    if (typeof handler?.isReadOnly === "function") return handler.isReadOnly(operation);
    return false;
  }

  async function call(moduleId, operation, args = {}) {
    const id = requireId(moduleId);
    const result = await registry.invoke(id, String(operation || ""), args, contextFor(id));
    return sanitizePublic({
      ok: result?.ok !== false,
      moduleId: id,
      handle: id,
      operation: String(operation || ""),
      transport: "in-process",
      result,
    });
  }

  async function invoke(input = {}) {
    const id = input.handle || input.moduleId;
    return call(id, input.operation, input.arguments || {});
  }

  return Object.freeze({
    list,
    catalog,
    call,
    invoke,
    isReadOnly,
    moduleIds: MODULE_IDS.slice(),
    transport: "in-process",
  });
}

module.exports = {
  MODULE_IDS,
  createCodingToolsAppsHost,
};
