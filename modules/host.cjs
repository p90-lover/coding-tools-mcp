"use strict";

const http = require("node:http");
const { sanitizePublic } = require("./lib/sanitize.cjs");

const MODULE_IDS = Object.freeze([
  "cpa",
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);

const LOADERS = Object.freeze({
  cpa: () => require("./cpa/handlers.cjs").createModule(),
  "codex-router": () => require("./codex-router/handlers.cjs").createModule(),
  "commandcode-proxy": () => require("./commandcode-proxy/handlers.cjs").createModule(),
  paseo: () => require("./paseo/handlers.cjs").createModule(),
  anneal: () => require("./anneal/handlers.cjs").createModule(),
});

function createCodingToolsAppsHost({
  services = null,
  actUpstream = null,
  getFiveStack = () => ({ ok: false }),
} = {}) {
  const modules = new Map(MODULE_IDS.map((id) => [id, LOADERS[id]()]));

  function contextFor(mod) {
    return {
      services,
      actUpstream,
      getFiveStack,
      loopback: mod.loopback,
    };
  }

  function requireModule(moduleId) {
    const id = String(moduleId || "").trim();
    const mod = modules.get(id);
    if (!mod) throw new Error(`Unknown Coding Tools module: ${id || "missing"}`);
    return mod;
  }

  function list() {
    return {
      version: 1,
      host: "coding-tools-apps",
      modules: MODULE_IDS.map((id) => {
        const mod = modules.get(id);
        return {
          id: mod.id,
          name: mod.name,
          loopback: mod.loopback,
          operations: mod.operations.map((entry) => entry.name),
        };
      }),
    };
  }

  function catalog() {
    return {
      version: 1,
      host: "coding-tools-apps",
      modules: MODULE_IDS.map((id) => {
        const mod = modules.get(id);
        return {
          id: mod.id,
          name: mod.name,
          loopback: mod.loopback,
          operations: mod.operations.slice(),
        };
      }),
    };
  }

  function isReadOnly(moduleId, operation) {
    return requireModule(moduleId).isReadOnly(operation);
  }

  async function call(moduleId, operation, args = {}) {
    const mod = requireModule(moduleId);
    const result = await mod.call(operation, args, contextFor(mod));
    return sanitizePublic({
      ok: result?.ok !== false,
      moduleId: mod.id,
      operation: String(operation || ""),
      result,
    });
  }

  function listenLoopback({ host = "127.0.0.1", port = 0 } = {}) {
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new Error("Apps loopback HTTP is restricted to 127.0.0.1");
    }
    const server = http.createServer(async (request, response) => {
      const write = (status, body) => {
        const payload = JSON.stringify(body);
        response.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload),
        });
        response.end(payload);
      };
      try {
        const url = new URL(request.url || "/", `http://${host}`);
        if (request.method === "GET" && url.pathname === "/api/v1/apps") return write(200, list());
        if (request.method === "GET" && url.pathname === "/api/v1/apps/catalog") return write(200, catalog());
        if (request.method === "POST" && url.pathname === "/api/v1/apps/call") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          const output = await call(input.moduleId || input.module, input.operation, input.arguments || {});
          return write(200, output);
        }
        return write(404, { ok: false, error: "Unknown apps route" });
      } catch (error) {
        return write(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    return {
      server,
      listen() {
        return new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, () => {
            const address = server.address();
            resolve({
              host,
              port: address && typeof address === "object" ? address.port : port,
              close: () => new Promise((done, fail) => server.close((err) => err ? fail(err) : done())),
            });
          });
        });
      },
    };
  }

  return Object.freeze({
    list,
    catalog,
    call,
    isReadOnly,
    listenLoopback,
    moduleIds: MODULE_IDS.slice(),
  });
}

module.exports = {
  MODULE_IDS,
  createCodingToolsAppsHost,
};
