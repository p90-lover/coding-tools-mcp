"use strict";

const { createHash } = require("node:crypto");
const { signedInFromCookies } = require("./browser-accounts.cjs");

// Cookie presence only selects candidates. A fresh session response authorizes inspection;
// the existing connector helper must still prove the exact account/workspace connection.
// A setup that gave way is tried again on the next pass once; one that keeps giving way waits
// longer each time. A setup loads chatgpt.com in hidden windows once per signed-in account, and
// with busy chats or the app losing focus it rarely finished: seen 2026-11-10, a round started and
// gave way every 1-2 minutes, starting 11 hidden renderer processes in 6 minutes, each 12-51 s of
// a chatgpt.com or OpenAI Platform page, and never connected anything.
const GAVE_WAY_RETRY_MS = 2 * 60_000;
const GAVE_WAY_RETRY_MAX_MS = 30 * 60_000;
// A setup that failed is tried again later, not never. Until 2026-11-13 one failure stopped automatic
// setup for that account until its sign-in cookie changed, so a page that loaded slowly on the busy
// disk, or a check that misread a signed-in account, left it unconnected for good. A failure waits
// 10 minutes, twice as long after each failure in a row, up to an hour; one that needs the person or a
// workspace owner waits the hour. Success starts over.
const FAILED_RETRY_MS = 10 * 60_000;
const FAILED_RETRY_MAX_MS = 60 * 60_000;
// ChatGPT or OpenAI Platform asked the account to sign in (ChatGPT's 401 for a revoked sign-in, its
// security check, Platform's login): no later try passes until the person signs in. Such a failure
// waits for that: a new ChatGPT sign-in in the account's partition, a sign-out, or a Connect by hand
// that connects it. The time it failed, a refreshed cookie, a failure recorded elsewhere or a tunnel
// restart do not end it. Seen 2026-11-19: signed-out accounts failed again after every tunnel adoption
// and account switch, each time loading chatgpt.com in hidden windows on a machine that already lagged.
const WAITS_FOR_SIGN_IN = new Set(["verification_required", "platform_sign_in_required"]);
const NEEDS_THE_PERSON = new Set(["workspace_owner_required",
  "workspace_admin_required", "workspace_publish_required", "tunnel_owner_mismatch", "platform_account_mismatch",
  "tunnel_permission_required", "configuration_required", "mcp_access_denied", "manual_browser_inspection_disabled"]);

/** A fingerprint of the account's ChatGPT sign-in cookie: the cookie itself never leaves its partition or enters logs. */
function sessionFingerprint(cookies) {
  return createHash("sha256").update(JSON.stringify(cookies
    .filter(cookie => cookie.name === "__Secure-next-auth.session-token"
      || cookie.name.startsWith("__Secure-next-auth.session-token."))
    .map(cookie => [cookie.name, cookie.value]).sort((a, b) => a[0].localeCompare(b[0])))).digest("hex");
}

function createBrowserAccountMcpSync(deps) {
  const attempts = new Map();
  // Per account: how many setups in a row gave way at this partition and target, and when the next
  // may start. Not keyed by the session cookie: loading ChatGPT may refresh it, which must not
  // count as a new reason to start over.
  const gaveWays = new Map();
  // Per account: how many setups in a row failed at this partition and target, the last one's code, and
  // what ends its wait (FAILED_RETRY_MS, WAITS_FOR_SIGN_IN). Kept across a restart of the same tunnel.
  const failures = new Map();
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
    for (const id of gaveWays.keys()) {
      if (!accounts.some(account => account.id === id)) gaveWays.delete(id);
    }
    for (const id of failures.keys()) {
      if (!accounts.some(account => account.id === id)) failures.delete(id);
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
        const place = `${account.partition}\0${target}`;
        const backoff = gaveWays.get(account.id);
        if (backoff?.place === place && now() < backoff.retryAt) continue;
        const cookies = await deps.readCookies(account.partition);
        if (!current()) continue;
        const failure = failures.get(account.id);
        if (!signedInFromCookies(cookies)) {
          attempts.delete(account.id);
          // Signed out: whatever signs it in next is the new sign-in its wait is for.
          if (WAITS_FOR_SIGN_IN.has(failure?.code)) failures.delete(account.id);
          continue;
        }
        // Only a fingerprint stays in memory; secrets never leave this partition or enter logs.
        const sessionKey = sessionFingerprint(cookies);
        const key = `${account.partition}\0${target}\0${sessionKey}`;
        const errorAt = account.connector?.errorAt ?? null;
        if (failure?.place === place) {
          const okAt = account.connector?.okAt ?? null;
          if (okAt !== null && okAt !== failure.okAt) {
            // Connected since it failed (a Connect by hand, or a turn found it bound): nothing to set up.
            failures.delete(account.id);
            attempts.set(account.id, { key, errorAt, retryAt: Infinity });
            continue;
          }
          // Checked before anything opens: a waiting account costs one cookie read, no HTTP and no window.
          if (WAITS_FOR_SIGN_IN.has(failure.code) ? failure.session === sessionKey : now() < failure.retryAt) continue;
        }
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
        let gaveWay = false, failed = null;
        try {
          connecting = true;
          const result = await deps.connect(account.id, current);
          if (result?.connected !== true) throw new Error("ChatGPT did not confirm the exact connector state.");
        } catch (error) {
          // It stopped for an account switch (automaticSetupGaveWay): no failure, and it runs again.
          // An account switch is over in a moment, so by now this setup may be admitted again.
          gaveWay = error?.gaveWay === true;
          if (!gaveWay) failed = error;
          deps.logger?.warn?.(gaveWay ? "browser_accounts.automatic_mcp_deferred" : "browser_accounts.automatic_mcp_failed", {
            message: error instanceof Error ? error.message : String(error),
            ...(typeof error?.code === "string" ? { code: error.code } : {}),
            // What the ChatGPT page showed when a Personal plugins wait gave up (counts and flags only).
            ...(error?.pageState && typeof error.pageState === "object" ? { pageState: error.pageState } : {}),
          });
        } finally { connecting = false; }
        if (gaveWay || !current()) {
          // Losing admission (a chat took the browser, a switch, a setup) defers work. A Connect the person
          // asked for (hold) is not counted: once it is done, this account is tried again at once.
          attempts.delete(account.id);
          if (holds === 0) {
            const count = backoff?.place === place ? backoff.count + 1 : 1;
            const wait = count === 1 ? 0 : Math.min(GAVE_WAY_RETRY_MAX_MS, GAVE_WAY_RETRY_MS * 2 ** (count - 2));
            gaveWays.set(account.id, { place, count, retryAt: now() + wait });
          }
          continue;
        }
        gaveWays.delete(account.id);
        // Our own recorded failure is not a new external failure that warrants another setup at once;
        // a failure waits its turn (FAILED_RETRY_MS, WAITS_FOR_SIGN_IN), a connected account waits for
        // new sign-in cookies or a newer failure recorded elsewhere.
        const recorded = deps.accounts().find(entry => entry.id === account.id);
        let retryAt = Infinity;
        if (failed) {
          const before = failures.get(account.id);
          const count = before?.place === place ? before.count + 1 : 1;
          const code = typeof failed?.code === "string" ? failed.code : null;
          retryAt = WAITS_FOR_SIGN_IN.has(code) ? Infinity : now() + (NEEDS_THE_PERSON.has(code) ? FAILED_RETRY_MAX_MS
            : Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_MS * 2 ** (count - 1)));
          // The sign-in as the setup left it: its own chatgpt.com pages may have refreshed the cookie,
          // which is no new sign-in.
          const after = await deps.readCookies(account.partition).catch(() => null);
          failures.set(account.id, { place, count, code, retryAt, okAt: recorded?.connector?.okAt ?? null,
            session: after && signedInFromCookies(after) ? sessionFingerprint(after) : sessionKey });
        } else {
          failures.delete(account.id);
        }
        attempts.set(account.id, { key, errorAt: recorded?.connector?.errorAt ?? null, retryAt });
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
    /**
     * The MCP tunnel is ready again: each connected or untried account checks its connector, even with
     * unchanged login cookies. An account waiting after a failure or a give-way keeps waiting: this
     * fires on every runtime restart (an account switch's setup adopts the same tunnel), and a restart
     * that changed nothing it failed on started every failing account's setup again (2026-11-19). A
     * started tunnel (`tunnelStarted`) ends the waits of failures it can fix, not those of the person's
     * own (WAITS_FOR_SIGN_IN, NEEDS_THE_PERSON); a different tunnel is a new target, which starts over.
     */
    invalidate({ tunnelStarted = false } = {}) {
      generation++;
      attempts.clear();
      if (!tunnelStarted) return;
      for (const failure of failures.values()) {
        if (!WAITS_FOR_SIGN_IN.has(failure.code) && !NEEDS_THE_PERSON.has(failure.code)) failure.retryAt = 0;
      }
    },
    /**
     * Why the account's automatic setup waits for its sign-in (verification_required,
     * platform_sign_in_required), or null: it failed there and its ChatGPT sign-in is unchanged since.
     */
    async signInWait(accountId) {
      const failure = failures.get(accountId);
      if (!WAITS_FOR_SIGN_IN.has(failure?.code)) return null;
      const account = deps.accounts().find(entry => entry.id === accountId);
      if (!account) return null;
      const cookies = await deps.readCookies(account.partition);
      return signedInFromCookies(cookies) && sessionFingerprint(cookies) === failure.session
        && failures.get(accountId) === failure ? failure.code : null;
    },
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
 * (a chat took the browser, a turn started). A manual setup, with no admission check, always failed.
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
