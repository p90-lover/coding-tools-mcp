"use strict";

// Decodo's sticky proxy list, read in-app (ProxyBridge Nova's DecodoProxySync, ported now that the
// app no longer starts Nova). One GET to Decodo's endpoint generator returns up to `count`
// "http://user:pass@gate.decodo.com:port" endpoints, one sticky session each; every one becomes a
// proxy profile with an id derived from it, so a later sync updates it instead of adding a copy.
const crypto = require("node:crypto");

const DECODO_ENDPOINT_URL = "https://api.decodo.com/v2/endpoints-custom/back-connect";
const DECODO_REQUEST_TIMEOUT_MS = 30_000;
const MAX_DECODO_RESPONSE_BYTES = 2 * 1024 * 1024;
const DECODO_PROFILE_PREFIX = "decodo:";

function normalizeDecodoSettings(input = {}, previous = {}) {
  const pick = (key, fallback) => (input[key] === undefined ? previous[key] ?? fallback : input[key]);
  const username = String(pick("username", "") ?? "").trim().slice(0, 200);
  const country = String(pick("country", "") ?? "").trim().toLowerCase();
  const count = Number(pick("count", 10));
  const sessionMinutes = Number(pick("sessionMinutes", 60));
  if (country && !/^[a-z]{2}$/.test(country)) throw new Error("Use a two-letter country code, or leave it empty for any country");
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("Proxy count must be between 1 and 1000");
  if (!Number.isInteger(sessionMinutes) || sessionMinutes < 1 || sessionMinutes > 1440) {
    throw new Error("Session length must be between 1 and 1440 minutes");
  }
  return { username, country, count, sessionMinutes };
}

/** Decodo's API takes the proxy user's own credentials as query parameters (HTTPS only). */
function decodoRequestUrl(settings, password) {
  if (!settings.username || !password) throw new Error("Enter your Decodo proxy username and password");
  const query = new URLSearchParams({
    username: settings.username,
    password,
    session_type: "sticky",
    session_time: String(settings.sessionMinutes),
    count: String(settings.count),
    page: "1",
    protocol: "http",
    response_format: "json",
    output_format: "protocol:auth@endpoint",
  });
  if (settings.country) query.set("country", settings.country);
  return `${DECODO_ENDPOINT_URL}?${query}`;
}

function decodoProfileId(host, port, username) {
  const identity = `decodo|http|${host.toLowerCase()}|${port}|${username}`;
  return DECODO_PROFILE_PREFIX + crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

/**
 * Decodo's answer as proxy profile inputs. The documented response may be an array encoded inside
 * a JSON string. Anything but a Decodo host with credentials refuses the whole list, so a bad
 * answer never replaces saved proxies.
 */
function parseDecodoEndpoints(body, { country = "" } = {}) {
  let list = JSON.parse(body);
  if (typeof list === "string") list = JSON.parse(list);
  if (!Array.isArray(list) || list.length < 1 || list.length > 1000) {
    throw new Error("Decodo returned an empty or invalid endpoint list; your saved proxies were kept");
  }
  const profiles = new Map();
  for (const entry of list) {
    let url;
    try { url = new URL(String(entry)); } catch { url = null; }
    const host = url?.hostname.toLowerCase() ?? "";
    if (!url || url.protocol !== "http:" || !url.username || !url.password
      || !(host === "decodo.com" || host.endsWith(".decodo.com"))
      || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      throw new Error("Decodo returned an invalid proxy endpoint; your saved proxies were kept");
    }
    const port = Number(url.port || 80);
    const username = decodeURIComponent(url.username);
    const id = decodoProfileId(host, port, username);
    profiles.set(id, {
      id,
      name: `Decodo ${country ? `${country.toUpperCase()} ` : ""}${port}`,
      endpoint: { protocol: "http", host, port },
      username,
      password: decodeURIComponent(url.password),
    });
  }
  return [...profiles.values()];
}

async function fetchDecodoEndpoints(settings, password, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DECODO_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(decodoRequestUrl(settings, password), { redirect: "manual", signal: controller.signal });
  } catch {
    throw new Error("Decodo could not be reached; check the network and retry");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Decodo answered HTTP ${response.status}; check the subscription and proxy credentials`);
  const body = await response.text();
  if (body.length > MAX_DECODO_RESPONSE_BYTES) throw new Error("Decodo's answer is too large");
  return parseDecodoEndpoints(body, settings);
}

const isDecodoProfile = (profileId) => typeof profileId === "string" && profileId.startsWith(DECODO_PROFILE_PREFIX);

module.exports = {
  DECODO_ENDPOINT_URL,
  decodoRequestUrl,
  fetchDecodoEndpoints,
  isDecodoProfile,
  normalizeDecodoSettings,
  parseDecodoEndpoints,
};
