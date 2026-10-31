"use strict";

// The 5-hour and weekly usage limits of the Codex accounts CPA serves Codex models from, for the
// chat's context meter (shown as Claude Code shows plan usage limits). CPA Helper, the bundled CPA
// plugin, keeps each account's quota from chatgpt.com's usage endpoint; this reads its cached list
// with CPA's management key, which stays in the main process. Only usage numbers and each
// account's own label reach the renderer, never a token. A quota older than STALE_MS is asked
// to refresh (CPA Helper's own refresh, at most once per account per STALE_MS), so the next read
// is current without the user opening CPA.

const CACHE_MS = 20_000;
const STALE_MS = 60_000;
const REFRESH_PER_READ = 4;
const TIMEOUT_MS = 8_000;
const MAX_ACCOUNTS = 12;

const finite = (value) => (Number.isFinite(value) ? value : null);
const text = (value, max = 120) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** One quota window from CPA Helper: { used_percent, reset_at_ms, window_seconds }. */
function windowOf(value) {
  if (!value || typeof value !== "object") return null;
  const used = finite(value.used_percent);
  if (used === null) return null;
  return { usedPercent: Math.max(0, Math.min(100, used)), resetsAt: finite(value.reset_at_ms), windowSeconds: finite(value.window_seconds) };
}

/**
 * An account's credits from CPA Helper 0.1.1+ (null before): they pay for every request once a
 * window is full. The balance stays the exact decimal string chatgpt.com sent.
 */
function creditsOf(value) {
  if (!value || typeof value !== "object") return null;
  const balance = text(value.balance, 40);
  return { balance: /^-?\d+(\.\d+)?$/.test(balance) ? balance : null, hasCredits: value.has_credits === true,
    unlimited: value.unlimited === true, overageReached: value.overage_limit_reached === true };
}

/** A quota check's error in words: a sign-in CPA can no longer use reads as such. */
function errorText(value) {
  const message = text(value, 200);
  if (!message) return null;
  return /unauthori[sz]ed|\b40[12]\b|invalidated|expired/i.test(message)
    ? "Signed out: this account's sign-in has expired. Sign in to it again in CPA." : message;
}

/** An item of CPA Helper's codex/accounts, as the meter shows it. */
function accountOf(item) {
  const quota = item?.quota && typeof item.quota === "object" ? item.quota : {};
  // Only a quota check knows the plan; before one, CPA Helper reports the credential's type ("oauth").
  const plan = text(quota.plan, 40);
  return {
    id: text(String(item?.auth_index ?? ""), 64),
    label: text(item?.email) || text(item?.label) || text(item?.account) || text(item?.name) || "Codex account",
    plan: plan && !/^(unknown|oauth|api[_-]?key)$/i.test(plan) ? plan : null,
    disabled: item?.disabled === true,
    // CPA Helper's keeper lowers an account at its limit to priority -1 until it recovers.
    paused: Number(item?.priority) === -1,
    session: windowOf(quota.primary),
    week: windowOf(quota.secondary),
    credits: creditsOf(quota.credits),
    checkedAt: finite(quota.checked_ms) || null,
    error: errorText(quota.error) || (item?.unavailable ? errorText(item?.status_message) || "Unavailable" : null),
  };
}

/**
 * Accounts that serve requests first: CPA Helper lists them in file order, and the cap kept the
 * first MAX_ACCOUNTS. Seen live 2026-10-24: nine signed-out and three unchecked accounts filled
 * it, and the one working Plus account (at 100% of its 5-hour window) was never shown. Working
 * accounts (an exhausted one included: it is the one to watch), then unchecked, then disabled,
 * then those with an error; CPA's order within each.
 */
function rank(account) {
  if (account.error) return 3;
  if (account.disabled) return 2;
  return account.checkedAt ? 0 : 1;
}

function createCpaQuota({ getConnection, fetchImpl = fetch, now = Date.now, logger = console } = {}) {
  let cached = null; // { at, value }
  let pending = null;
  const refreshedAt = new Map(); // auth_index -> ms

  function connection() {
    const value = getConnection?.();
    if (!value?.baseUrl || !value.managementKey) return null;
    const url = new URL(value.baseUrl);
    // Only the managed loopback CPA ever receives the management key.
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return { base: url.origin, key: value.managementKey };
  }

  async function request(target, method, path, body) {
    const response = await fetchImpl(`${target.base}/v0/management/cpa-helper${path}`, {
      method, headers: { Authorization: `Bearer ${target.key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response;
  }

  /** Asks CPA Helper to re-check stale accounts, in the background; their next read is current. */
  function refreshStale(target, accounts) {
    const at = now();
    const stale = accounts.filter((account) => account.id && !account.disabled
      && (!account.checkedAt || at - account.checkedAt >= STALE_MS) && at - (refreshedAt.get(account.id) ?? 0) >= STALE_MS)
      .sort((a, b) => (refreshedAt.get(a.id) ?? 0) - (refreshedAt.get(b.id) ?? 0))
      .slice(0, REFRESH_PER_READ);
    for (const account of stale) {
      refreshedAt.set(account.id, at);
      void request(target, "POST", "/codex/refresh", { auth_index: account.id })
        .then(() => { cached = null; })
        .catch((error) => logger.warn?.("cpa_quota.refresh_failed", { message: String(error?.message ?? error).slice(0, 200) }));
    }
  }

  async function load() {
    const target = connection();
    if (!target) return { ok: true, available: false, reason: "CPA is not running" };
    let response;
    try { response = await request(target, "GET", "/codex/accounts"); }
    catch { return { ok: true, available: false, reason: "CPA did not answer" }; }
    if (response.status === 404) return { ok: true, available: false, reason: "CPA Helper is not installed in CPA" };
    if (response.status === 401 || response.status === 403) return { ok: true, available: false, reason: "CPA refused the management key" };
    if (!response.ok) return { ok: true, available: false, reason: `CPA answered HTTP ${response.status}` };
    const payload = await response.json().catch(() => null);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const ranked = items.map(accountOf).map((account, index) => ({ account, index }))
      .sort((a, b) => rank(a.account) - rank(b.account) || a.index - b.index).map(({ account }) => account);
    // Every account stays re-checked, not only the ones shown: one signed in again past the cap
    // would otherwise keep its old error, and stay hidden.
    refreshStale(target, ranked);
    return { ok: true, available: true, accounts: ranked.slice(0, MAX_ACCOUNTS) };
  }

  /** The accounts' limits, cached CACHE_MS; concurrent reads share one request. */
  async function read() {
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    if (!pending) {
      pending = load().then((value) => { cached = { at: now(), value }; return value; }).finally(() => { pending = null; });
    }
    return pending;
  }

  return Object.freeze({ read });
}

module.exports = Object.freeze({ createCpaQuota, accountOf, windowOf, STALE_MS });
