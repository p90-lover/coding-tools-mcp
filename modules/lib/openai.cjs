"use strict";

const { requestJson } = require("./loopback.cjs");
const { sanitizePublic } = require("./sanitize.cjs");

function openaiOperations(getOrigin) {
  return {
    health: {
      readOnly: true,
      description: "GET the managed loopback origin. Does not open a GUI.",
      run: async (_args, context) => {
        const origin = getOrigin(context);
        try {
          const result = await requestJson(origin, { method: "GET", pathname: "/" });
          return sanitizePublic({
            reachable: result.ok || result.status > 0,
            status: result.status,
            json: result.json,
          });
        } catch (error) {
          return { reachable: false, status: 0, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    models: {
      readOnly: true,
      description: "List OpenAI-compatible models from the managed loopback /v1/models endpoint.",
      run: async (_args, context) => {
        const origin = getOrigin(context);
        const result = await requestJson(origin, { method: "GET", pathname: "/v1/models" });
        return sanitizePublic({
          ok: result.ok,
          status: result.status,
          models: Array.isArray(result.json?.data)
            ? result.json.data.map((entry) => entry?.id).filter(Boolean)
            : [],
        });
      },
    },
    chatCompletions: {
      readOnly: false,
      description: "POST /v1/chat/completions on the managed loopback. Coding Tools owns the call; no standalone app UI.",
      run: async (args, context) => {
        const origin = getOrigin(context);
        const result = await requestJson(origin, {
          method: "POST",
          pathname: "/v1/chat/completions",
          body: args.body && typeof args.body === "object" ? args.body : args,
        });
        return sanitizePublic({
          ok: result.ok,
          status: result.status,
          json: result.json,
        });
      },
    },
  };
}

module.exports = { openaiOperations };
