"use strict";

const { requestJson } = require("../lib/loopback.cjs");
const { modelIdsFromCatalog, publicError, resolveLoopback } = require("../lib/openai.cjs");
const { sanitizePublic } = require("../lib/sanitize.cjs");

const OAUTH_ROUTES = Object.freeze({
  codex: "codex-auth-url",
  anthropic: "anthropic-auth-url",
  antigravity: "antigravity-auth-url",
});

function requiredParameter(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\x00-\x1f]/.test(value)) {
    throw new Error(`${name} must be a non-empty string of at most 1024 characters`);
  }
  return value.trim();
}

function managementOperations(getOrigin) {
  async function request(context, pathname, method = "GET") {
    const connection = resolveLoopback(getOrigin, context);
    if (!Object.keys(connection.managementHeaders).length) {
      throw new Error("CPA management key is unavailable; configure the managed CPA service first");
    }
    const response = await requestJson(connection.origin, {
      pathname: `/v0/management/${pathname}`,
      method,
      headers: connection.managementHeaders,
    });
    if (!response.ok) throw new Error(`CPA management API returned HTTP ${response.status}`);
    if (method === "DELETE" && response.status === 204) return {};
    if (!response.json || typeof response.json !== "object") {
      throw new Error("CPA management API returned an invalid JSON response");
    }
    return response.json;
  }

  function operation(readOnly, description, execute) {
    return {
      readOnly,
      description,
      async run(args, context) {
        try {
          return sanitizePublic({ ok: true, ...await execute(args, context) });
        } catch (error) {
          return { ok: false, reason: publicError(error) };
        }
      },
    };
  }

  return {
    authFileModels: operation(true, "List models for a CPA auth file; never returns its credentials.", async (args, context) => {
      const name = requiredParameter(args.name, "name");
      const catalog = await request(context, `auth-files/models?name=${encodeURIComponent(name)}`);
      return { name, models: modelIdsFromCatalog(catalog) };
    }),
    oauthStart: operation(false, "Start CPA OAuth for codex, anthropic or antigravity. The user must open the returned HTTPS URL and approve sign-in.", async (args, context) => {
      const provider = requiredParameter(args.provider, "provider");
      if (!Object.hasOwn(OAUTH_ROUTES, provider)) throw new Error("Unsupported CPA OAuth provider");
      const result = await request(context, `${OAUTH_ROUTES[provider]}?is_webui=true`);
      const state = requiredParameter(result.state, "OAuth state");
      const url = new URL(requiredParameter(result.url, "OAuth URL"));
      if (result.status !== "ok" || url.protocol !== "https:" || url.username || url.password) {
        throw new Error("CPA returned an invalid OAuth authorization URL");
      }
      return { provider, state, url: url.toString(), status: "pending" };
    }),
    oauthStatus: operation(true, "Check a CPA OAuth session; pending is not a connected account.", async (args, context) => {
      const state = requiredParameter(args.state, "state");
      const result = await request(context, `get-auth-status?state=${encodeURIComponent(state)}`);
      return {
        ok: result.status !== "error",
        state,
        status: result.status === "ok" ? "connected" : result.status === "error" ? "error" : "pending",
        ...(result.status === "error" ? { reason: "CPA authentication failed; inspect CPA logs locally" } : {}),
      };
    }),
    oauthCancel: operation(false, "Cancel an outstanding CPA OAuth session.", async (args, context) => {
      const state = requiredParameter(args.state, "state");
      await request(context, `oauth-session?state=${encodeURIComponent(state)}`, "DELETE");
      return { state, status: "cancelled" };
    }),
    plugins: operation(true, "List installed CPA plugins through its authenticated management API.", async (_args, context) => ({
      catalog: await request(context, "plugins"),
    })),
    pluginStore: operation(true, "Read the CPA plugin store without installing or executing code.", async (_args, context) => ({
      catalog: await request(context, "plugin-store"),
    })),
  };
}

module.exports = { managementOperations };
