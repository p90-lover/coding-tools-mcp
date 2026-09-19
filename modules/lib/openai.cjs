"use strict";

const { requestJson } = require("./loopback.cjs");
const { sanitizePublic } = require("./sanitize.cjs");

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\/_codex-router\/[^/?#]+/g, "/_codex-router/[REDACTED]");
}

function redactPublicValue(value) {
  if (typeof value === "string") return publicError(value);
  if (Array.isArray(value)) return value.map((entry) => redactPublicValue(entry));
  if (value && typeof value === "object") {
    const snapshot = {};
    for (const [key, entry] of Object.entries(value)) snapshot[key] = redactPublicValue(entry);
    return snapshot;
  }
  return value;
}

function publicResult(value) {
  return sanitizePublic(redactPublicValue(value));
}

function modelIdsFromCatalog(json) {
  const fromEntry = (entry) => {
    if (typeof entry === "string" && entry.trim()) return entry.trim();
    const id = entry?.id ?? entry?.name ?? entry?.model;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  };
  if (Array.isArray(json?.data)) return json.data.map(fromEntry).filter(Boolean);
  if (Array.isArray(json?.models)) return json.models.map(fromEntry).filter(Boolean);
  if (Array.isArray(json)) return json.map(fromEntry).filter(Boolean);
  return [];
}

function resolveLoopback(getOrigin, context) {
  const fallbackOrigin = typeof getOrigin === "function" ? getOrigin(context) : getOrigin;
  const spec = typeof context.services?.loopbackRequest === "function"
    ? context.services.loopbackRequest() || {}
    : {};
  const headers = spec.headers && typeof spec.headers === "object" ? spec.headers : {};
  const managementHeaders = spec.managementHeaders && typeof spec.managementHeaders === "object"
    ? spec.managementHeaders
    : {};
  return {
    origin: spec.origin || fallbackOrigin,
    headers,
    managementHeaders,
    healthPath: spec.healthPath || "/",
    modelsPath: spec.modelsPath || "/v1/models",
    chatPath: spec.chatPath || "/v1/chat/completions",
    credentialReason: typeof spec.credentialReason === "string" && spec.credentialReason.trim()
      ? spec.credentialReason.trim()
      : null,
  };
}

function uniqueModelIds(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

async function providerCatalogIds(context) {
  if (typeof context.services?.providerCatalog !== "function") return [];
  try {
    const catalog = await context.services.providerCatalog();
    if (Array.isArray(catalog?.models)) return catalog.models.filter((value) => typeof value === "string");
    if (Array.isArray(catalog)) return catalog.filter((value) => typeof value === "string");
  } catch {
    return [];
  }
  return [];
}

async function emptyCatalogDetails(context, probed) {
  if (typeof context.services?.explainEmptyModels !== "function") {
    return {
      reason: probed?.reachable === false
        ? (probed.reason || probed.error || "loopback is unreachable")
        : "catalog is empty",
    };
  }
  try {
    const extra = await context.services.explainEmptyModels(probed);
    return extra && typeof extra === "object" ? extra : { reason: "catalog is empty" };
  } catch (error) {
    return { reason: publicError(error) };
  }
}

function credentialFailure(kind, loopback) {
  return publicResult({
    ok: false,
    reachable: false,
    status: 0,
    models: kind === "models" ? [] : undefined,
    reason: loopback.credentialReason,
  });
}

async function probeOpenAi(kind, args, context, getOrigin) {
  const loopback = resolveLoopback(getOrigin, context);
  if (loopback.credentialReason) return credentialFailure(kind, loopback);

  const pathByKind = {
    health: loopback.healthPath,
    models: loopback.modelsPath,
    chatCompletions: loopback.chatPath,
  };
  const pathname = pathByKind[kind] || loopback.healthPath;
  const method = kind === "chatCompletions" ? "POST" : "GET";
  const body = kind === "chatCompletions"
    ? (args.body && typeof args.body === "object" ? args.body : args)
    : null;

  try {
    const result = await requestJson(loopback.origin, {
      method,
      pathname,
      headers: loopback.headers,
      body,
    });
    const models = modelIdsFromCatalog(result.json);
    const reachable = result.ok || result.status > 0;
    if (kind === "health") {
      return publicResult({
        ok: result.ok,
        reachable,
        status: result.status,
        modelCount: models.length,
        json: result.json,
        ...(result.ok ? {} : {
          reason: reachable ? `HTTP ${result.status}` : "loopback is unreachable",
        }),
      });
    }
    if (kind === "models") {
      const linked = result.ok ? await providerCatalogIds(context) : [];
      const combined = uniqueModelIds([...models, ...linked]);
      if (result.ok && combined.length > 0) {
        return publicResult({
          ok: true,
          reachable,
          status: result.status,
          models: combined,
          source: models.length > 0 ? "loopback" : "provider-network",
        });
      }
      const extra = await emptyCatalogDetails(context, {
        ok: false,
        reachable,
        status: result.status,
        reason: result.ok ? "catalog is empty" : `HTTP ${result.status}`,
      });
      return publicResult({
        ok: false,
        reachable,
        status: result.status,
        models: [],
        source: "loopback",
        reason: extra.reason || "catalog is empty",
        ...extra,
      });
    }
    return publicResult({
      ok: result.ok,
      reachable,
      status: result.status,
      json: result.json,
      ...(result.ok ? {} : {
        reason: reachable ? `HTTP ${result.status}` : "loopback is unreachable",
      }),
    });
  } catch (error) {
    const extra = kind === "models"
      ? await emptyCatalogDetails(context, {
        ok: false,
        reachable: false,
        status: 0,
        reason: publicError(error),
      })
      : {};
    return publicResult({
      ok: false,
      reachable: false,
      status: 0,
      models: kind === "models" ? [] : undefined,
      error: publicError(error),
      reason: extra.reason || publicError(error),
      ...extra,
    });
  }
}

function openaiOperations(getOrigin) {
  return {
    health: {
      readOnly: true,
      description: "Probe the managed OpenAI-compatible loopback. Does not open a GUI.",
      run: (args, context) => probeOpenAi("health", args, context, getOrigin),
    },
    models: {
      readOnly: true,
      description: "List OpenAI-compatible models from the managed loopback /v1/models endpoint.",
      run: (args, context) => probeOpenAi("models", args, context, getOrigin),
    },
    chatCompletions: {
      readOnly: false,
      description: "POST /v1/chat/completions on the managed loopback. Coding Tools owns the call; no standalone app UI.",
      run: (args, context) => probeOpenAi("chatCompletions", args, context, getOrigin),
    },
  };
}

module.exports = {
  modelIdsFromCatalog,
  openaiOperations,
  probeOpenAi,
  publicError,
  redactPublicValue,
  resolveLoopback,
};
