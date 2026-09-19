"use strict";

const { defineModule } = require("../lib/define-module.cjs");
const { openaiOperations } = require("../lib/openai.cjs");
const { sanitizePublic } = require("../lib/sanitize.cjs");

const LOOPBACK = Object.freeze({
  origin: "http://127.0.0.1:9090/",
  openai: "http://127.0.0.1:9090/v1",
});

function createModule() {
  const extraOperations = {
    ...openaiOperations((context) => context.loopback?.origin || LOOPBACK.origin),
    plan: {
      readOnly: true,
      description: "Preview the CommandCode proxy plan through Coding Tools. No standalone GUI.",
      run: async (args, context) => {
        if (typeof context.services?.commandCodeProxyPlan !== "function") {
          throw new Error("CommandCode plan is unavailable");
        }
        return sanitizePublic(await context.services.commandCodeProxyPlan(args));
      },
    },
    applyPlan: {
      readOnly: false,
      description: "Apply a CommandCode proxy plan through Coding Tools.",
      run: async (args, context) => {
        if (typeof context.services?.applyCommandCodeProxyPlan !== "function") {
          throw new Error("CommandCode applyPlan is unavailable");
        }
        return sanitizePublic(await context.services.applyCommandCodeProxyPlan(args));
      },
    },
  };
  extraOperations.banner = extraOperations.health;
  extraOperations["registration-plan"] = extraOperations.plan;
  extraOperations["registration-apply"] = extraOperations.applyPlan;
  return defineModule({
    id: "commandcode-proxy",
    name: "CommandCode Proxy",
    loopback: LOOPBACK,
    extraOperations,
  });
}

module.exports = { createModule, LOOPBACK };
