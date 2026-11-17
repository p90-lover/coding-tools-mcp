"use strict";

const fs = require("fs");
const path = require("path");

// Maps a CPA auth-file type (or Provider Manager kind) to a Provider Center catalog id.
// Unknown kinds still appear, under the compatible API-key provider, so the list is complete.
const TYPE_TO_PROVIDER = Object.freeze({
  antigravity: { providerId: "cliproxyapi-antigravity", auth: "oauth" },
  codex: { providerId: "codex-oauth", auth: "oauth" },
  claude: { providerId: "claude-oauth", auth: "oauth" },
  anthropic: { providerId: "claude-oauth", auth: "oauth" },
  gemini: { providerId: "gemini-oauth", auth: "oauth" },
  "gemini-cli": { providerId: "gemini-oauth", auth: "oauth" },
  cline: { providerId: "custom-openai-compatible", auth: "api_key" },
  commandcode: { providerId: "commandcode-studio", auth: "oauth" },
  "commandcode-go": { providerId: "commandcode-proxy", auth: "oauth" },
  grok: { providerId: "custom-openai-compatible", auth: "oauth" },
  openai: { providerId: "openai-api", auth: "api_key" },
  "opencode-go": { providerId: "custom-openai-compatible", auth: "api_key" },
});

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function markerKind(name, kind) {
  if (kind) return kind;
  const match = /^cpa-provider-manager-(.+)\.json$/i.exec(name);
  return match ? String(match[1]).toLowerCase() : "";
}

function providerMapping(type, kind) {
  if (type === "provider-manager") {
    const mappedKind = kind.replace(/-\d+$/, "");
    return TYPE_TO_PROVIDER[kind] || TYPE_TO_PROVIDER[mappedKind] || (kind
      ? { providerId: "custom-openai-compatible", auth: "api_key" }
      : null);
  }
  return TYPE_TO_PROVIDER[type] || { providerId: "custom-openai-compatible", auth: "oauth" };
}

function safeMeta(name, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = String(raw.type || raw.provider || "").toLowerCase();
  const kind = markerKind(name, String(raw.kind || raw.kindType || "").toLowerCase());
  return {
    name,
    type: type || "unknown",
    kind,
    email: typeof raw.email === "string" && raw.email.trim() ? raw.email.trim() : null,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null,
    disabled: raw.disabled === true,
  };
}

function remainingFromQuota(quota) {
  if (!quota) return null;
  const balances = Array.isArray(quota.balances) ? quota.balances : [];
  const balance = balances.find((item) => item && (item.remaining != null || item.kind)) || null;
  if (!balance) return null;
  return {
    remaining: balance.remaining == null ? null : Number(balance.remaining),
    currency: typeof balance.currency === "string" ? balance.currency : null,
    kind: typeof balance.kind === "string" ? balance.kind : null,
  };
}

function toPublicAccount(meta, quotas, now) {
  const mapping = providerMapping(meta.type, meta.kind);
  if (!mapping) return null;
  const at = now instanceof Date ? now.toISOString() : String(now);
  const identity = meta.email || (meta.type === "provider-manager" ? meta.name.replace(/\.json$/i, "") : null);
  const label = meta.label || meta.email || meta.name.replace(/\.json$/i, "");
  const quotaKey = meta.name.replace(/^cpa-provider-manager-/i, "").replace(/\.json$/i, "");
  const remainingBalance = remainingFromQuota(quotas[quotaKey] || quotas[meta.name] || quotas[identity] || null);
  return {
    id: "cpa-auth:" + meta.name,
    providerId: mapping.providerId,
    label,
    identity,
    endpoint: null,
    auth: mapping.auth,
    status: meta.disabled ? "disabled" : "connected",
    enabled: !meta.disabled,
    isDefault: false,
    models: [],
    loginAdapterId: null,
    credentialSource: "cpa",
    archivedAt: null,
    error: null,
    hasCredential: true,
    remainingBalance,
    displayOnly: true,
    createdAt: at,
    updatedAt: at,
  };
}

async function listCpaAuthAccounts({ directory, quotas = {}, now = new Date() } = {}) {
  if (!directory) return [];
  let names;
  try { names = await fs.promises.readdir(directory); } catch { return []; }
  const accounts = await Promise.all(names.sort().map(async (name) => {
    if (!/\.json$/i.test(name)) return null;
    let raw;
    try { raw = JSON.parse(await fs.promises.readFile(path.join(directory, name), "utf8")); } catch { return null; }
    const meta = safeMeta(name, raw);
    if (!meta) return null;
    return toPublicAccount(meta, quotas, now);
  }));
  return accounts.filter(Boolean);
}

function sameLiveAccount(storeAccount, cpaAccount) {
  if (!storeAccount || !cpaAccount) return false;
  if (storeAccount.providerId && cpaAccount.providerId && storeAccount.providerId !== cpaAccount.providerId) return false;
  const left = normalizeIdentity(storeAccount.identity || storeAccount.label);
  const right = normalizeIdentity(cpaAccount.identity || cpaAccount.label);
  return Boolean(left && right && left === right);
}

function mergeProviderAccounts(storeAccounts, cpaAccounts) {
  const store = Array.isArray(storeAccounts) ? storeAccounts : [];
  const live = Array.isArray(cpaAccounts) ? cpaAccounts : [];
  const used = new Set();
  const merged = store.map((account) => {
    const match = live.find((item) => !used.has(item.id) && sameLiveAccount(account, item));
    if (!match) return { ...account, remainingBalance: account.remainingBalance ?? null };
    used.add(match.id);
    return {
      ...account,
      remainingBalance: account.remainingBalance ?? match.remainingBalance ?? null,
    };
  });
  for (const account of live) {
    if (!used.has(account.id)) merged.push(account);
  }
  return merged;
}

function overlayCpaAccounts(snapshot, cpaAccounts) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  return {
    ...snapshot,
    accounts: mergeProviderAccounts(snapshot.accounts, cpaAccounts),
  };
}

module.exports = {
  listCpaAuthAccounts,
  mergeProviderAccounts,
  overlayCpaAccounts,
  remainingFromQuota,
  TYPE_TO_PROVIDER,
};
