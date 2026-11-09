"use strict";

const { createHash } = require("node:crypto");
const { signedInFromCookies } = require("./browser-accounts.cjs");

// Cookie presence only selects candidates. A fresh session response authorizes inspection;
// the existing connector helper must still prove the exact account/workspace connection.
function createBrowserAccountMcpSync(deps) {
  const attempts = new Map();
  const now = deps.now ?? Date.now;
  let inFlight = null;
  let generation = 0;

  async function scan() {
    const revision = generation;
    await deps.prepare?.();
    if (!deps.canRun() || revision !== generation) return;
    const accounts = deps.accounts();
    for (const id of attempts.keys()) {
      if (!accounts.some(account => account.id === id)) attempts.delete(id);
    }
    for (const account of accounts) {
      if (!deps.canRun()) return;
      try {
        const target = deps.target(account.id);
        if (!target) continue;
        let connecting = false;
        const current = () => revision === generation && deps.canRun({ connecting })
          && deps.accounts().some(entry => entry.id === account.id && entry.partition === account.partition)
          && deps.target(account.id) === target;
        const cookies = await deps.readCookies(account.partition);
        if (!current()) continue;
        if (!signedInFromCookies(cookies)) {
          attempts.delete(account.id);
          continue;
        }
        // Only a fingerprint stays in memory; secrets never leave this partition or enter logs.
        const sessionKey = createHash("sha256").update(JSON.stringify(cookies
          .filter(cookie => cookie.name === "__Secure-next-auth.session-token"
            || cookie.name.startsWith("__Secure-next-auth.session-token."))
          .map(cookie => [cookie.name, cookie.value]).sort((a, b) => a[0].localeCompare(b[0])))).digest("hex");
        const key = `${account.partition}\0${target}\0${sessionKey}`;
        const errorAt = account.connector?.errorAt ?? null;
        const previous = attempts.get(account.id);
        if (previous?.key === key && previous.errorAt === errorAt && now() < previous.retryAt) continue;
        const proof = await deps.verifySignIn(account.partition);
        if (!current()) continue;
        if (proof?.sessionAuthenticated !== true || proof.sessionCheckError) {
          // Security/loading failures retry HTTP only: they never navigate an existing chat.
          attempts.set(account.id, { key, errorAt, retryAt: now() + 60_000 });
          continue;
        }
        attempts.set(account.id, { key, errorAt, retryAt: Infinity });
        try {
          connecting = true;
          const result = await deps.connect(account.id, current);
          if (result?.connected !== true) throw new Error("ChatGPT did not confirm the exact connector state.");
        } catch (error) {
          if (error?.automaticDeferred === true) {
            deps.logger?.info?.("browser_accounts.automatic_mcp_deferred", { reason: String(error.reason ?? "unknown").slice(0, 40) });
          } else {
            deps.logger?.warn?.("browser_accounts.automatic_mcp_failed", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } finally { connecting = false; }
        if (!current()) {
          // Losing admission defers work until focus/setup is available again.
          attempts.delete(account.id);
          continue;
        }
        // Our own recorded failure is not a new external failure that warrants another setup.
        const recorded = deps.accounts().find(entry => entry.id === account.id);
        attempts.set(account.id, { key, errorAt: recorded?.connector?.errorAt ?? null, retryAt: Infinity });
      } catch (error) {
        deps.logger?.warn?.("browser_accounts.automatic_mcp_scan_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    sync() {
      if (inFlight) return inFlight;
      if (!deps.canRun()) return Promise.resolve();
      inFlight = scan().catch(error => deps.logger?.warn?.("browser_accounts.automatic_mcp_pending", {
        message: error instanceof Error ? error.message : String(error),
      })).finally(() => { inFlight = null; });
      return inFlight;
    },
    // An explicit runtime/tunnel restart starts a new round, even with unchanged login cookies.
    invalidate() { generation++; attempts.clear(); },
  };
}

module.exports = { createBrowserAccountMcpSync };
