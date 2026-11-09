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
  // Connects the user asked for that are waiting or running (hold()): none of this runs meanwhile.
  let holds = 0;
  const admitted = (options) => holds === 0 && deps.canRun(options);

  async function scan() {
    const revision = generation;
    await deps.prepare?.();
    if (!admitted() || revision !== generation) return;
    const accounts = deps.accounts();
    for (const id of attempts.keys()) {
      if (!accounts.some(account => account.id === id)) attempts.delete(id);
    }
    for (const account of accounts) {
      if (!admitted()) return;
      try {
        const target = deps.target(account.id);
        if (!target) continue;
        let connecting = false;
        const current = () => revision === generation && admitted({ connecting })
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
        let gaveWay = false;
        try {
          connecting = true;
          const result = await deps.connect(account.id, current);
          if (result?.connected !== true) throw new Error("ChatGPT did not confirm the exact connector state.");
        } catch (error) {
          // It stopped for an account switch (automaticSetupGaveWay): no failure, and it runs again.
          // An account switch is over in a moment, so by now this setup may be admitted again.
          gaveWay = error?.gaveWay === true;
          deps.logger?.warn?.(gaveWay ? "browser_accounts.automatic_mcp_deferred" : "browser_accounts.automatic_mcp_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        } finally { connecting = false; }
        if (gaveWay || !current()) {
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
      if (!admitted()) return Promise.resolve();
      inFlight = scan().catch(error => deps.logger?.warn?.("browser_accounts.automatic_mcp_pending", {
        message: error instanceof Error ? error.message : String(error),
      })).finally(() => { inFlight = null; });
      return inFlight;
    },
    // An explicit runtime/tunnel restart starts a new round, even with unchanged login cookies.
    invalidate() { generation++; attempts.clear(); },
    /**
     * A Connect the user asked for comes first. Until the returned release runs, no round starts, and
     * one already connecting fails its admission check at its next step, so it gives way (deferred,
     * not failed). Release once; later calls do nothing.
     */
    hold() {
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
      };
    },
  };
}

/**
 * Whether an automatic connector setup stopped because it gave way, not because it failed: the shown
 * account changed under it (a switch, which no longer waits for it) or its admission no longer holds
 * (the app lost focus, a turn started). A manual setup, with no admission check, always failed.
 */
function automaticSetupGaveWay(assertAdmitted, accountChanged) {
  if (typeof assertAdmitted !== "function") return false;
  if (accountChanged()) return true;
  try {
    assertAdmitted();
    return false;
  } catch {
    return true;
  }
}

module.exports = { automaticSetupGaveWay, createBrowserAccountMcpSync };
