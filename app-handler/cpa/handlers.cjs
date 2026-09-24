"use strict";

const { defineModule } = require("../lib/define-module.cjs");
const { openaiOperations, publicError, resolveLoopback } = require("../lib/openai.cjs");
const { requestJson } = require("../lib/loopback.cjs");
const { sanitizePublic } = require("../lib/sanitize.cjs");
const { managementOperations } = require("./management.cjs");

const LOOPBACK = Object.freeze({
  origin: "http://127.0.0.1:8317/",
  openai: "http://127.0.0.1:8317/v1",
});

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

async function listAuthFiles(context) {
  const loopback = resolveLoopback(getOrigin, context);
  if (!loopback.managementHeaders || Object.keys(loopback.managementHeaders).length === 0) {
    return { ok: false, files: [], reason: "CPA management key is unavailable" };
  }
  try {
    const result = await requestJson(loopback.origin, {
      method: "GET",
      pathname: "/v0/management/auth-files",
      headers: loopback.managementHeaders,
    });
    const files = authFilesFromListing(result.json);
    return {
      ok: result.ok,
      status: result.status,
      files,
      count: files.length,
      reason: result.ok
        ? (files.length === 0 ? "CPA auth-dir is empty" : undefined)
        : `CPA management API returned HTTP ${result.status}`,
    };
  } catch (error) {
    return { ok: false, files: [], count: 0, reason: publicError(error) };
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
    ...managementOperations(getOrigin),
    authFiles: {
      readOnly: true,
      description: "List CPA account identities and status without exposing auth-file credentials.",
      run: (_args, context) => listAuthFiles(context),
    },
    managementHealth: {
      readOnly: true,
      description: "Probe the CPA management panel and auth-file listing over loopback HTTP. Does not open a browser window.",
      run: async (_args, context) => {
        const loopback = resolveLoopback(getOrigin, context);
        let panel = { reachable: false, status: 0 };
        try {
          const result = await requestJson(loopback.origin, { method: "GET", pathname: "/management.html" });
          panel = { reachable: result.status > 0, status: result.status };
        } catch (error) {
          panel = { reachable: false, status: 0, error: publicError(error) };
        }
        const auth = await listAuthFiles(context);
        const reason = !panel.reachable
          ? (panel.error || "CPA management panel is unreachable")
          : !auth.ok
            ? (auth.reason || "CPA management API is unavailable")
            : auth.count === 0
              ? (auth.reason || "CPA auth-dir is empty")
              : undefined;
        return sanitizePublic({
          ok: panel.reachable && auth.ok === true,
          reachable: panel.reachable,
          status: panel.status,
          authFileCount: auth.count || 0,
          authFiles: auth.files || [],
          reason,
        });
      },
    },
    listProviders: {
      readOnly: true,
      description: "List provider-network accounts and CPA auth-file status without opening CPA's window.",
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
        } else if (ok && summary.total === 0 && (auth.count || 0) === 0) {
          reason = auth.reason || "CPA auth-dir is empty; no linked providers";
        }
        return sanitizePublic({
          ok,
          accounts,
          summary: { ...summary, authFileCount: auth.count || 0 },
          authFiles: auth.files || [],
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
