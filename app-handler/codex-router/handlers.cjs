"use strict";

const { defineModule } = require("../lib/define-module.cjs");
const { openaiOperations } = require("../lib/openai.cjs");
const { sanitizePublic } = require("../lib/sanitize.cjs");

const LOOPBACK = Object.freeze({
  origin: "http://127.0.0.1:4202/",
  openai: "http://127.0.0.1:4202/v1",
});

function getOrigin(context) {
  return context.loopback?.origin || LOOPBACK.origin;
}

function createModule() {
  return defineModule({
    id: "codex-router",
    name: "Codex Router",
    loopback: LOOPBACK,
    extraOperations: {
      ...openaiOperations(getOrigin),
      sync: {
        readOnly: false,
        description: "Sync the managed Codex Router catalog in-process. Does not launch Control Center.",
        run: async (_args, context) => {
          if (typeof context.services?.syncCodexRouter !== "function") {
            return { ok: false, reason: "Codex Router sync is unavailable" };
          }
          return sanitizePublic(await context.services.syncCodexRouter());
        },
      },
    },
  });
}

module.exports = { createModule, LOOPBACK };
