"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MODULES_ROOT = __dirname;
const FOREIGN_SLOTS = Object.freeze(["cpa", "codex-router"]);
const CORE_OPERATIONS = Object.freeze([
  "inspect",
  "install",
  "repair",
  "start",
  "stop",
  "restart",
  "providers",
  "plan",
  "sync",
  "ui-inspect",
  "ui-start",
  "ui-stop",
  "ui-restart",
  "ui-open",
  "registration-plan",
  "registration-apply",
  "open",
  "act",
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadModules() {
  const loaded = Object.create(null);
  if (!fs.existsSync(MODULES_ROOT)) return loaded;
  for (const entry of fs.readdirSync(MODULES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const moduleJsonPath = path.join(MODULES_ROOT, id, "module.json");
    const handlerPath = path.join(MODULES_ROOT, id, "handler.cjs");
    if (!fs.existsSync(moduleJsonPath) || !fs.existsSync(handlerPath)) continue;
    const moduleJson = readJson(moduleJsonPath);
    if (typeof moduleJson.id !== "string" || moduleJson.id !== id) {
      throw new Error(`Module folder ${id} must declare matching module.json id`);
    }
    const handler = require(handlerPath);
    const operations = Array.isArray(handler.operations)
      ? handler.operations.filter((value) => typeof value === "string")
      : [];
    loaded[id] = Object.freeze({
      id,
      root: path.posix.join("app-handler", id),
      moduleJson: Object.freeze(moduleJson),
      operations: Object.freeze(operations),
      handler,
      foreign: FOREIGN_SLOTS.includes(id),
    });
  }
  return Object.freeze(loaded);
}

function createHandlerRegistry(loaded = loadModules()) {
  return Object.freeze({
    root: "app-handler",
    foreignSlots: FOREIGN_SLOTS,
    ids() {
      return Object.keys(loaded);
    },
    has(id) {
      return Boolean(loaded[id]);
    },
    get(id) {
      return loaded[id] || null;
    },
    operations(id) {
      return loaded[id] ? [...loaded[id].operations] : [];
    },
    ownsOperation(id, operation) {
      return Boolean(loaded[id]?.operations.includes(operation));
    },
    snapshot(id) {
      const current = loaded[id];
      if (!current) return null;
      return Object.freeze({
        id: current.id,
        root: current.root,
        name: current.moduleJson.name || current.id,
        functions: [...current.operations],
        transport: current.moduleJson.transport || "in-process",
        legacyLoopback: current.moduleJson.legacyLoopback || null,
        source: current.moduleJson.source || null,
      });
    },
    async invoke(id, operation, args, ctx) {
      const current = loaded[id];
      if (!current) throw new Error(`No in-repo module is registered for ${id}`);
      if (!current.operations.includes(operation)) {
        throw new Error(`${id} module does not expose ${operation}`);
      }
      if (typeof current.handler.invoke !== "function") {
        throw new Error(`${id} module handler is missing invoke`);
      }
      return current.handler.invoke(operation, args || {}, ctx || {});
    },
  });
}

const defaultRegistry = createHandlerRegistry();

module.exports = Object.freeze({
  MODULES_ROOT,
  FOREIGN_SLOTS,
  CORE_OPERATIONS,
  loadModules,
  createHandlerRegistry,
  defaultRegistry,
});
