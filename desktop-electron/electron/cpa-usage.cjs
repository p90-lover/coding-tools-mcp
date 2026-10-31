"use strict";

const { MODEL_PRICES } = require("./cpa-model-prices.cjs");

// Each CPA account's token use, request count and estimated cost, for the CPA accounts view and
// the chat's context meter, with what is known of its quota (Codex: CPA Helper's 5-hour and weekly
// windows, through cpa-quota.cjs; Cline Pass: the switcher's per-key activity).
//
// Where the numbers come from: CPA v8 keeps no usage totals of its own. Its management API only
// offers /v0/management/usage-queue, a pop-once queue that holds a record for 60 s, so reading it
// would take records from anyone else and lose everything while the app is closed. CPA Helper, the
// bundled plugin, already receives every request through CPA's usage hook, keeps them for 90 days
// and groups them by account (auth_index) and model, with a cost from its own price book. This
// reads those groups with CPA's management key, which stays in the main process. Models the
// price book does not price are estimated from cpa-model-prices.cjs, and the result says which.
//
// Only counts, costs and each account's own label reach the renderer: never a key, a token, a
// client API key or an upstream error that might quote one. CPA's usage "source" of an API-key
// account is the key itself, so a label is taken from CPA's auth file list, never from it.

const CACHE_MS = 20_000;
const TIMEOUT_MS = 8_000;
const MAX_ACCOUNTS = 40;
/** Accounts whose usage is split by model (one more CPA Helper read each). */
const MAX_SPLIT_ACCOUNTS = 24;
/**
 * Those split reads in flight at once. All of them together (up to 24 range aggregations over CPA
 * Helper's records, beside the overall ones) hit the CPA that serves the chats' model requests in
 * one burst, every refresh of every chat's context meter; on 2026-10-22 sixteen of them timed out
 * in the same second.
 */
const SPLIT_CONCURRENCY = 3;
const MAX_MODELS = 12;
const DAY_MS = 24 * 60 * 60_000;
const RANGES = Object.freeze({ "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, all: null });
const DEFAULT_RANGE = "30d";
/** A turn's request stats are read again after this; the line polls while the chat is open. */
const TURN_CACHE_MS = 3_000;
/** An ended turn's numbers are final this long after it ended (the helper logs a request as it ends), and kept 10 min. */
const TURN_SETTLE_MS = 30_000;
const ENDED_TURN_CACHE_MS = 10 * 60_000;
// A turn's records are read 500 at a time, up to 40 pages (20,000 model requests) per model.
const TURN_PAGE_SIZE = 500;
const TURN_RECORD_PAGES = 40;
// Record reads in flight at once, for every turn together: opening a chat reads each ended turn's
// foot, and 17 at once timed out together in a disk stall (2026-10-31). The rest wait their turn.
const RECORD_CONCURRENCY = 3;

const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const money = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const text = (value, max = 120) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round = (value, places = 6) => (value === null ? null : Number(value.toFixed(places)));

/** A model's own name, as the price table matches it: "cpa/codex/gpt-5(high)" -> "gpt-5". */
function modelKey(model) {
  const name = text(model, 200).toLowerCase().replace(/\([^)]*\)\s*$/, "").trim();
  return name.slice(name.lastIndexOf("/") + 1);
}

/** The estimated list price of a model (cpa-model-prices.cjs), or null when none is known. */
function priceFor(model, table = MODEL_PRICES) {
  const key = modelKey(model);
  if (!key) return null;
  return table.find((row) => row.pattern.test(key)) ?? null;
}

/** USD for tokens at a list price; cached input is part of input, as CPA Helper counts it. */
function estimateCost({ inputTokens = 0, cachedTokens = 0, outputTokens = 0 }, price) {
  if (!price) return null;
  const cached = Math.min(count(cachedTokens), count(inputTokens));
  const fresh = count(inputTokens) - cached;
  const cachedRate = Number.isFinite(price.cachedInput) ? price.cachedInput : price.input;
  return (fresh * price.input + cached * cachedRate + count(outputTokens) * price.output) / 1_000_000;
}

/** One group of CPA Helper's rankings (an account or a model), as counts. */
function usageOf(row) {
  return {
    requests: count(row?.requests),
    failed: count(row?.failed),
    inputTokens: count(row?.input_tokens),
    outputTokens: count(row?.output_tokens),
    cachedTokens: count(row?.cached_tokens),
    reasoningTokens: count(row?.reasoning_tokens),
    totalTokens: count(row?.total_tokens),
    helperCost: money(row?.cost_usd),
    unpriced: count(row?.unpriced),
  };
}

/**
 * The cost of one model's use: CPA Helper's own when its price book priced every request, else
 * an estimate from the price table, else what CPA Helper could price (partial), else unknown.
 */
function cellCost(usage, model) {
  if (!usage.requests && !usage.totalTokens) return { cost: 0, source: null, partial: false };
  if (!usage.unpriced) return { cost: usage.helperCost, source: "cpa-helper", partial: false };
  const estimate = estimateCost(usage, priceFor(model));
  if (estimate !== null) return { cost: estimate, source: "estimate", partial: false };
  return usage.helperCost > 0 ? { cost: usage.helperCost, source: "cpa-helper", partial: true } : { cost: null, source: null, partial: true };
}

/** Several costs as one: a sum, where it came from, and whether some tokens had no price. */
function combineCosts(costs) {
  let total = null;
  let partial = false;
  const sources = new Set();
  for (const item of costs) {
    if (item.partial) partial = true;
    if (item.cost === null) continue;
    total = (total ?? 0) + item.cost;
    if (item.source) sources.add(item.source);
  }
  const source = sources.size > 1 ? "mixed" : sources.values().next().value ?? null;
  return { cost: round(total), costSource: source, costPartial: partial };
}

const ADD_KEYS = ["requests", "failed", "inputTokens", "outputTokens", "cachedTokens", "reasoningTokens", "totalTokens"];
const emptyUsage = () => Object.fromEntries(ADD_KEYS.map((key) => [key, 0]));
function addUsage(target, usage) {
  for (const key of ADD_KEYS) target[key] += usage[key] || 0;
  return target;
}
const publicUsage = (usage) => Object.fromEntries(ADD_KEYS.map((key) => [key, usage[key] || 0]));

/** A model's row of an account's split, with its cost. */
function modelRow(row) {
  const usage = usageOf(row);
  const model = text(row?.key, 200) || text(row?.label, 200) || "unknown";
  const cost = cellCost(usage, model);
  const price = priceFor(model);
  return {
    model, provider: text(row?.extra, 40).toLowerCase() || null, ...publicUsage(usage),
    cost: round(cost.cost), costSource: cost.source, costPartial: cost.partial,
    priceLabel: cost.source === "estimate" && price ? price.label : null,
  };
}

/** An account's display label from CPA's auth file entry: its email or label, never a key. */
function fileLabel(file) {
  return text(file?.email) || text(file?.account) || text(file?.label) || text(file?.name) || "";
}

/** CPA Helper's label for an account it saw is the usage "source": an email is fine, a key is not. */
function safeSourceLabel(value) {
  const label = text(value, 120);
  return /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(label) ? label : "";
}

/** Error text the renderer may show: short, and without anything that looks like a credential. */
function safeError(value) {
  return text(typeof value === "string" ? value : value ? JSON.stringify(value) : "", 400)
    .replace(/(bearer\s+|sk-|key[=:]\s*)[\w.-]+/gi, "$1…")
    .replace(/[A-Za-z0-9_-]{32,}/g, "…")
    .slice(0, 200);
}

/** How a Cline Pass key last did, from the switcher's last error for it. */
function clineState(account) {
  if (!account.enabled) return "disabled";
  const error = account.lastError || "";
  if (error && /\b429\b|rate.?limit|quota|insufficient|credit|exceed|limit reached|限流/i.test(error)) return "limited";
  if (error && /unauthori[sz]ed|\b401\b|\b403\b|invalid.*key|re-?authenticate|密钥无效/i.test(error)) return "signed-out";
  if (error) return "error";
  return account.requests ? "ok" : "unused";
}

/**
 * The Cline Pass switcher's account pool (GET /api/accounts through CPA), as the renderer may see
 * it. Cline reports no remaining quota or credit for a Cline Pass key, and the switcher keeps none:
 * only each key's request count, last use and last error, which tells a key at its limit (429).
 */
function clineQuotaOf(payload) {
  const list = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const stats = payload?.stats && typeof payload.stats === "object" ? payload.stats : {};
  const mode = payload?.mode === "roundrobin" ? "roundrobin" : "single";
  const enabledIndexes = list.map((account, index) => (account && account.enabled !== false && account.key ? index : -1)).filter((index) => index >= 0);
  const activeIndex = Number.isInteger(payload?.active) && enabledIndexes.includes(payload.active) ? payload.active : enabledIndexes[0] ?? -1;
  const accounts = list.slice(0, MAX_ACCOUNTS).map((account, index) => {
    const name = text(account?.name, 50) || `Account ${index + 1}`;
    const stat = stats[account?.name] && typeof stats[account?.name] === "object" ? stats[account.name] : {};
    const enabled = account?.enabled !== false && Boolean(account?.key);
    const entry = {
      name, enabled,
      // Single mode sends every request with the chosen key; round-robin rotates the enabled ones.
      active: enabled && (mode === "roundrobin" || index === activeIndex),
      requests: count(stat.requests),
      lastUsedAt: finite(stat.lastUsed) || null,
      lastError: stat.lastError ? safeError(stat.lastError) : null,
    };
    return { ...entry, state: clineState(entry) };
  });
  return { kind: "cline", reported: false, mode, accounts };
}

/** CPA Helper's Codex quota for one account (cpa-quota.cjs), without its id and label. */
function codexQuotaOf(account) {
  if (!account) return null;
  return {
    kind: "codex", plan: account.plan ?? null, paused: account.paused === true,
    session: account.session ?? null, week: account.week ?? null, checkedAt: account.checkedAt ?? null, error: account.error ?? null,
  };
}

/**
 * Joins CPA Helper's per-account and per-model usage with CPA's account list and the quotas known,
 * into what the views show: one row per account (busiest first), the busiest models and totals.
 *
 * authRows: rankings?group=auth items; modelsByAuth: Map of the row key -> rankings?group=model
 * items for that account; modelRows: rankings?group=model items overall; authFiles: CPA's
 * auth-files listing (null when unreadable); codexAccounts: cpa-quota.cjs accounts; cline: the
 * switcher's /api/accounts payload (null when unavailable).
 */
function aggregateUsage({ authRows = [], modelsByAuth = new Map(), modelRows = [], authFiles = null, codexAccounts = [], cline = null } = {}) {
  const files = Array.isArray(authFiles) ? authFiles : [];
  const fileByIndex = new Map();
  for (const file of files) {
    const index = text(String(file?.auth_index ?? file?.authIndex ?? ""), 64);
    if (index) fileByIndex.set(index, file);
    const name = text(file?.name, 200);
    if (name && !fileByIndex.has(name)) fileByIndex.set(name, file);
  }
  const codexByIndex = new Map(codexAccounts.filter((account) => account?.id).map((account) => [account.id, account]));
  const rows = new Map(); // id -> account row

  const rowFor = (id, file) => {
    if (rows.has(id)) return rows.get(id);
    const provider = text(file?.provider ?? file?.type, 40).toLowerCase() || null;
    const row = {
      id, label: fileLabel(file), provider, disabled: file?.disabled === true,
      ...emptyUsage(), cost: 0, costSource: null, costPartial: false, models: [], quota: null,
    };
    rows.set(id, row);
    return row;
  };

  // Every account CPA has, used or not, so a quiet account still shows (with its quota).
  for (const file of files) {
    const id = text(String(file?.auth_index ?? file?.authIndex ?? ""), 64) || text(file?.name, 200);
    if (id) rowFor(id, file);
  }

  for (const item of authRows) {
    const key = text(String(item?.key ?? ""), 300);
    const file = fileByIndex.get(key) ?? null;
    const id = file ? text(String(file.auth_index ?? file.authIndex ?? ""), 64) || text(file.name, 200) : key || "(none)";
    const row = rowFor(id, file);
    if (!row.label) row.label = safeSourceLabel(item?.label) || (key ? `Account ${key.slice(0, 8)}` : "No account (direct API key)");
    const usage = usageOf(item);
    addUsage(row, usage);
    const split = modelsByAuth.get(key);
    if (Array.isArray(split) && split.length) {
      const models = split.map(modelRow).sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
      row.models = models.slice(0, 6);
      Object.assign(row, combineCosts(models.map((model) => ({ cost: model.cost, source: model.costSource, partial: model.costPartial }))));
      if (!row.provider) row.provider = models.find((model) => model.provider)?.provider ?? null;
    } else {
      // No split: CPA Helper's own price covers it only when it priced every request.
      const cost = cellCost(usage, "");
      row.cost = round(cost.cost);
      row.costSource = cost.source;
      row.costPartial = cost.partial;
    }
  }

  for (const row of rows.values()) {
    if (!row.label) row.label = "CPA account";
    const codex = codexByIndex.get(row.id);
    if (codex) {
      row.quota = codexQuotaOf(codex);
      if (!row.provider) row.provider = "codex";
    }
  }

  if (cline) {
    const quota = clineQuotaOf(cline);
    // CPA sees one Cline account, the switcher's bridge (cpa-managed.cjs writes its auth file);
    // the switcher spreads its requests over the Cline Pass keys behind it.
    let bridge = [...rows.values()].find((row) => row.provider === "cline");
    if (!bridge) bridge = rowFor("cline-pass-switcher", { provider: "cline", label: "Cline Pass" });
    bridge.quota = quota;
  }

  const accounts = [...rows.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests || a.label.localeCompare(b.label))
    .slice(0, MAX_ACCOUNTS);
  const totals = addUsage(emptyUsage(), {});
  for (const row of accounts) addUsage(totals, row);
  Object.assign(totals, combineCosts(accounts.filter((row) => row.requests || row.totalTokens)
    .map((row) => ({ cost: row.cost, source: row.costSource, partial: row.costPartial }))));
  const models = modelRows.map(modelRow).sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests).slice(0, MAX_MODELS);
  return { accounts, totals, models };
}

/** `fn` over `items`, at most `limit` at a time; the results keep the items' order. */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function createCpaUsage({ getConnection, quota = null, fetchImpl = fetch, now = Date.now, logger = console } = {}) {
  const cache = new Map(); // range -> { at, value }
  const pending = new Map(); // range or turn key -> Promise
  let recordReads = 0;
  const recordQueue = [];

  /** Runs one record read when fewer than RECORD_CONCURRENCY are in flight; a finished one hands its slot on. */
  async function recordSlot(read) {
    if (recordReads >= RECORD_CONCURRENCY) await new Promise((resolve) => recordQueue.push(resolve));
    else recordReads += 1;
    try { return await read(); }
    finally {
      const next = recordQueue.shift();
      if (next) next(); else recordReads -= 1;
    }
  }

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

  async function get(target, path) {
    const response = await fetchImpl(`${target.base}/v0/management${path}`, {
      method: "GET", headers: { Authorization: `Bearer ${target.key}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = response.ok ? await response.json().catch(() => null) : null;
    return { status: response.status, ok: response.ok, body };
  }

  /** A read that may fail without failing the view: null when it did. */
  async function optional(target, path) {
    try {
      const result = await get(target, path);
      return result.ok ? result.body : null;
    } catch (error) {
      logger.warn?.("cpa_usage.read_failed", { path: path.split("?")[0], message: String(error?.message ?? error).slice(0, 200) });
      return null;
    }
  }

  async function load(range) {
    const target = connection();
    if (!target) return { ok: true, available: false, reason: "CPA is not running" };
    const span = RANGES[range];
    const from = span ? now() - span : null;
    const query = (extra) => {
      const params = new URLSearchParams(extra);
      if (from) params.set("from", String(from));
      return params.toString();
    };
    let byAuth;
    try { byAuth = await get(target, `/cpa-helper/rankings?${query({ group: "auth" })}`); }
    catch { return { ok: true, available: false, reason: "CPA did not answer" }; }
    if (byAuth.status === 404) return { ok: true, available: false, reason: "CPA Helper is not installed in CPA, and CPA keeps no usage history of its own" };
    if (byAuth.status === 401 || byAuth.status === 403) return { ok: true, available: false, reason: "CPA refused the management key" };
    if (!byAuth.ok) return { ok: true, available: false, reason: `CPA answered HTTP ${byAuth.status}` };
    const authRows = Array.isArray(byAuth.body?.items) ? byAuth.body.items.slice(0, MAX_ACCOUNTS) : [];

    const [modelListing, fileListing, codex, splits] = await Promise.all([
      optional(target, `/cpa-helper/rankings?${query({ group: "model" })}`),
      optional(target, "/auth-files"),
      quota?.read ? quota.read().catch(() => null) : null,
      mapLimited(authRows.slice(0, MAX_SPLIT_ACCOUNTS).filter((row) => row?.key), SPLIT_CONCURRENCY, async (row) => {
        const listing = await optional(target, `/cpa-helper/rankings?${query({ group: "model", auth: String(row.key) })}`);
        return [String(row.key), Array.isArray(listing?.items) ? listing.items : null];
      }),
    ]);
    const authFiles = Array.isArray(fileListing?.files) ? fileListing.files : null;
    // The switcher's pool only matters when CPA has its bridge account (or the list is unreadable).
    const hasCline = !authFiles || authFiles.some((file) => String(file?.provider ?? file?.type ?? "").toLowerCase() === "cline");
    const cline = hasCline ? await optional(target, "/cline-pass-switcher/api/accounts") : null;

    const result = aggregateUsage({
      authRows, modelsByAuth: new Map(splits), authFiles,
      modelRows: Array.isArray(modelListing?.items) ? modelListing.items : [],
      codexAccounts: codex?.available && Array.isArray(codex.accounts) ? codex.accounts : [],
      cline: cline && Array.isArray(cline.accounts) ? cline : null,
    });
    return { ok: true, available: true, range, from, refreshedAt: now(), source: "CPA Helper", ...result };
  }

  /** Usage for a range ("24h", "7d", "30d" or "all"), cached CACHE_MS; concurrent reads share one load. */
  async function read({ range } = {}) {
    const key = Object.hasOwn(RANGES, range) ? range : DEFAULT_RANGE;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    if (!pending.has(key)) {
      pending.set(key, load(key)
        .then((value) => { cache.set(key, { at: now(), value }); return value; })
        .finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }

  /**
   * One chat turn's model requests, as the line under the chat box shows them: how many requests
   * (steps), time spent in the model, average time to first token, output speed, cache hits and
   * tokens. CPA Helper records each request CPA serves with its latency and time to first token;
   * those of the turn's model since the turn started are this turn's (another chat on the same
   * model at the same moment would be counted too). Cached a few seconds per turn.
   */
  /**
   * Every record of `name` since `start`, page by page. One page of 500 capped a long turn's line
   * at "1000 steps" (500 per model) and undercounted its time and tokens. Stops at a short page or
   * at a page that brings nothing new, so a helper that ignores `page` is read once, never twice.
   * Null when the first page cannot be read.
   */
  async function turnRecords(target, name, start, end) {
    const items = [];
    const seen = new Set();
    for (let page = 1; page <= TURN_RECORD_PAGES; page += 1) {
      const listing = await recordSlot(() => optional(target, `/cpa-helper/records?${new URLSearchParams({
        model: name, from: String(Math.floor(start)), ...(end ? { to: String(Math.ceil(end)) } : {}),
        page_size: String(TURN_PAGE_SIZE), page: String(page),
      })}`));
      if (!Array.isArray(listing?.items)) return page === 1 ? null : items;
      let fresh = 0;
      for (const item of listing.items) {
        const identity = JSON.stringify(item);
        if (seen.has(identity)) continue;
        seen.add(identity);
        items.push(item);
        fresh += 1;
      }
      if (listing.items.length < TURN_PAGE_SIZE || fresh === 0) break;
    }
    return items;
  }

  /**
   * `to`: a turn that ended, read up to then (CPA Helper's `to`, and filtered here for a helper
   * that ignores it). Its numbers no longer change, so they are kept for ENDED_TURN_CACHE_MS.
   */
  async function turnStats({ model, models, from, to } = {}) {
    const target = connection();
    const clean = (value) => String(value ?? "").replace(/^cpa\//, "").replace(/\((?:\d+|none|auto|minimal|low|medium|high|xhigh|max|ultra)\)$/i, "").trim().slice(0, 200);
    // A turn retried on another model (a failed or stopped attempt, then a new run) counts every
    // model it used since its first attempt started.
    const names = [...new Set([model, ...(Array.isArray(models) ? models : [])].map(clean).filter(Boolean))].slice(0, 4);
    const start = Number(from);
    if (!target || !names.length || !Number.isFinite(start) || start <= 0) return { ok: true, available: false };
    const end = Number(to) > start ? Number(to) : 0;
    // Settled once the helper has logged the turn's last request; until then it is read like a live one.
    const settled = end && now() - end > TURN_SETTLE_MS;
    const key = `turn:${names.join("|")}:${start}:${end}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < (settled ? ENDED_TURN_CACHE_MS : TURN_CACHE_MS)) return hit.value;
    // The same turn asked again while it is read (its foot and the line under the chat box) shares the read.
    if (pending.has(key)) return pending.get(key);
    const read = (async () => {
      const listings = await Promise.all(names.map((name) => turnRecords(target, name, start, end)));
      const records = listings.flatMap((items) => items ?? []).filter((item) => !end || !(recordTime(item) > end));
      const value = listings.some(Boolean)
        ? { ok: true, available: true, ...summarizeRecords(records) }
        : { ok: true, available: false };
      cache.set(key, { at: now(), value });
      for (const stale of cache.keys()) {
        const { at } = cache.get(stale);
        if (stale.startsWith("turn:") && now() - at > (stale.endsWith(":0") ? 60_000 : ENDED_TURN_CACHE_MS)) cache.delete(stale);
      }
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, read);
    return read;
  }

  return Object.freeze({ read, turnStats });
}

/** A record's time (CPA Helper's `ts`) in Unix ms, from ms, seconds or an ISO date; null when absent. */
function recordTime(item) {
  const value = item?.ts;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}

/**
 * The run of failed requests since the turn's model last answered: how many, with which HTTP status,
 * from when to when. A turn whose requests (its own, or a subagent's on the same model) CPA keeps
 * refusing shows nothing in the chat, where it read as a slow start or "may be stuck"; seen live
 * 2026-10-22 on MiMo V2.6 Pro. Only timed records count, newest last. Null without a failure there.
 */
function refusalOf(items) {
  const timed = items.filter((item) => item && typeof item === "object" && recordTime(item) !== null)
    .sort((a, b) => recordTime(a) - recordTime(b));
  let streak = 0;
  for (let index = timed.length - 1; index >= 0 && timed[index].failed === true; index -= 1) streak += 1;
  if (!streak) return null;
  const run = timed.slice(-streak);
  const statuses = {};
  for (const item of run) {
    const code = Number.isInteger(item.status_code) && item.status_code >= 100 && item.status_code < 600 ? String(item.status_code) : "none";
    statuses[code] = (statuses[code] ?? 0) + 1;
  }
  const latest = run.at(-1);
  return {
    streak,
    status: Number.isInteger(latest.status_code) && latest.status_code >= 100 && latest.status_code < 600 ? latest.status_code : null,
    statuses, since: recordTime(run[0]), lastAt: recordTime(latest),
  };
}

/** CPA Helper records -> one turn's totals; failed requests count as steps but not as speed. */
function summarizeRecords(items) {
  let steps = 0, failed = 0, latencyMs = 0, ttftSum = 0, ttftCount = 0, inputTokens = 0, outputTokens = 0, cachedTokens = 0;
  let speedTokens = 0, speedMs = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    steps += 1;
    if (item.failed === true) { failed += 1; continue; }
    const latency = count(item.latency_ms);
    const ttft = count(item.ttft_ms);
    const output = count(item.output_tokens);
    latencyMs += latency;
    if (ttft) { ttftSum += ttft; ttftCount += 1; }
    inputTokens += count(item.input_tokens);
    outputTokens += output;
    cachedTokens += count(item.cached_tokens);
    // Speed over the streaming part: from the first token to the end.
    if (output && latency > ttft) { speedTokens += output; speedMs += latency - ttft; }
  }
  return {
    steps, failed, latencyMs,
    ttftMs: ttftCount ? Math.round(ttftSum / ttftCount) : null,
    tokensPerSecond: speedMs ? Math.round((speedTokens / speedMs) * 1000) : null,
    cacheHit: inputTokens ? Math.min(1, cachedTokens / inputTokens) : null,
    inputTokens, outputTokens, cachedTokens,
    // When the newest request was logged: how long a turn ran when nothing else kept its end.
    lastAt: items.reduce((latest, item) => Math.max(latest, recordTime(item) ?? 0), 0) || null,
    refusal: refusalOf(items),
  };
}

module.exports = Object.freeze({
  createCpaUsage, aggregateUsage, summarizeRecords, refusalOf, recordTime, clineQuotaOf, priceFor, estimateCost, cellCost, modelKey, RANGES,
});
