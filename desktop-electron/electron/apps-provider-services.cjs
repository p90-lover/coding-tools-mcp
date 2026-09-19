"use strict";

function publicAccount(account) {
  if (!account || typeof account !== "object") return null;
  return {
    id: account.id,
    providerId: account.providerId,
    label: account.label,
    identity: account.identity || null,
    endpoint: account.endpoint || null,
    auth: account.auth,
    status: account.status,
    enabled: account.enabled === true,
    isDefault: account.isDefault === true,
    models: Array.isArray(account.models) ? account.models.filter((value) => typeof value === "string") : [],
    loginAdapterId: account.loginAdapterId || null,
    credentialSource: account.credentialSource || null,
    archivedAt: account.archivedAt || null,
    error: account.error || null,
    hasCredential: account.hasCredential === true,
  };
}

function summarize(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  return {
    total: list.length,
    enabled: list.filter((account) => account.enabled && !account.archivedAt).length,
    connected: list.filter((account) => account.enabled && !account.archivedAt && account.status === "connected").length,
    disabled: list.filter((account) => !account.archivedAt && account.enabled === false).length,
    archived: list.filter((account) => Boolean(account.archivedAt)).length,
  };
}

function isCpaAccount(account) {
  return account.credentialSource === "cpa"
    || String(account.loginAdapterId || "").startsWith("cpa-")
    || account.providerId === "cliproxyapi-antigravity"
    || account.providerId === "claude-oauth"
    || account.providerId === "codex-oauth"
    || account.providerId === "gemini-oauth";
}

function createAppsProviderServices({ providerNetworkReady }) {
  async function snapshotOrEmpty() {
    try {
      const active = await providerNetworkReady();
      const snapshot = active.store.snapshot();
      const accounts = (snapshot.accounts || []).map(publicAccount).filter(Boolean);
      return { ok: true, active, snapshot, accounts, summary: summarize(accounts) };
    } catch (error) {
      return {
        ok: false,
        active: null,
        snapshot: null,
        accounts: [],
        summary: summarize([]),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function listProviders() {
    const listed = await snapshotOrEmpty();
    return {
      ok: listed.ok,
      accounts: listed.accounts,
      summary: listed.summary,
      reason: listed.ok
        ? (listed.summary.total === 0
          ? "no provider-network accounts"
          : listed.summary.connected === 0
            ? "provider-network accounts are disabled or archived"
            : undefined)
        : listed.reason,
    };
  }

  async function linkProvider(args = {}) {
    const listed = await snapshotOrEmpty();
    if (!listed.active) return { ok: false, accounts: [], summary: listed.summary, reason: listed.reason };
    const input = args && typeof args === "object" ? args : {};
    const nested = input.account && typeof input.account === "object" ? input.account : null;
    const payload = nested || input;
    let snapshot = listed.snapshot;
    let accountId = String(payload.accountId || payload.id || input.accountId || "").trim();

    const shouldSave = Boolean(
      payload.providerId
      || payload.label
      || payload.auth
      || payload.secret
      || payload.identity
      || nested,
    );
    if (shouldSave) {
      snapshot = listed.active.store.saveAccount({
        ...payload,
        id: payload.id || accountId || undefined,
      });
      accountId = String(
        payload.id
        || accountId
        || snapshot.accounts?.slice(-1)[0]?.id
        || "",
      ).trim();
    }

    if (Object.hasOwn(input, "enabled") && accountId) {
      snapshot = listed.active.store.setAccountEnabled(accountId, input.enabled === true);
    }

    if (input.login && accountId) {
      const result = input.adapterId === undefined
        ? await listed.active.openProviderLogin(accountId)
        : await listed.active.openProviderLogin(accountId, input.adapterId);
      const accounts = (result.snapshot || snapshot).accounts.map(publicAccount).filter(Boolean);
      return {
        ok: true,
        linked: true,
        accountId,
        opened: result.opened === true,
        mode: result.mode || null,
        adapterId: result.adapterId || input.adapterId || null,
        accounts,
        summary: summarize(accounts),
      };
    }

    if (input.probe && accountId) {
      snapshot = await listed.active.probeProviderAccount(accountId);
    }

    const accounts = (snapshot || listed.active.store.snapshot()).accounts.map(publicAccount).filter(Boolean);
    return {
      ok: Boolean(accountId),
      linked: Boolean(accountId),
      accountId: accountId || null,
      accounts,
      summary: summarize(accounts),
      reason: accountId ? undefined : "accountId or provider account fields are required",
    };
  }

  async function unlinkProvider(args = {}) {
    const listed = await snapshotOrEmpty();
    if (!listed.active) return { ok: false, accounts: [], summary: listed.summary, reason: listed.reason };
    const accountId = String(args.accountId || args.id || "").trim();
    if (!accountId) return { ok: false, accounts: listed.accounts, summary: listed.summary, reason: "accountId is required" };
    const snapshot = args.disableOnly === true
      ? listed.active.store.setAccountEnabled(accountId, false)
      : listed.active.store.archiveAccount(accountId);
    const accounts = snapshot.accounts.map(publicAccount).filter(Boolean);
    return { ok: true, accountId, accounts, summary: summarize(accounts) };
  }

  async function providerStatus(args = {}) {
    const listed = await snapshotOrEmpty();
    if (!listed.active) return { ok: false, accounts: [], summary: listed.summary, reason: listed.reason };
    const accountId = String(args.accountId || args.id || "").trim();
    if (!accountId) return { ok: listed.ok, accounts: listed.accounts, summary: listed.summary, reason: listed.reason };
    try {
      const snapshot = await listed.active.probeProviderAccount(accountId);
      const accounts = snapshot.accounts.map(publicAccount).filter(Boolean);
      const account = accounts.find((entry) => entry.id === accountId) || null;
      return {
        ok: account?.status === "connected",
        accountId,
        account,
        accounts,
        summary: summarize(accounts),
        reason: account?.error
          || (account?.status === "connected" ? undefined : `provider status is ${account?.status || "unknown"}`),
      };
    } catch (error) {
      const latest = listed.active.store.snapshot();
      const accounts = latest.accounts.map(publicAccount).filter(Boolean);
      return {
        ok: false,
        accountId,
        account: accounts.find((entry) => entry.id === accountId) || null,
        accounts,
        summary: summarize(accounts),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function providerCatalog(moduleId) {
    const listed = await listProviders();
    const selected = moduleId === "cpa"
      ? listed.accounts.filter((account) => (
        !account.archivedAt
        && account.enabled
        && account.status === "connected"
        && isCpaAccount(account)
      ))
      : [];
    return {
      models: [...new Set(selected.flatMap((account) => account.models))],
      accounts: selected,
    };
  }

  async function explainEmptyModels(moduleId, probed = {}) {
    const listed = await listProviders();
    if (moduleId === "cpa") {
      if (listed.summary.total > 0 && listed.summary.connected === 0) {
        return { reason: "provider-network accounts are disabled or archived", summary: listed.summary };
      }
      if (listed.summary.total === 0) {
        return {
          reason: probed.reachable === false
            ? (probed.reason || "CPA loopback is unreachable")
            : "CPA auth-dir is empty; link a provider first",
          summary: listed.summary,
        };
      }
      return { reason: "CPA /v1/models returned an empty catalog", summary: listed.summary };
    }
    if (moduleId === "codex-router") {
      if (probed.credentialReason || /caller secret/i.test(String(probed.reason || ""))) {
        return { reason: probed.reason || "Codex Router caller secret is not configured", summary: listed.summary };
      }
      return {
        reason: probed.reachable === false
          ? (probed.reason || "Codex Router loopback is unreachable")
          : "Codex Router catalog is empty; run sync after providers are linked",
        summary: listed.summary,
      };
    }
    return { reason: probed.reason || "catalog is empty", summary: listed.summary };
  }

  return Object.freeze({
    listProviders,
    linkProvider,
    unlinkProvider,
    providerStatus,
    providerCatalog,
    explainEmptyModels,
  });
}

module.exports = {
  createAppsProviderServices,
  isCpaAccount,
  publicAccount,
  summarize,
};
