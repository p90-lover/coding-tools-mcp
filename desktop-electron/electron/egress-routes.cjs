"use strict";
// Who goes where (docs/specs/rewrite-the-proxy): the egress router's table, worked out from the saved
// routes. Pure functions; provider-network.cjs feeds them the store and pushes the result to the
// router (egress-router.cjs).
//
// Targets:
//   app                  everything that is not model traffic (the App route = Global Routing)
//   cpa                  CPA's default for model traffic ("All model providers")
//   provider:<type>      one CPA provider type: codex, claude, gemini, antigravity, provider-manager …
//   credential:<name>    one CPA credential (auth file name)
//   browser:<partition>  one Browser-tab account
// Resolution: credential → provider → cpa → app; browser → app; app → its proxy or direct.
// A route that names a missing or disabled proxy is broken: the router fails it, never goes direct.
const crypto = require("node:crypto");

// The app's older provider ids for the same CPA provider types.
const PROVIDER_TYPE_ALIASES = Object.freeze({
  "codex-oauth": "codex",
  "claude-oauth": "claude",
  "anthropic-api": "claude",
  "gemini-oauth": "gemini",
  "cliproxyapi-antigravity": "antigravity",
});
// What every program the app starts reaches without the router: loopback only (AO, CPA, the bridge
// and the router itself talk on it). Everything else goes through the router, which applies the
// route's own bypass list.
const LOOPBACK_BYPASS = Object.freeze(["localhost", "127.0.0.1", "::1", "*.localhost"]);
const CREDENTIAL_MODES = new Set(["follow", "direct", "profile"]);

/** The CPA provider type an app provider id stands for (its own id when there is no alias). */
function providerType(providerId) {
  const id = String(providerId ?? "").trim();
  return PROVIDER_TYPE_ALIASES[id] ?? id;
}

/** The route token a target signs in to the router with: readable for app and cpa, else a hash. */
function routeToken(target) {
  if (target === "app" || target === "cpa") return target;
  const kind = String(target).split(":")[0];
  const prefix = kind === "provider" ? "p" : kind === "credential" ? "c" : kind === "browser" ? "b" : "t";
  return `${prefix}-${crypto.createHash("sha256").update(String(target)).digest("hex").slice(0, 20)}`;
}

/** The proxy URL a consumer is given for `target`: the router with its token. Never a real proxy. */
function routerUrl({ port, key, target }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The egress router has no port yet");
  if (typeof key !== "string" || !key) throw new Error("The egress router has no key");
  return `http://${routeToken(target)}:${key}@127.0.0.1:${port}`;
}

/** NO_PROXY for programs the app starts. */
function noProxyList() {
  return LOOPBACK_BYPASS.join(",");
}

/**
 * The router's table and what each target resolves to.
 * - `routing`: the saved routing (`globalEnabled`, `globalProfileId`, `providers`, `credentials`).
 * - `profileRoute(profileId)`: `{ mode: "proxy", profileId, endpoint, credentials, bypass }` for a
 *   usable proxy, or `{ mode: "broken", reason }`.
 * - `credentials`: CPA's credentials `[{ name, provider }]`; `browserBindings`: `[{ partition, profileId }]`.
 * Returns `{ table: { tokens, targets }, describe }`; `describe` is per target
 * `{ target, policy, route, from }` for the Proxy page (no sign-ins in it).
 */
function resolveEgressRoutes({ routing = {}, profileRoute, credentials = [], browserBindings = [], extraProviders = [] }) {
  const targets = {};
  const describe = {};
  const tokens = {};
  const record = (target, route, policy, from) => {
    targets[target] = route;
    tokens[routeToken(target)] = target;
    describe[target] = { target, policy, from, route: publicRoute(route) };
  };
  const named = (profileId) => profileRoute(profileId) ?? { mode: "broken", reason: "This route's proxy is missing" };

  // App: Global Routing.
  const appRoute = routing.globalEnabled
    ? (routing.globalProfileId ? named(routing.globalProfileId) : { mode: "broken", reason: "Global Routing is on but names no proxy" })
    : { mode: "direct" };
  record("app", appRoute, { mode: routing.globalEnabled ? "profile" : "direct", profileId: routing.globalProfileId ?? null }, "app");

  // A provider policy, as setProviderPolicy saves it: a profileId is that proxy (saved with
  // inheritGlobal true); inheritGlobal false without one is Direct; anything else follows.
  const providerPolicies = new Map();
  for (const policy of routing.providers ?? []) {
    const type = policy.providerId === "cpa" ? "cpa" : providerType(policy.providerId);
    // An exact CPA type wins over an older alias saved for the same type.
    if (providerPolicies.has(type) && policy.providerId !== type) continue;
    providerPolicies.set(type, policy);
  }
  const fromPolicy = (policy, fallback, fallbackFrom) => {
    if (policy?.profileId) return { route: named(policy.profileId), policy: { mode: "profile", profileId: policy.profileId }, from: "self" };
    if (policy?.inheritGlobal === false) return { route: { mode: "direct" }, policy: { mode: "direct" }, from: "self" };
    return { route: fallback, policy: { mode: "follow" }, from: fallbackFrom };
  };

  const cpa = fromPolicy(providerPolicies.get("cpa"), appRoute, "app");
  record("cpa", cpa.route, cpa.policy, cpa.from === "self" ? "cpa" : "app");

  const types = new Set([...providerPolicies.keys()].filter((type) => type !== "cpa"));
  for (const credential of credentials) if (credential?.provider) types.add(String(credential.provider));
  for (const type of extraProviders) if (type) types.add(String(type));
  const providerResult = new Map();
  for (const type of types) {
    const resolved = fromPolicy(providerPolicies.get(type), cpa.route, describe.cpa.from);
    providerResult.set(type, resolved);
    record(`provider:${type}`, resolved.route, resolved.policy, resolved.from === "self" ? `provider:${type}` : resolved.from);
  }

  const credentialPolicies = new Map((routing.credentials ?? []).map((policy) => [policy.authName, policy]));
  for (const credential of credentials) {
    const name = String(credential?.name ?? "").trim();
    if (!name) continue;
    const type = String(credential.provider ?? "");
    const parent = providerResult.get(type) ?? { route: cpa.route, from: describe.cpa.from };
    const parentFrom = type && describe[`provider:${type}`] ? describe[`provider:${type}`].from : describe.cpa.from;
    const policy = credentialPolicies.get(name);
    if (!policy || policy.mode === "follow") record(`credential:${name}`, parent.route, { mode: "follow" }, parentFrom);
    else if (policy.mode === "direct") record(`credential:${name}`, { mode: "direct" }, { mode: "direct" }, `credential:${name}`);
    else record(`credential:${name}`, named(policy.profileId), { mode: "profile", profileId: policy.profileId }, `credential:${name}`);
  }

  for (const binding of browserBindings) {
    const partition = String(binding?.partition ?? "").trim();
    if (!partition) continue;
    if (binding.profileId) record(`browser:${partition}`, named(binding.profileId), { mode: "profile", profileId: binding.profileId }, `browser:${partition}`);
    else record(`browser:${partition}`, appRoute, { mode: "follow" }, "app");
  }
  return { table: { tokens, targets, modelFallback: "cpa" }, describe };
}

/** A route without its sign-in, for logs and the Proxy page. */
function publicRoute(route) {
  if (!route || route.mode === "direct") return { mode: "direct" };
  if (route.mode === "broken") return { mode: "broken", reason: route.reason || "This route is broken" };
  return { mode: "proxy", profileId: route.profileId, protocol: route.endpoint?.protocol, host: route.endpoint?.host, port: route.endpoint?.port };
}

/** A saved credential route, validated. */
function normalizeCredentialPolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  const authName = String(policy.authName ?? "").trim();
  if (!authName || authName.length > 300 || /[\r\n]/.test(authName)) return null;
  const mode = CREDENTIAL_MODES.has(policy.mode) ? policy.mode : "follow";
  const profileId = typeof policy.profileId === "string" && policy.profileId.trim() ? policy.profileId.trim().slice(0, 160) : null;
  if (mode === "profile" && !profileId) return null;
  // Its CPA provider type, so the route resolves before CPA's credential list is read.
  const provider = typeof policy.provider === "string" && /^[a-z0-9:_.-]{1,80}$/i.test(policy.provider.trim()) ? providerType(policy.provider.trim()) : null;
  return { authName, ...(provider ? { provider } : {}), mode, ...(mode === "profile" ? { profileId } : {}) };
}

module.exports = {
  LOOPBACK_BYPASS, PROVIDER_TYPE_ALIASES,
  noProxyList, normalizeCredentialPolicy, providerType, publicRoute, resolveEgressRoutes, routeToken, routerUrl,
};
