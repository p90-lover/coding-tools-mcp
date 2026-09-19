"use strict";

function wrapServices(moduleId, ctx) {
  if (ctx.services && typeof ctx.services === "object") return ctx.services;
  const inspect = ctx.inspect;
  return {
    inspect: typeof inspect === "function"
      ? async (id) => inspect(id || moduleId)
      : undefined,
    start: ctx.start,
    stop: ctx.stop,
    restart: ctx.restart,
    repair: ctx.repair,
    syncCodexRouter: ctx.syncCodexRouter,
    commandCodeProxyPlan: ctx.commandCodeProxyPlan,
    applyCommandCodeProxyPlan: ctx.applyCommandCodeProxyPlan,
    loopbackRequest: ctx.loopbackRequest,
    listProviders: ctx.listProviders,
    linkProvider: ctx.linkProvider,
    unlinkProvider: ctx.unlinkProvider,
    providerStatus: ctx.providerStatus,
    providerCatalog: ctx.providerCatalog,
    explainEmptyModels: ctx.explainEmptyModels,
  };
}

function wrapInProcessHandler(createModule) {
  const mod = createModule();
  return Object.freeze({
    id: mod.id,
    operations: Object.freeze(mod.operations.map((entry) => entry.name)),
    isReadOnly: (operation) => mod.isReadOnly(operation),
    module: mod,
    async invoke(operation, args = {}, ctx = {}) {
      try {
        const result = await mod.call(operation, args, {
          services: wrapServices(mod.id, ctx),
          actUpstream: ctx.act || ctx.actUpstream,
          getFiveStack: ctx.getFiveStack,
          loopback: mod.loopback,
        });
        if (result && typeof result === "object") {
          return { transport: "in-process", ok: result.ok !== false, ...result };
        }
        return { transport: "in-process", ok: true, result };
      } catch (error) {
        return {
          ok: false,
          op: operation,
          transport: "in-process",
          softFail: true,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

module.exports = { wrapInProcessHandler };
