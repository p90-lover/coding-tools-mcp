"use strict";

// Keeps one ChatGPT account's OAuth tokens consistent between CPA's Codex auth file and the
// isolated desktop instance's CODEX_HOME/auth.json. OpenAI rotates refresh tokens, so both
// sides must always hold the newest pair or the stale side is logged out on its next refresh.

const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const TOKEN_FIELDS = Object.freeze(["id_token", "access_token", "refresh_token", "account_id"]);

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jwtClaims(token) {
  const payload = text(token)?.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function jwtExpiryIso(token) {
  const exp = jwtClaims(token)?.exp;
  return Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : null;
}

function jwtEmail(token) {
  const claims = jwtClaims(token);
  return text(claims?.email) ?? text(claims?.["https://api.openai.com/profile"]?.email);
}

// Codex writes RFC 3339 with nanoseconds; Date.parse only reliably handles milliseconds.
function parseRefreshTime(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(parsed) ? parsed : null;
}

// A normalized view of either file: { tokens: {id_token, access_token, refresh_token, account_id}, lastRefresh }.
function fromCpa(cpa) {
  if (!cpa || typeof cpa !== "object") return null;
  const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, text(cpa[field])]));
  return tokens.refresh_token ? { tokens, lastRefresh: parseRefreshTime(cpa.last_refresh) } : null;
}

function fromDesktop(desktop) {
  const source = desktop?.tokens;
  if (!source || typeof source !== "object") return null;
  const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, text(source[field])]));
  return tokens.refresh_token ? { tokens, lastRefresh: parseRefreshTime(desktop.last_refresh) } : null;
}

function desktopAuthFromCpa(cpa) {
  const normalized = fromCpa(cpa);
  if (!normalized) throw new Error("The CPA account has no refresh token to sign in with");
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: normalized.tokens,
    last_refresh: text(cpa.last_refresh) ?? new Date().toISOString(),
  };
}

function cpaWithDesktopTokens(cpa, desktop) {
  const normalized = fromDesktop(desktop);
  return {
    ...cpa,
    ...normalized.tokens,
    last_refresh: text(desktop.last_refresh) ?? new Date().toISOString(),
    expired: jwtExpiryIso(normalized.tokens.access_token) ?? cpa.expired,
  };
}

function desktopWithCpaTokens(desktop, cpa) {
  return { ...desktop, ...desktopAuthFromCpa(cpa), OPENAI_API_KEY: desktop.OPENAI_API_KEY ?? null };
}

/**
 * Decide which side holds the newer credentials.
 * @param {{tokens: object, lastRefresh: number|null}} desktop normalized desktop auth
 * @param {{tokens: object, lastRefresh: number|null}} cpa normalized CPA auth
 * @returns {"to-cpa" | "to-desktop" | null} where the newer tokens should be copied, or null to leave both
 */
function chooseSyncDirection(desktop, cpa) {
  if (desktop.tokens.refresh_token === cpa.tokens.refresh_token
    && desktop.tokens.access_token === cpa.tokens.access_token) return null;
  // A refresh rotates the refresh token, so the side refreshed last holds the only one that
  // still works. A side without a parseable refresh time loses to one with it; equal or
  // unknown times stay put rather than risk overwriting the live token with a dead one.
  const desktopAt = desktop.lastRefresh ?? -Infinity;
  const cpaAt = cpa.lastRefresh ?? -Infinity;
  if (desktopAt > cpaAt) return "to-cpa";
  if (cpaAt > desktopAt) return "to-desktop";
  return null;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeJson(filePath, value) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, { protectDirectory: false });
}

// Reconcile one account pair. Never copies across different ChatGPT accounts.
function syncAccountPair({ desktopPath, cpaPath }) {
  const cpaRaw = readJson(cpaPath);
  const desktopRaw = readJson(desktopPath);
  const cpa = fromCpa(cpaRaw);
  const desktop = fromDesktop(desktopRaw);
  if (!cpa || !desktop) return null;
  if (cpa.tokens.account_id && desktop.tokens.account_id && cpa.tokens.account_id !== desktop.tokens.account_id) {
    return null;
  }
  const direction = chooseSyncDirection(desktop, cpa);
  if (direction === "to-cpa") writeJson(cpaPath, cpaWithDesktopTokens(cpaRaw, desktopRaw));
  else if (direction === "to-desktop") writeJson(desktopPath, desktopWithCpaTokens(desktopRaw, cpaRaw));
  return direction;
}

module.exports = {
  chooseSyncDirection,
  desktopAuthFromCpa,
  fromCpa,
  fromDesktop,
  jwtEmail,
  jwtExpiryIso,
  parseRefreshTime,
  readJson,
  syncAccountPair,
  writeJson,
};
