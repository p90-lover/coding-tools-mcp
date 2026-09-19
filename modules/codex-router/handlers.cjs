"use strict";

const { defineModule } = require("../lib/define-module.cjs");
const { openaiOperations } = require("../lib/openai.cjs");
const { sanitizePublic } = require("../lib/sanitize.cjs");

const LOOPBACK = Object.freeze({
  origin: "http://127.0.0.1:4202/",
  openai: "http://127.0.0.1:4202/v1",
});

function createModule() {
  return defineModule({
    id: "codex-router",
    name: "Codex Router",
    loopback: LOOPBACK,
    extraOperations: {
      ...openaiOperations((context) => context.loopback?.origin || LOOPBACK.origin),
      sync: {
        readOnly: false,
        description: "Sync the managed Codex Router runtime. Does not launch Control Center.",
        run: async (_args, context) => {
          if (typeof context.services?.syncCodexRouter !== "function") {
            throw new Error("Codex Router sync is unavailable");
          }
          return sanitizePublic(await context.services.syncCodexRouter());
        },
      },
    },
  });
}

module.exports = { createModule, LOOPBACK };
