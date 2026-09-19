"use strict";

const { defineModule } = require("../lib/define-module.cjs");
const { inspectResult, moduleSnapshot } = require("../lib/in-process-runtime.cjs");
const {
  openaiOperations,
  probeOpenAi,
  providerCatalogIds,
  publicError,
  resolveLoopback,
} = require("../lib/openai.cjs");
const { requestJson } = require("../lib/loopback.cjs");
const { sanitizePublic } = require("../lib/sanitize.cjs");

const LOOPBACK = Object.freeze({
  origin: "http://127.0.0.1:8317/",
  openai: "http://127.0.0.1:8317/v1",
});
const AUTH_PROBE_TIMEOUT_MS = 750;

function getOrigin(context) {
  return context.loopback?.origin || LOOPBACK.origin;
}

function authFilesFromListing(json) {
  const files = Array.isArray(json?.files) ? json.files : [];
  return files.map((entry) => ({
    name: entry?.name || entry?.id || null,
    provider: entry?.provider || entry?.type || null,
    identity: entry?.email || entry?.account || entry?.label || null,
    status: entry?.disabled === true ? "disabled" : (entry?.status || "unknown"),
    disabled: entry?.disabled === true,
  })).filter((entry) => entry.name);
}

function processDownReason(reason) {
  const message = String(reason || "");
  return /econnrefused|fetch failed|connect(?:ion)? refused|not listening|unreachable/i.test(message);
}

async function listAuthFiles(context) {
  const loopback = resolveLoopback(getOrigin, context);
  if (!loopback.managementHeaders || Object.keys(loopback.managementHeaders).length === 0) {
    return {
      ok: false,
      files: [],
      count: 0,
      processReachable: false,
      reason: "CPA management key is unavailable until the optional proxy is started",
    };
  }
  try {
    const result = await requestJson(loopback.origin, {
      method: "GET",
      pathname: "/v0/management/auth-files",
      headers: loopback.managementHeaders,
      timeoutMs: AUTH_PROBE_TIMEOUT_MS,
    });
    const files = authFilesFromListing(result.json);
    return {
      ok: result.ok,
      status: result.status,
      files,
      count: files.length,
      processReachable: result.status > 0,
      reason: result.ok
        ? (files.length === 0 ? "CPA auth-dir is empty" : undefined)
        : `CPA management API returned HTTP ${result.status}`,
    };
  } catch (error) {
    const reason = publicError(error);
    return {
      ok: false,
      files: [],
      count: 0,
      processReachable: false,
      reason: processDownReason(reason)
        ? "CPA process is not listening; auth-files stay empty until optional Start"
        : reason,
    };
  }
}

async function callProvider(context, name, args, label) {
  const fn = context.services?.[name];
  if (typeof fn !== "function") {
    return { ok: false, reason: `${label} is unavailable` };
  }
  try {
    return sanitizePublic(await fn(args && typeof args === "object" ? args : {}));
  } catch (error) {
    return { ok: false, reason: publicError(error) };
  }
}

function createModule() {
  const extraOperations = {
    ...openaiOperations(getOrigin),
    inspect: {
      readOnly: true,
      description: "Inspect the in-process CPA handler and CT-hosted panel. Does not probe :8317.",
      run: async (_args, context) => {
        const snapshot = inspectResult("cpa");
        const listed = await callProvider(context, "listProviders", {}, "Provider listing");
        return sanitizePublic({
          ...snapshot,
          ok: true,
          id: "cpa",
          name: "CPA / CLIProxyAPI",
          status: "ready",
          unavailable: false,
          transport: "in-process",
          listening: false,
          dedicatedListenPort: false,
          runtimeStarted: false,
          processOptional: true,
          preferLocal: true,
          visual: "coding-tools-embedded",
          present: snapshot.present === true || moduleSnapshot("cpa").present === true,
          providers: listed.summary && typeof listed.summary === "object" ? listed.summary : null,
        });
      },
    },
    models: {
      readOnly: true,
      description: "List CPA models from provider-network, falling back to loopback /v1/models only when the optional proxy is up.",
      run: async (args, context) => {
        const probed = await probeOpenAi("models", args, context, getOrigin);
        if (probed.ok && Array.isArray(probed.models) && probed.models.length > 0) return probed;
        if (Number(probed.status) === 401) return probed;
        const linked = await providerCatalogIds(context);
        if (linked.length > 0) {
          return sanitizePublic({
            ok: true,
            reachable: probed.reachable === true,
            status: probed.status || 0,
            models: linked,
            source: "provider-network",
            processOptional: true,
          });
        }
        return sanitizePublic({
          ...probed,
          ok: false,
          models: [],
          processOptional: true,
          source: probed.source || (probed.reachable ? "loopback" : "provider-network"),
        });
      },
    },
    managementHealth: {
      readOnly: true,
      description: "Report the CT-hosted CPA panel plus optional auth-file status. Does not fetch management.html or require :8317.",
      run: async (_args, context) => {
        const auth = await listAuthFiles(context);
        const authOk = auth.ok === true;
        const processReachable = auth.processReachable === true;
        const reason = authOk
          ? ((auth.count || 0) === 0 ? (auth.reason || "CPA auth-dir is empty") : undefined)
          : (auth.reason || "CPA process is optional; auth-files unavailable until Start");
        return sanitizePublic({
          ok: true,
          hosted: true,
          reachable: true,
          transport: "in-process",
          processOptional: true,
          processReachable,
          authOk,
          status: 200,
          authFileCount: auth.count || 0,
          authFiles: auth.files || [],
          reason,
        });
      },
    },
    listProviders: {
      readOnly: true,
      description: "List provider-network accounts without opening CPA's window or requiring :8317.",
      run: async (args, context) => {
        const listed = await callProvider(context, "listProviders", args, "Provider listing");
        const auth = await listAuthFiles(context);
        const accounts = Array.isArray(listed.accounts) ? listed.accounts : [];
        const summary = listed.summary && typeof listed.summary === "object"
          ? listed.summary
          : {
            total: accounts.length,
            enabled: accounts.filter((account) => account.enabled && !account.archivedAt).length,
            connected: accounts.filter((account) => account.enabled && !account.archivedAt && account.status === "connected").length,
            disabled: accounts.filter((account) => !account.archivedAt && account.enabled === false).length,
            archived: accounts.filter((account) => Boolean(account.archivedAt)).length,
          };
        const ok = listed.ok !== false;
        let reason = listed.reason;
        if (ok && summary.connected === 0 && summary.total > 0) {
          reason = "provider-network accounts are disabled or archived";
        } else if (ok && summary.total === 0) {
          reason = "no provider-network accounts";
        }
        return sanitizePublic({
          ok,
          accounts,
          summary: { ...summary, authFileCount: auth.count || 0 },
          authFiles: auth.files || [],
          authOk: auth.ok === true,
          processReachable: auth.processReachable === true,
          processOptional: true,
          reason,
        });
      },
    },
    linkProvider: {
      readOnly: false,
      description: "Create, enable, or login-link a provider-network account through Coding Tools. Does not open CPA's window.",
      run: (args, context) => callProvider(context, "linkProvider", args, "Provider linking"),
    },
    unlinkProvider: {
      readOnly: false,
      description: "Disable or archive a provider-network account through Coding Tools.",
      run: (args, context) => callProvider(context, "unlinkProvider", args, "Provider unlinking"),
    },
    providerStatus: {
      readOnly: true,
      description: "Probe a linked provider account or summarize provider-network status.",
      run: (args, context) => callProvider(context, "providerStatus", args, "Provider status"),
    },
  };
  extraOperations.providers = extraOperations.listProviders;
  return defineModule({
    id: "cpa",
    name: "CPA / CLIProxyAPI",
    loopback: LOOPBACK,
    extraOperations,
  });
}

module.exports = { createModule, LOOPBACK };
