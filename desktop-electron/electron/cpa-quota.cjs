"use strict";
const { fetchOffThread } = require("./off-thread-run.cjs");

// The plan limits and routing state of the sign-in accounts CPA serves Codex and Claude models
// from, for the chat's context panel. CPA (8.0.63+) keeps the rate-limit headers of each
// account's latest upstream reply in its auth-files listing (`quota.signals`: x-codex-* for
// Codex, anthropic-ratelimit-unified-* for Claude) next to its own cooldown (`unavailable`,
// `next_retry_after`). Provider Manager 0.10.0 dropped the quota list this used to read, and
// nothing asks the providers again: an account has a reading once it served a request since CPA
// started. The management key stays in the main process; only numbers, states and each
// account's own label reach the renderer, never a token.

const CACHE_MS = 20_000;
const TIMEOUT_MS = 8_000;
const MAX_ACCOUNTS = 12;
const DAY_SECONDS = 86_400;
const FIVE_HOURS = 18_000;
const WEEK = 604_800;
const PLAN_PROVIDERS = new Set(["codex", "claude"]);

const text = (value, max = 120) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const percent = (value) => Math.max(0, Math.min(100, value));
const flag = (value) => /^(true|1|yes)$/i.test(text(String(value ?? ""), 8));

/** A header value as a finite number, else null. */
function number(value) {
  const parsed = typeof value === "number" ? value : text(value, 40) ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Unix seconds, milliseconds or an RFC 3339 time as epoch ms; Go's zero time is null. */
function timeOf(value) {
  if (typeof value === "number") return value > 0 ? (value < 1e11 ? value * 1000 : value) : null;
  const numeric = number(value);
  if (numeric !== null) return timeOf(numeric);
  const at = Date.parse(text(value, 40));
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** The latest reply's quota headers, by lower-case name. */
function signalsOf(file) {
  const raw = file?.quota?.signals;
  const signals = {};
  if (!raw || typeof raw !== "object") return signals;
  for (const [name, value] of Object.entries(raw)) if (typeof value === "string") signals[name.toLowerCase()] = value;
  return signals;
}

/**
 * Codex's primary and secondary windows. Codex names them by length, not by slot: a plan with a
 * single weekly limit sends it as primary (window-minutes 10080), so a window of a day or more is
 * the weekly one whichever slot carried it.
 */
function codexWindows(signals, observedAt) {
  const windows = { session: null, week: null };
  for (const slot of ["primary", "secondary"]) {
    const used = number(signals[`x-codex-${slot}-used-percent`]);
    if (used === null) continue;
    const minutes = number(signals[`x-codex-${slot}-window-minutes`]);
    const after = number(signals[`x-codex-${slot}-reset-after-seconds`]);
    const resetsAt = timeOf(signals[`x-codex-${slot}-reset-at`]) ?? (after !== null && after >= 0 && observedAt ? observedAt + after * 1000 : null);
    const windowSeconds = minutes !== null && minutes > 0 ? minutes * 60 : null;
    const weekly = windowSeconds !== null ? windowSeconds >= DAY_SECONDS : slot === "secondary";
    const key = weekly ? "week" : "session";
    if (!windows[key]) windows[key] = { usedPercent: percent(used), resetsAt, windowSeconds };
  }
  return windows;
}

/** Claude's five-hour and seven-day windows; utilization is a fraction of the limit. */
function claudeWindow(signals, name, seconds) {
  const used = number(signals[`anthropic-ratelimit-unified-${name}-utilization`]);
  if (used === null) return null;
  return { usedPercent: percent(used * 100), resetsAt: timeOf(signals[`anthropic-ratelimit-unified-${name}-reset`]), windowSeconds: seconds };
}

/** A Codex account's credits, which pay for requests once a window is full; the balance stays chatgpt.com's exact decimal. */
function codexCredits(signals) {
  const balance = text(signals["x-codex-credits-balance"], 40);
  const has = signals["x-codex-credits-has-credits"];
  const unlimited = signals["x-codex-credits-unlimited"];
  if (!balance && has === undefined && unlimited === undefined) return null;
  return { balance: /^-?\d+(\.\d+)?$/.test(balance) ? balance : null, hasCredits: flag(has), unlimited: flag(unlimited),
    overageReached: flag(signals["x-codex-credits-overage-limit-reached"]) };
}

const SIGNED_OUT = /unauthori[sz]ed|\b40[13]\b|invalidated|expired|refresh token|sign in/i;

/**
 * One account of CPA's auth-files listing as the panel shows it, or null for any provider other
 * than Codex or Claude, or for an API key from CPA's config (it has no plan windows).
 *
 * state: "ready" (CPA can route to it), "limited" (at a limit or cooling down until resumesAt),
 * "disabled", "signed-out" (its sign-in no longer works) or "error".
 */
function accountFromAuthFile(file, now = Date.now()) {
  const provider = text(file?.provider ?? file?.type, 40).toLowerCase();
  if (!PLAN_PROVIDERS.has(provider) || file?.runtime_only === true) return null;
  const id = text(String(file?.auth_index ?? file?.authIndex ?? ""), 64);
  if (!id) return null;
  const signals = signalsOf(file);
  const checkedAt = timeOf(file?.quota?.observed_at);
  const windows = provider === "codex" ? codexWindows(signals, checkedAt)
    : { session: claudeWindow(signals, "5h", FIVE_HOURS), week: claudeWindow(signals, "7d", WEEK) };
  const idToken = file?.id_token && typeof file.id_token === "object" ? file.id_token : {};
  const plan = text(signals["x-codex-plan-type"], 40) || text(idToken.plan_type ?? idToken.chatgpt_plan_type, 40)
    || (provider === "claude" ? text(file?.account_type, 40) : "");
  const status = text(file?.status, 20).toLowerCase();
  const message = text(file?.status_message, 200);
  const disabled = file?.disabled === true || status === "disabled";
  const cooldown = timeOf(file?.next_retry_after);
  const retryAfter = number(signals["retry-after"]);
  const refused = flag(signals["x-codex-limit-reached"]) || signals["x-codex-allowed"]?.toLowerCase() === "false"
    || signals["anthropic-ratelimit-unified-status"]?.toLowerCase() === "rejected";
  const full = [windows.session, windows.week].filter((window) => window?.usedPercent >= 100 && window.resetsAt > now);
  const limitedUntil = cooldown && cooldown > now && file?.unavailable === true ? cooldown
    : full.length ? Math.max(...full.map((window) => window.resetsAt))
      : refused && retryAfter !== null && checkedAt && checkedAt + retryAfter * 1000 > now ? checkedAt + retryAfter * 1000 : null;
  const state = disabled ? "disabled" : status === "error" ? (SIGNED_OUT.test(message) ? "signed-out" : "error")
    : limitedUntil ? "limited" : "ready";
  return {
    id, provider,
    label: text(file?.email) || text(file?.label) || text(file?.account) || text(file?.name).replace(/\.json$/i, "") || (provider === "codex" ? "Codex account" : "Claude account"),
    plan: plan && !/^(unknown|oauth|api[_-]?key|free_workspace)$/i.test(plan) ? plan : null,
    state, disabled, paused: state === "limited", resumesAt: limitedUntil,
    session: windows.session, week: windows.week, credits: provider === "codex" ? codexCredits(signals) : null,
    checkedAt,
    error: state === "signed-out" ? "Signed out: sign in to this account again in CPA." : state === "error" ? message || "Unavailable" : null,
  };
}

/**
 * Accounts CPA can use first, so a long list of signed-out ones cannot hide them past the cap:
 * ready ones with a reading (latest first, the one most likely serving now), ready ones without,
 * limited ones (soonest back first), disabled, then those with an error.
 */
function rank(account) {
  if (account.state === "ready") return account.checkedAt ? 0 : 1;
  return { limited: 2, disabled: 3 }[account.state] ?? 4;
}
function byUse(a, b) {
  return rank(a.account) - rank(b.account)
    || (rank(a.account) === 0 ? b.account.checkedAt - a.account.checkedAt : 0)
    || (rank(a.account) === 2 ? a.account.resumesAt - b.account.resumesAt : 0)
    || a.index - b.index;
}

/**
 * One provider's whole routing pool, past the list's cap: what "X/Y ready" and "first back in"
 * count. A switched-off account is listed but not in the pool.
 */
function poolOf(accounts) {
  const back = accounts.filter((account) => account.state === "limited" && account.resumesAt).map((account) => account.resumesAt);
  return {
    total: accounts.length,
    enabled: accounts.filter((account) => account.state !== "disabled").length,
    ready: accounts.filter((account) => account.state === "ready").length,
    resumesAt: back.length ? Math.min(...back) : null,
  };
}

function createCpaQuota({ getConnection, fetchImpl = fetchOffThread, now = Date.now, logger = console } = {}) {
  let active = null; // { base, key, cached, pending }

  function connection() {
    let value = null;
    try { value = getConnection?.(); } catch { return null; }
    if (!value?.baseUrl || !value.managementKey) return null;
    let url;
    try { url = new URL(value.baseUrl); } catch { return null; }
    // Only the managed loopback CPA ever receives the management key.
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return { base: url.origin, key: value.managementKey };
  }

  async function load(target) {
    let response;
    try {
      response = await fetchImpl(`${target.base}/v0/management/auth-files`, {
        method: "GET", headers: { Authorization: `Bearer ${target.key}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn?.("cpa_quota.read_failed", { message: String(error?.message ?? error).slice(0, 200) });
      return { ok: true, available: false, reason: "CPA did not answer" };
    }
    if (response.status === 401 || response.status === 403) return { ok: true, available: false, reason: "CPA refused the management key" };
    if (!response.ok) return { ok: true, available: false, reason: `CPA answered HTTP ${response.status}` };
    const payload = await response.json().catch(() => null);
    if (target !== active) return { ok: true, available: false, reason: "CPA connection changed while reading quota" };
    const at = now();
    const ranked = (Array.isArray(payload?.files) ? payload.files : []).map((file, index) => ({ account: accountFromAuthFile(file, at), index }))
      .filter((entry) => entry.account).sort(byUse).map((entry) => entry.account);
    const accounts = [];
    const pools = {};
    for (const provider of PLAN_PROVIDERS) {
      const all = ranked.filter((account) => account.provider === provider);
      accounts.push(...all.slice(0, MAX_ACCOUNTS));
      if (all.length) pools[provider] = poolOf(all);
    }
    return { ok: true, available: true, accounts, pools };
  }

  /** The accounts' limits, cached CACHE_MS per connection; concurrent reads share one request. */
  async function read() {
    const target = connection();
    if (!target) {
      active = null;
      return { ok: true, available: false, reason: "CPA is not running" };
    }
    if (!active || active.base !== target.base || active.key !== target.key) active = { ...target, cached: null, pending: null };
    const state = active;
    if (state.cached && now() - state.cached.at < CACHE_MS) return state.cached.value;
    if (!state.pending) {
      state.pending = load(state).then((value) => { state.cached = { at: now(), value }; return value; })
        .finally(() => { state.pending = null; });
    }
    return state.pending;
  }

  return Object.freeze({ read });
}

module.exports = Object.freeze({ createCpaQuota, accountFromAuthFile, CACHE_MS });
