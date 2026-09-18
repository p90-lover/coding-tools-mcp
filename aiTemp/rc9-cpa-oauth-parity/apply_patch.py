from __future__ import annotations

import json
from pathlib import Path

ROOT = Path.cwd()


def read(pathname: str) -> str:
    return (ROOT / pathname).read_text(encoding="utf-8")


def write(pathname: str, content: str) -> None:
    path = ROOT / pathname
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def replace_once(pathname: str, old: str, new: str) -> None:
    text = read(pathname)
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {pathname}, found {count}: {old[:120]!r}")
    write(pathname, text.replace(old, new, 1))


def replace_between(pathname: str, start: str, end: str, replacement: str) -> None:
    text = read(pathname)
    if replacement in text:
        return
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f"start anchor missing in {pathname}: {start!r}")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f"end anchor missing in {pathname}: {end!r}")
    write(pathname, text[:start_index] + replacement + text[end_index:])


CPA_HELPER = r'''"use strict";

const CPA_OAUTH_PROVIDERS = Object.freeze({
  "codex-oauth": Object.freeze({
    provider: "codex",
    aliases: Object.freeze(["codex", "openai-codex"]),
    authPath: "codex-auth-url",
    label: "Codex",
    plugin: false,
  }),
  "claude-oauth": Object.freeze({
    provider: "anthropic",
    aliases: Object.freeze(["anthropic", "claude", "claude-code"]),
    authPath: "anthropic-auth-url",
    label: "Claude",
    plugin: false,
  }),
  "gemini-oauth": Object.freeze({
    provider: "gemini-cli",
    aliases: Object.freeze(["gemini-cli", "gemini"]),
    authPath: "gemini-cli-auth-url",
    label: "Gemini CLI",
    plugin: true,
  }),
  "cliproxyapi-antigravity": Object.freeze({
    provider: "antigravity",
    aliases: Object.freeze(["antigravity"]),
    authPath: "antigravity-auth-url",
    label: "Antigravity",
    plugin: false,
  }),
});

function cpaOAuthDefinition(providerId) {
  return CPA_OAUTH_PROVIDERS[String(providerId || "").trim()] ?? null;
}

function normalizedProvider(entry) {
  return String(entry?.provider ?? entry?.type ?? "").trim().toLowerCase();
}

function cpaAuthFiles(value, definition) {
  const files = Array.isArray(value?.files) ? value.files : [];
  const aliases = new Set((definition?.aliases ?? [definition?.provider])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean));
  return files.filter((entry) => entry && typeof entry === "object" && aliases.has(normalizedProvider(entry)));
}

function cpaAuthFileName(entry) {
  const value = String(entry?.name ?? entry?.id ?? "").trim();
  return value || null;
}

function cpaAuthIndex(entry) {
  const value = String(entry?.auth_index ?? entry?.authIndex ?? "").trim();
  return value || null;
}

function cpaIdentity(entry) {
  const value = String(entry?.email ?? entry?.account ?? entry?.label ?? entry?.username ?? "").trim();
  return value || null;
}

function cpaSessionStatus(entry) {
  const detail = `${entry?.status ?? ""} ${entry?.status_message ?? ""}`.trim();
  if (entry?.disabled === true) return "disabled";
  if (/expired|invalid[_ -]?grant|refresh token|reauth/i.test(detail)) return "expired";
  if (entry?.unavailable === true || /error|failed|invalid/i.test(detail)) return "error";
  return "connected";
}

module.exports = {
  CPA_OAUTH_PROVIDERS,
  cpaAuthFileName,
  cpaAuthFiles,
  cpaAuthIndex,
  cpaIdentity,
  cpaOAuthDefinition,
  cpaSessionStatus,
};
'''
write("desktop-electron/electron/cpa-oauth.cjs", CPA_HELPER)

# Provider network: import the generic adapter and widen encrypted binding metadata.
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    'const { writePrivateFileAtomic } = require("./atomic-file.cjs");\n',
    'const { writePrivateFileAtomic } = require("./atomic-file.cjs");\n'
    'const {\n'
    '  CPA_OAUTH_PROVIDERS,\n'
    '  cpaAuthFileName,\n'
    '  cpaAuthFiles,\n'
    '  cpaAuthIndex,\n'
    '  cpaIdentity,\n'
    '  cpaOAuthDefinition,\n'
    '  cpaSessionStatus,\n'
    '} = require("./cpa-oauth.cjs");\n',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '    for (const key of ["antigravityAuthName", "antigravityAuthIndex"]) {\n',
    '    for (const key of [\n'
    '      "antigravityAuthName",\n'
    '      "antigravityAuthIndex",\n'
    '      "cpaProvider",\n'
    '      "cpaAuthName",\n'
    '      "cpaAuthIndex",\n'
    '    ]) {\n',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '  getBrowserHost,\n  logger,\n',
    '  getBrowserHost,\n  getCpaConnection = () => null,\n  logger,\n',
)

CPA_CONNECTION_BLOCK = r'''  function cpaConnection(account) {
    const definition = cpaOAuthDefinition(account.providerId);
    if (!definition) throw new Error("This provider is not managed by CPA / CLIProxyAPI OAuth");

    let configured = null;
    let configuredError = null;
    try {
      configured = typeof getCpaConnection === "function" ? getCpaConnection() : null;
    } catch (error) {
      configuredError = error;
    }
    if (configured && typeof configured === "object") {
      const managementKey = String(configured.managementKey ?? "").trim();
      if (managementKey) {
        const baseUrl = normalizeProviderBaseUrl(
          configured.baseUrl || configured.endpoint || DEFAULT_ANTIGRAVITY_BASE_URL,
        );
        return { baseUrl, managementKey, definition };
      }
    }

    // Migration fallback for existing Antigravity-style account records. New
    // CPA OAuth accounts use the encrypted central service authority instead.
    const secret = store.accountSecret(account.id) || {};
    const managementKey = String(secret.managementKey ?? secret.credential ?? "").trim();
    if (managementKey) {
      const baseUrl = normalizeProviderBaseUrl(
        account.endpoint || secret.baseUrl || DEFAULT_ANTIGRAVITY_BASE_URL,
      );
      return { baseUrl, managementKey, definition };
    }

    const detail = configuredError instanceof Error && configuredError.message
      ? `: ${configuredError.message}`
      : "";
    throw new Error(
      `Configure CPA / CLIProxyAPI endpoint and management key in Integrations before ${definition.label} login${detail}`,
    );
  }

  function cpaSessionBinding(account) {
    const secret = store.accountSecret(account.id) || {};
    return {
      provider: String(secret.cpaProvider ?? "").trim() || null,
      name: String(secret.cpaAuthName ?? secret.antigravityAuthName ?? "").trim() || null,
      authIndex: String(secret.cpaAuthIndex ?? secret.antigravityAuthIndex ?? "").trim() || null,
    };
  }

  async function cpaManagementJson(account, pathname) {
    const { baseUrl, managementKey } = cpaConnection(account);
    const url = new URL(pathname, `${baseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, requestTimeoutMs));
    timeout.unref?.();
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${managementKey}`,
          "X-Management-Key": managementKey,
        },
        signal: controller.signal,
      });
      let value = {};
      try {
        value = await response.json();
      } catch {
        value = {};
      }
      if (!response.ok) {
        const detail = typeof value?.error === "string"
          ? `: ${value.error.slice(0, 240)}`
          : typeof value?.message === "string"
            ? `: ${value.message.slice(0, 240)}`
            : "";
        const error = new Error(`CPA / CLIProxyAPI management request failed (HTTP ${response.status})${detail}`);
        error.statusCode = response.status;
        throw error;
      }
      return value;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("CPA / CLIProxyAPI management request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

'''
replace_between(
    "desktop-electron/electron/provider-network.cjs",
    "  function antigravityConnection(account) {\n",
    "  async function providerJson",
    CPA_CONNECTION_BLOCK,
)

CPA_INSPECT_BLOCK = r'''  async function inspectCpaSession(
    account,
    { baselineAuthNames = new Set(), baselineAuthIndexes = new Set() } = {},
  ) {
    const definition = cpaOAuthDefinition(account.providerId);
    if (!definition) throw new Error("CPA OAuth provider definition is missing");
    const binding = cpaSessionBinding(account);
    const query = new URLSearchParams();
    if (binding.name) query.set("name", binding.name);
    if (binding.authIndex) query.set("auth_index", binding.authIndex);
    const pathname = query.size > 0
      ? `/v0/management/auth-files?${query.toString()}`
      : "/v0/management/auth-files";
    const listing = await cpaManagementJson(account, pathname);
    const files = cpaAuthFiles(listing, definition);
    if (files.length === 0) {
      return store.updateAccountConnection(account.id, {
        status: "pending",
        models: [],
        error: binding.name || binding.authIndex
          ? `The bound ${definition.label} CPA session is unavailable; log in again`
          : undefined,
      });
    }

    const exactBound = files.find((entry) => (
      (binding.authIndex && cpaAuthIndex(entry) === binding.authIndex)
        || (binding.name && cpaAuthFileName(entry) === binding.name)
    ));
    if ((binding.name || binding.authIndex) && !exactBound) {
      return store.updateAccountConnection(account.id, {
        status: "pending",
        models: [],
        error: `The bound ${definition.label} CPA session is unavailable; log in again`,
      });
    }

    const identity = String(account.identity || "").trim().toLowerCase();
    const identityMatch = files.find((entry) => {
      const candidate = String(cpaIdentity(entry) || "").trim().toLowerCase();
      return identity && candidate === identity;
    });
    const newlyCreated = files.find((entry) => {
      const name = cpaAuthFileName(entry);
      const authIndex = cpaAuthIndex(entry);
      return (name && !baselineAuthNames.has(name))
        || (authIndex && !baselineAuthIndexes.has(authIndex));
    });
    const healthy = files.filter((entry) => cpaSessionStatus(entry) === "connected");
    let selected = exactBound ?? identityMatch ?? newlyCreated ?? null;
    if (!selected && healthy.length === 1) selected = healthy[0];
    if (!selected && files.length === 1) selected = files[0];
    if (!selected) {
      return store.updateAccountConnection(account.id, {
        status: "error",
        models: [],
        error: `CPA returned multiple ${definition.label} accounts; choose an identity or log in again`,
      });
    }

    const selectedName = cpaAuthFileName(selected);
    const selectedAuthIndex = cpaAuthIndex(selected);
    const status = cpaSessionStatus(selected);
    const detail = `${selected.status ?? ""} ${selected.status_message ?? ""}`.trim();
    if (status === "connected") {
      store.mergeAccountSecret(account.id, {
        cpaProvider: definition.provider,
        cpaAuthName: selectedName,
        cpaAuthIndex: selectedAuthIndex,
        ...(definition.provider === "antigravity" ? {
          antigravityAuthName: selectedName,
          antigravityAuthIndex: selectedAuthIndex,
        } : {}),
      });
    }

    let models = Array.isArray(account.models) ? account.models : [];
    let modelError;
    if (status === "connected" && selectedName) {
      try {
        const catalogue = await cpaManagementJson(
          account,
          `?v0/management/auth-files/models?name=${encodeURIComponent(selectedName)}`,
        );
        const discovered = providerModelIds(catalogue);
        if (discovered.length > 0) models = discovered;
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
      }
    }
    const { baseUrl } = cpaConnection(account);
    return store.updateAccountConnection(account.id, {
      status,
      identity: cpaIdentity(selected) ?? account.identity,
      endpoint: baseUrl,
      models,
      error: status === "connected" ? modelError : (selected.status_message || detail || undefined),
    });
  }

  async function inspectAntigravitySession(account, options = {}) {
    return inspectCpaSession(account, options);
  }

 '''
replace_between(
    "desktop-electron/electron/provider-network.cjs",
    "  async function inspectAntigravitySession(\n",
    "  function commandCodeConnection",
    CPA_INSPECT_BLOCK,
)

CPA_LOGIN_AND_PROBE_BLOCK = r'''  async function startCpaOAuthLogin(account) {
    const definition = cpaOAuthDefinition(account.providerId);
    if (!definition) throw new Error("CPA OAuth provider definition is missing");
    let baselineAuthNames = new Set();
    let baselineAuthIndexes = new Set();
    try {
      const baseline = await cpaManagementJson(account, "/v0/management/auth-files");
      const baselineFiles = cpaAuthFiles(baseline, definition);
      baselineAuthNames = new Set(baselineFiles.map(cpaAuthFileName).filter(Boolean));
      baselineAuthIndexes = new Set(baselineFiles.map(cpaAuthIndex).filter(Boolean));
    } catch (error) {
      logger.warn("provider.cpa_baseline_failed", {
        accountId: account.id,
        providerId: account.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    store.updateAccountConnection(account.id, { status: "pending", error: undefined });
    try {
      let login;
      try {
        login = await cpaManagementJson(
          account,
          `/v0/management/${definition.authPath}?is_webui=true`,
        );
      } catch (error) {
        if (definition.plugin && Number(error?.statusCode) === 404) {
          throw new Error(
            `${definition.label} OAuth is unavailable because the installed CPA / CLIProxyAPI does not expose ${definition.authPath}; install or enable the ${definition.provider} auth plugin`,
          );
        }
        throw error;
      }
      const state = String(login?.state ?? "").trim();
      if (!state || login?.status !== "ok") {
        throw new Error(`CPA / CLIProxyAPI did not start ${definition.label} authentication`);
      }
      const loginUrl = safeProviderLoginUrl(login?.url);
      await shell.openExternal(loginUrl);

      const deadline = Date.now() + Math.max(1, oauthTimeoutMs);
      while (Date.now() <= deadline) {
        const status = await cpaManagementJson(
          account,
          `/v0/management/get-auth-status?state=${encodeURIComponent(state)}`,
        );
        if (status?.status === "ok") {
          return {
            opened: true,
            mode: "external",
            state,
            snapshot: await inspectCpaSession(accountRecord(account.id), {
              baselineAuthNames,
              baselineAuthIndexes,
            }),
          };
        }
        if (status?.status === "error") {
          throw new Error(String(status.error || `${definition.label} authentication failed`));
        }
        await sleepImpl(Math.max(0, oauthPollIntervalMs));
      }
      throw new Error(`${definition.label} authentication timed out`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const snapshot = store.updateAccountConnection(account.id, {
        status: providerSessionFailureStatus(message),
        error: message,
      });
      error.snapshot = snapshot;
      throw error;
    }
  }

  async function probeProviderAccount(accountId) {
    const account = accountRecord(accountId);
    try {
      if (cpaOAuthDefinition(account.providerId)) {
        return await inspectCpaSession(account);
      }
      if (account.providerId === COMMANDCODE_PROVIDER_ID) {
        return await inspectCommandCodeSession(account);
      }
      throw new Error("Provider account health probing is not configured for this provider");
    } catch (error) {
      store.updateAccountConnection(account.id, {
        status: providerSessionFailureStatus(error instanceof Error ? error.message : String(error)),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

'''
replace_between(
    "desktop-electron/electron/provider-network.cjs",
    "³)Ü~éÜ¶*'¦ºxúè¾'^¬¢éíiÇ(º{Hvv¬Êwºw-Š‰ìÊw®Œ,z³ë¢øz°r‹§´#À,áˆ4C=Î  ãÄ4³† 