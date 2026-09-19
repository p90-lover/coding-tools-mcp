"use strict";

const SENSITIVE_KEY = /(?:^|_)(?:access_token|refresh_token|api_key|private_key|client_secret|password|secret|token|credential|bearer|authorization|caller_key|proxy_api_key|management_key)(?:_|$)/i;

function sanitizePublic(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizePublic(entry));
  if (!value || typeof value !== "object") return value;
  const snapshot = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[-.\s]+/g, "_");
    if (SENSITIVE_KEY.test(normalized) && typeof entry !== "boolean") continue;
    snapshot[key] = sanitizePublic(entry);
  }
  return snapshot;
}

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value || "");
}

function classifyAnnealUnavailable(error) {
  const message = errorMessage(error).trim();
  if (!message) return null;
  const lower = message.toLowerCase();
  if (
    lower.includes("postgres")
    || lower.includes("postgresql")
    || /\b5432\b/.test(lower)
    || lower.includes("database is unavailable")
    || lower.includes("database connection")
    || (lower.includes("docker") && (lower.includes("database") || lower.includes("postgres")))
  ) {
    return { dependency: "postgres", message };
  }
  return null;
}

module.exports = {
  classifyAnnealUnavailable,
  errorMessage,
  sanitizePublic,
};
