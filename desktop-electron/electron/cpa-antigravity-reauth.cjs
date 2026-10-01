"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizedAuthFile, startCpaAccountLogin } = require("./cpa-oauth-adapter.cjs");

// Gemini models reach CPA through its Antigravity provider (same Google OAuth client as the Antigravity CLI).
const PROVIDERS = new Set(["antigravity"]);
const AUTH_FAILURE = /expired|invalid[_ -]?grant|refresh token|reauth|unauthenticated|unauthori[sz]ed|401|token (has been )?revoked/i;

function publicAccount(entry) {
  return {
    name: entry.name, authIndex: entry.authIndex, email: entry.identity, provider: entry.provider,
    status: entry.status, disabled: entry.raw?.disabled === true,
    error: entry.error ? String(entry.error).replace(/Bearer\s+\S+|ya29\.[\w.-]+|1\/\/[\w.-]+/g, "[redacted]").slice(0, 300) : null,
  };
}

function needsAuth(account) {
  return !account.disabled && (account.status === "expired" || (account.status === "error" && AUTH_FAILURE.test(account.error || "")));
}

/**
 * Keeps CPA's Antigravity (Gemini) accounts signed in. A forced token refresh is tried first; only a
 * revoked or expired refresh token falls back to CPA's own browser sign-in, at most once per account
 * per `promptGapMs`. Tokens never leave CPA: this module only sees account names, emails and status.
 */
function createAntigravityReauth({
  cpaConnection, openExternal, notify = () => {}, statePath, logger = console,
  fetchImpl = fetch, now = () => Date.now(), intervalMs = 10 * 60_000, promptGapMs = 6 * 60 * 60_000,
  login = startCpaAccountLogin,
}) {
  let timer = null;
  let sweeping = null;
  let signingIn = null;
  const lastPrompt = new Map();
  let lastSweep = null;

  function readState() {
    try { return { auto: true, ...JSON.parse(fs.readFileSync(statePath, "utf8")) }; } catch { return { auto: true }; }
  }
  function writeState(state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.renameSync(`${statePath}.tmp`, statePath);
  }

  async function management(pathname, { method = "GET", body } = {}) {
    const connection = cpaConnection();
    if (!connection) throw new Error("Managed CPA is not installed");
    const response = await fetchImpl(new URL(pathname, `${connection.baseUrl}/`), {
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${connection.managementKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    let value = {};
    try { value = await response.json(); } catch {}
    if (!response.ok) {
      const detail = typeof value?.error === "string" ? `: ${value.error.slice(0, 200)}` : "";
      const error = new Error(`CPA management request failed (HTTP ${response.status})${detail}`);
      error.status = response.status;
      throw error;
    }
    return value;
  }

  async function accounts() {
    const listing = await management("/v0/management/auth-files");
    return (Array.isArray(listing?.files) ? listing.files : [])
      .map(normalizedAuthFile).filter(entry => entry && PROVIDERS.has(entry.provider)).map(publicAccount);
  }

  async function refresh(name) {
    if (typeof name !== "string" || !name.trim() || name.length > 256) throw new Error("Choose a CPA account");
    try {
      // The response carries the refreshed credential; it is deliberately discarded here.
      await management(`/v0/management/auth-files/refresh?name=${encodeURIComponent(name)}`, { method: "POST" });
    } catch (error) {
      if (error.status === 404) throw new Error("This CPA build cannot refresh accounts; update CPA");
      const current = (await accounts()).find(account => account.name === name);
      return { ok: false, account: current ?? null, error: String(error.message).slice(0, 300) };
    }
    const current = (await accounts()).find(account => account.name === name);
    return { ok: Boolean(current && !needsAuth(current)), account: current ?? null };
  }

  /** CPA's own Antigravity OAuth. The old file is disabled (not deleted) once the new one exists. */
  async function signIn(name) {
    if (signingIn) return signingIn;
    signingIn = (async () => {
      const before = (await accounts()).find(account => account.name === name) ?? null;
      const result = await login({
        adapterId: "cpa-antigravity", identity: before?.email || "",
        requestJson: (pathname, options = {}) => management(pathname, options),
        openExternal,
      });
      const created = result.authFile;
      if (before && created && created.name !== before.name && created.identity
        && String(created.identity).toLowerCase() === String(before.email || "").toLowerCase()) {
        await management("/v0/management/auth-files/status", { method: "PATCH", body: { name: before.name, disabled: true } });
      }
      logger.info?.("cpa.antigravity_reauth.signed_in", { replaced: Boolean(before && created?.name !== before.name) });
      return { ok: true, account: created ? publicAccount(created) : null, replaced: before?.name ?? null };
    })().finally(() => { signingIn = null; });
    return signingIn;
  }

  async function sweep({ interactive = true } = {}) {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const report = { at: new Date(now()).toISOString(), refreshed: [], signIn: [], failed: [] };
      try {
        for (const account of await accounts()) {
          if (!needsAuth(account)) continue;
          const refreshed = await refresh(account.name).catch(error => ({ ok: false, error: error.message }));
          if (refreshed.ok) { report.refreshed.push(account.email || account.name); continue; }
          const key = account.email || account.name;
          const recentlyPrompted = lastPrompt.has(key) && now() - lastPrompt.get(key) < promptGapMs;
          if (!interactive || !readState().auto || signingIn || recentlyPrompted) {
            report.failed.push(key);
            continue;
          }
          lastPrompt.set(key, now());
          notify({ title: "Gemini sign-in expired", body: `Reconnecting ${key} in your browser for CPA.` });
          try { await signIn(account.name); report.signIn.push(key); }
          catch (error) { report.failed.push(key); logger.warn?.("cpa.antigravity_reauth.failed", { message: String(error.message).slice(0, 200) }); }
        }
      } catch (error) {
        report.error = String(error.message).slice(0, 300);
      }
      lastSweep = report;
      return report;
    })().finally(() => { sweeping = null; });
    return sweeping;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void sweep(); }, intervalMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  async function status() {
    let list = [];
    let error = null;
    try { list = await accounts(); } catch (cause) { error = String(cause.message).slice(0, 300); }
    return { ok: true, auto: readState().auto, accounts: list, needsAttention: list.filter(needsAuth).length,
      signingIn: Boolean(signingIn), lastSweep, error };
  }

  function setAuto(auto) {
    if (typeof auto !== "boolean") throw new Error("Choose on or off");
    writeState({ ...readState(), auto });
    return { ok: true, auto };
  }

  return Object.freeze({ accounts, refresh, signIn, sweep, start, stop, status, setAuto });
}

module.exports = { createAntigravityReauth, needsAuth, publicAccount };
