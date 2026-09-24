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
    const base = services && typeof services === "object" ? services : {};
    return {
      services: {
        ...base,
        loopbackRequest: () => (
          typeof base.loopbackRequest === "function" ? base.loopbackRequest(moduleId) : null
        ),
        explainEmptyModels: (details) => (
          typeof base.explainEmptyModels === "function"
            ? base.explainEmptyModels(moduleId, details)
            : null
        ),
        providerCatalog: () => (
          typeof base.providerCatalog === "function" ? base.providerCatalog(moduleId) : null
        ),
      },
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

  function callInput(moduleId, operation, args) {
    if (moduleId && typeof moduleId === "object" && !Array.isArray(moduleId)) {
      const input = moduleId;
      return {
        moduleId: input.moduleId || input.handle,
        operation: input.operation,
        args: input.arguments || input.args || {},
      };
    }
    return { moduleId, operation, args: args || {} };
  }

  function list() {
    return {
      version: 1,
      host: "coding-tools-apps",
      transport: "in-process",
      launchOrder: typeof registry.launchOrder === "function"
        ? registry.launchOrder().filter((id) => MODULE_IDS.includes(id))
        : MODULE_IDS.filter((id) => registry.has(id)),
      modules: MODULE_IDS.filter((id) => registry.has(id)).map((id) => {
        const snap = registry.snapshot(id);
        return {
          id,
          name: snap?.name || id,
          kind: snap?.kind || "managed-service",
          transport: snap?.transport || "in-process",
          legacyLoopback: snap?.legacyLoopback || null,
          launch: snap?.launch || null,
          visual: snap?.visual || null,
          operations: registry.operations(id),
        };
      }),
    };
  }

  function catalog() {
    const listed = list();
    return {
      ...listed,
      modules: listed.modules.map((entry) => {
        const handler = registry.get(entry.id)?.handler;
        const specs = Array.isArray(handler?.module?.operations) ? handler.module.operations : [];
        const byName = new Map(specs.map((spec) => [spec.name, spec]));
        return {
          ...entry,
          operations: registry.operations(entry.id).map((name) => ({
            name,
            readOnly: isReadOnly(entry.id, name),
            description: byName.get(name)?.description || "",
          })),
        };
      }),
    };
  }

  function isReadOnly(moduleId, operation) {
    const input = callInput(moduleId, operation);
    const handler = registry.get(input.moduleId)?.handler;
    if (typeof handler?.isReadOnly === "function") return handler.isReadOnly(input.operation);
    return false;
  }

  async function call(moduleId, operation, args = {}) {
    const input = callInput(moduleId, operation, args);
    const id = requireId(input.moduleId);
    const op = String(input.operation || "");
    const result = await registry.invoke(id, op, input.args, contextFor(id));
    return sanitizePublic({
      ok: result?.ok !== false,
      moduleId: id,
      handle: id,
      operation: op,
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
