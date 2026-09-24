"use strict";

const { isDeepStrictEqual } = require("node:util");

function planPaseoProviderPatch(config = {}) {
  const existing = config.providers ?? {};
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("Paseo provider configuration is invalid");
  }
  const desired = {
    "coding-tools-web-gpt": {
      extends: "codex", label: "ChatGPT Web — High", enabled: true,
      env: { OPENAI_BASE_URL: "", OPENAI_API_BASE: "", OPENAI_API_KEY: "" },
      models: [{ id: "chatgpt-web/high", label: "ChatGPT Web — High", isDefault: true }],
    },
    "coding-tools-cpa-gemini": {
      extends: "codex", label: "CPA — Gemini 3.8 Flash High", enabled: true,
      env: { OPENAI_BASE_URL: "http://127.0.0.1:8317/v1" },
      models: [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash High", isDefault: true }],
    },
  };
  const providers = {};
  for (const [id, definition] of Object.entries(desired)) {
    if (Object.hasOwn(existing, id)) {
      if (!isDeepStrictEqual(existing[id], definition)) {
        throw new Error(`Paseo provider ID already belongs to another configuration: ${id}`);
      }
    } else {
      providers[id] = definition;
    }
  }
  return Object.keys(providers).length ? { providers } : null;
}

module.exports = { planPaseoProviderPatch };
