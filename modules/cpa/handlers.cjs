"use strict";

const { defineModule } = require("../lib/define-module.cjs");
const { openaiOperations } = require("../lib/openai.cjs");
const { requestJson } = require("../lib/loopback.cjs");
const { sanitizePublic } = require("../lib/sanitize.cjs");

const LOOPBACK = Object.freeze({
  origin: "http://127.0.0.1:8317/",
  openai: "http://127.0.0.1:8317/v1",
});

function createModule() {
  return defineModule({
    id: "cpa",
    name: "CPA / CLIProxyAPI",
    loopback: LOOPBACK,
    extraOperations: {
      ...openaiOperations((context) => context.loopback?.origin || LOOPBACK.origin),
      managementHealth: {
        readOnly: true,
        description: "Probe the CPA management panel over loopback HTTP. Does not open a browser window.",
        run: async (_args, context) => {
          const origin = context.loopback?.origin || LOOPBACK.origin;
          try {
            const result = await requestJson(origin, { method: "GET", pathname: "/management.html" });
            return sanitizePublic({ reachable: result.status > 0, status: result.status });
          } catch (error) {
            return { reachable: false, status: 0, error: error instanceof Error ? error.message : String(error) };
          }
        },
      },
    },
  });
}

module.exports = { createModule, LOOPBACK };
