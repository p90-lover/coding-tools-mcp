"use strict";
const fs = require("node:fs");
const catalogCache = new Map();
const rateKeys = ["input_usd_per_million", "output_usd_per_million", "cache_read_usd_per_million",
  "cache_creation_usd_per_million", "request_usd"];
const count = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const validRate = row => row && typeof row.model === "string" && row.model.length <= 200
  && typeof row.provider === "string" && rateKeys.every(key => typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0);
const modelId = value => String(value || "").replace(/^cpa\//, "");

function readCpaCatalog(pricesPath) {
  try {
    const stat = fs.statSync(pricesPath);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("CPA price store exceeds its read limit");
    const cached = catalogCache.get(pricesPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.catalog;
    const saved = JSON.parse(fs.readFileSync(pricesPath, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.prices) || saved.prices.length > 10000) throw new Error("CPA price store has an unsupported format");
    const catalog = { prices: saved.prices.filter(validRate).map(row => ({
      provider: row.provider, model: row.model, ...Object.fromEntries(rateKeys.map(key => [key, row[key]])),
      source: row.source === "manual" ? "manual" : "imported", updated_ms: count(row.updated_ms),
    })), updated_ms: Math.trunc(stat.mtimeMs), source: "CPA Helper" };
    catalogCache.set(pricesPath, { mtimeMs: stat.mtimeMs, size: stat.size, catalog });
    return catalog;
  } catch {
    catalogCache.delete(pricesPath);
    return { prices: [], updated_ms: null, source: "CPA Helper", unavailable: true };
  }
}
function lookupCpaRate(catalog, model, providerId) {
  const id = modelId(model);
  const rows = (catalog?.prices || []).filter(row => validRate(row) && row.model === id && (!providerId || row.provider === providerId));
  return rows.length === 1 ? rows[0] : null;
}
function estimateCpaCost(measurement, rate) {
  const base = { totalNanos: null, coverage: "unavailable", source: "CPA Helper", priceUpdatedMs: count(rate?.updated_ms) };
  if (!validRate(rate)) return { ...base, reason: "Exact CPA price unavailable" };
  const input = count(measurement?.uncachedInputTokens), cached = count(measurement?.cachedInputTokens);
  const writes = count(measurement?.cacheCreationTokens), output = count(measurement?.outputTokens);
  if ([input, cached, writes, output, count(measurement?.processedTokens)].every(value => value === null)) return { ...base, reason: "Token usage not reported" };
  let usd = 0, pricedCategories = 0;
  let partial = measurement.source === "latest_snapshot" || measurement.incomplete === true;
  const charge = (tokens, usdPerMillion) => {
    if (tokens === null) { partial = true; return; }
    usd += tokens * usdPerMillion / 1000000; pricedCategories++;
  };
  if (measurement.cacheWritesPossible === true && writes === null) {
    if (rate.input_usd_per_million === rate.cache_creation_usd_per_million) charge(input, rate.input_usd_per_million);
    else partial = true;
  } else if (input !== null && writes !== null) {
    if (writes > input) return { ...base, reason: "Reported cache categories do not reconcile" };
    charge(input - writes, rate.input_usd_per_million); charge(writes, rate.cache_creation_usd_per_million);
  } else {
    charge(input, rate.input_usd_per_million); if (measurement.cacheWritesPossible === true) partial = true;
  }
  charge(cached, rate.cache_read_usd_per_million); charge(output, rate.output_usd_per_million);
  if (rate.request_usd > 0) {
    const requests = count(measurement.requestCount);
    if (requests === null) partial = true; else usd += requests * rate.request_usd;
  }
  const nanos = Math.round(usd * 1000000000);
  if (!pricedCategories || !Number.isSafeInteger(nanos) || nanos < 0) return { ...base, reason: "Categorized usage unavailable" };
  return { ...base, totalNanos: nanos, coverage: partial ? "partial" : "complete", ...(partial ? { reason: "Only reported categories are priced" } : {}) };
}
function accountingMeasurements(normalized, conversation, fallbackModel, fallbackHarness) {
  const result = [];
  for (const harness of normalized?.harnesses || []) for (const model of harness.models || []) {
    const totals = model.totals || {};
    if ([totals.inputTokens, totals.uncachedInputTokens, totals.cachedInputTokens, totals.outputTokens, totals.processedTokens].every(value => count(value) === null)) continue;
    result.push({ model: model.modelId, source: "normalized_session", incomplete: normalized.incomplete === true,
      inputTokens: count(totals.inputTokens), uncachedInputTokens: count(totals.uncachedInputTokens),
      cachedInputTokens: count(totals.cachedInputTokens), outputTokens: count(totals.outputTokens),
      processedTokens: count(totals.processedTokens), cacheCreationTokens: null,
      cacheWritesPossible: true });
  }
  if (result.length) return result;
  const usage = conversation?.usage;
  if (!usage || [usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.totalTokens].every(value => count(value) === null)) return [];
  const input = count(usage.inputTokens), cached = count(usage.cachedTokens);
  return [{ model: modelId(fallbackModel), source: "latest_snapshot", incomplete: true,
    inputTokens: input, cachedInputTokens: cached, outputTokens: count(usage.outputTokens),
    uncachedInputTokens: input !== null && cached !== null && cached <= input ? input - cached : null,
    cacheCreationTokens: null, cacheWritesPossible: true, processedTokens: count(usage.totalTokens), harness: fallbackHarness }];
}
async function collectMissionAccounting({ runs, projectId, readSession, catalog }) {
  const references = new Map(), missing = new Set(), wanted = new Map();
  for (const run of [...(runs || [])].reverse()) {
    const ids = new Set();
    for (const node of run.nodes || []) for (const receipt of [...(node.history || []), node.receipt].filter(Boolean)) {
      const id = receipt.thread_id;
      if (!projectId || !receipt.route?.harness_id?.startsWith("ao:") || typeof id !== "string"
          || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) { missing.add(run.id); continue; }
      ids.add(id);
      if (!wanted.has(id)) wanted.set(id, receipt.route);
    }
    references.set(run.id, ids);
  }
  const measured = new Map(), entries = [...wanted.entries()];
  // Bound a board refresh; never start a session or guess ownership from an ID.
  for (let offset = 0; offset < Math.min(entries.length, 200); offset += 4) {
    await Promise.all(entries.slice(offset, Math.min(offset + 4, 200)).map(async ([id, route]) => {
      try {
        const data = await readSession(id);
        if (data?.session?.id !== id || data.session.projectId !== projectId) return;
        if (data.normalized && data.normalized.sessionId !== id) return;
        const measurements = accountingMeasurements(data.normalized, data.conversation, route.model, route.harness_id.slice(3));
        if (measurements.length) measured.set(id, { sessionId: id, measurements: measurements.map(value => ({
          ...value, cost: estimateCpaCost(value, route.model?.startsWith("cpa/") ? lookupCpaRate(catalog, value.model) : null),
        })) });
      } catch { /* A missing counter is unavailable, not zero. Other missions still render. */ }
    }));
  }
  const result = {};
  for (const run of runs || []) {
    const ids = references.get(run.id), sessions = [...ids].map(id => measured.get(id)).filter(Boolean);
    const values = sessions.flatMap(session => session.measurements);
    const tokenCounts = values.map(value => count(value.processedTokens)).filter(value => value !== null);
    let processedTokens = tokenCounts.length ? tokenCounts.reduce((sum, value) => sum + value, 0) : null;
    if (!Number.isSafeInteger(processedTokens)) processedTokens = null;
    const partial = missing.has(run.id) || sessions.length !== ids.size
      || values.some(value => value.source === "latest_snapshot" || value.incomplete || value.processedTokens === null);
    const costs = values.map(value => value.cost).filter(cost => cost.totalNanos !== null);
    let totalNanos = costs.length ? costs.reduce((sum, cost) => sum + cost.totalNanos, 0) : null;
    if (!Number.isSafeInteger(totalNanos)) totalNanos = null;
    result[run.id] = {
      processedTokens, coverage: values.length ? (partial ? "partial" : "complete") : "unavailable",
      sessions, measuredSessions: sessions.length, requestedSessions: ids.size,
      cost: { source: "CPA Helper", priceUpdatedMs: count(catalog?.updated_ms), totalNanos, coverage: totalNanos === null ? "unavailable"
        : partial || costs.length !== values.length || costs.some(cost => cost.coverage !== "complete") ? "partial" : "complete" },
    };
  }
  return result;
}
module.exports = { readCpaCatalog, lookupCpaRate, estimateCpaCost, accountingMeasurements, collectMissionAccounting };
