"use strict";

// The Browser tab's account flows: add, switch, remove, and which accounts are signed in. They lived
// in main.cjs, untested, and kept breaking in the order of their steps (a removal published only
// after its session was erased, so the toolbar offered an account that was gone). Everything Electron
// or the rest of main owns comes in as a dependency, so each flow runs in a test.
//
// The rule every flow keeps: change the registry, publish, then do slow work (erasing a session,
// reading sign-ins) in the background. A flow that fails partway publishes what it changed.

/**
 * @param {object} deps
 * @param {ReturnType<import("./browser-accounts.cjs").createBrowserAccounts>} deps.registry
 * @param {(status: object) => void} deps.publish sends the status to every window
 * @param {() => object | null} deps.host the browser host in use
 * @param {(host: object) => void} deps.setHost
 * @param {() => ((accountId: string) => object) | null} deps.hostFactory null while the browser starts
 * @param {(partition: string, logger: object) => Promise<unknown>} deps.routePartition
 * @param {(partition: string) => Promise<boolean>} deps.readSignIn
 * @param {(partition: string) => Promise<void>} deps.erasePartition
 * @param {(accountId: string) => void} deps.forgetAccountData its saved-chat file, lifecycle sync, tunnel binding
 * @param {() => object | null} deps.threads codex-thread-accounts, or null
 * @param {(next: object, previous: object | null) => void} [deps.placeHost] bounds and surface of a new host
 * @param {(next: object, revealed: { wasVisible: boolean, stateStore: object }) => Promise<void>} [deps.afterSwitch]
 * @param {(accountId: string, logger: object) => object} [deps.lifecycleSyncFor] the account's saved-chat sync, for a host that switches in place
 * @param {() => number} [deps.now]
 */
function createBrowserAccountService(deps) {
  const now = deps.now ?? Date.now;
  const signIns = new Map(); // account id -> true | false, from its partition's cookies
  let switching = null; // the switch in progress
  let signInRefresh = null;
  let signInAgain = false; // a change arrived during a read: read once more after it
  let bridgeRefreshFor = null; // the account a switch left the bridge to pick up on its sign-in

  function status() {
    const current = deps.registry.status();
    return {
      ...current,
      accounts: current.accounts.map((entry) => ({ ...entry, signedIn: signIns.get(entry.id) ?? null })),
      switching: switching !== null,
    };
  }

  function publish() {
    deps.publish(status());
  }

  // Every account's sign-in, read from its own partition (never contacting ChatGPT or its proxy).
  // Calls while a read runs coalesce into one more read after it.
  function refreshSignIns(logger) {
    if (signInRefresh) {
      signInAgain = true;
      return signInRefresh;
    }
    signInRefresh = (async () => {
      do {
        signInAgain = false;
        let changed = false;
        const ids = deps.registry.status().accounts.map((entry) => entry.id);
        for (const id of ids) {
          let signedIn;
          try {
            if (!deps.registry.has(id)) continue; // removed while this read ran
            signedIn = await deps.readSignIn(deps.registry.partitionOf(id));
          } catch (error) {
            logger?.warn?.("browser_accounts.sign_in_unreadable", { message: error instanceof Error ? error.message : String(error) });
            continue;
          }
          if (signIns.get(id) !== signedIn) { signIns.set(id, signedIn); changed = true; }
        }
        const kept = new Set(deps.registry.status().accounts.map((entry) => entry.id));
        for (const id of [...signIns.keys()]) {
          if (!kept.has(id)) { signIns.delete(id); changed = true; }
        }
        if (changed) publish();
      } while (signInAgain);
    })().finally(() => { signInRefresh = null; });
    return signInRefresh;
  }

  // A host that switches in place (BrowserHost.switchAccount) is held only by what owns the page it
  // shows; Codex turns keep running in their own tabs. One rebuilt per account is held by any turn.
  function blockerMessage(verb) {
    const host = deps.host();
    const blocker = host?.switchAccount ? host.homeSwitchBlocker?.() : host?.accountSwitchBlocker?.();
    return blocker ? `The Browser tab cannot ${verb} while ${blocker}. Try again when it is done.` : null;
  }

  // Shows the account in the host in use: the account left stays loaded for an instant switch back.
  async function switchInPlace(host, accountId, partition, { logger, stateStore }) {
    await deps.routePartition(partition, logger);
    const previousRefresh = bridgeRefreshFor;
    // Set first: the switch publishes the account's sign-in, which starts the bridge refresh.
    bridgeRefreshFor = accountId;
    try {
      await host.switchAccount(partition, { chatLifecycleSync: deps.lifecycleSyncFor?.(accountId, logger) ?? null });
    } catch (error) {
      bridgeRefreshFor = previousRefresh;
      throw error;
    }
    deps.registry.setActive(accountId);
    logger?.info?.("browser_accounts.switched", { accountId, inPlace: true });
    await deps.afterSwitch?.(host, { wasVisible: host.visible === true, stateStore });
  }

  async function switchTo(accountId, { logger, stateStore }) {
    const partition = deps.registry.partitionOf(accountId);
    if (accountId === deps.registry.activeId()) return status();
    if (switching) throw new Error("Another account switch is in progress");
    const current = deps.host();
    const createHost = deps.hostFactory();
    if (!createHost && !current?.switchAccount) throw new Error("The browser is still starting");
    const early = blockerMessage("change account");
    if (early) throw new Error(early);
    const run = current?.switchAccount ? switchInPlace(current, accountId, partition, { logger, stateStore }) : (async () => {
      const previous = deps.host();
      await previous?.persistSession?.().catch((error) => logger?.warn?.("browser_accounts.persist_failed", {
        message: error instanceof Error ? error.message : String(error),
      }));
      // The account's bound proxy (else Global Routing's) before its first page.
      await deps.routePartition(partition, logger);
      // A turn may have begun while the session was flushed; from here to the new host is synchronous.
      const late = blockerMessage("change account");
      if (late) throw new Error(late);
      const wasVisible = previous?.visible === true;
      const previousId = deps.registry.activeId();
      previous?.destroy?.();
      let next = null;
      try {
        next = createHost(accountId);
        deps.registry.setActive(accountId);
      } catch (error) {
        // Never leave the app without its browser: the account it was on comes back. A host built
        // before setActive failed is closed, not left running beside it.
        try { next?.destroy?.(); } catch {}
        deps.setHost(createHost(previousId));
        throw error;
      }
      deps.setHost(next);
      bridgeRefreshFor = accountId;
      deps.placeHost?.(next, previous);
      logger?.info?.("browser_accounts.switched", { accountId });
      await next.ready?.();
      await deps.afterSwitch?.(next, { wasVisible, stateStore });
    })();
    switching = run;
    publish();
    try {
      await run;
    } finally {
      switching = null;
      publish();
      // The account left keeps its sign-in in its partition; the list shows it for every account.
      void refreshSignIns(logger);
    }
    return status();
  }

  async function add(context) {
    const id = deps.registry.add();
    publish();
    try {
      return await switchTo(id, context);
    } catch (error) {
      // Not switched to (a turn is running): the new account stays listed, ready to pick later.
      publish();
      throw error;
    }
  }

  // Signs the account out for good. Removing the account in use first switches to another one.
  async function remove(accountId, context) {
    deps.registry.partitionOf(accountId);
    const { accounts } = deps.registry.status();
    if (accounts.length <= 1) throw new Error("The Browser tab needs at least one account");
    if (accountId === deps.registry.activeId()) {
      await switchTo(accounts.find((entry) => entry.id !== accountId).id, context);
    }
    const host = deps.host();
    if (host?.livePartitions?.().includes(deps.registry.partitionOf(accountId)) && host.accountSwitchBlocker?.()) {
      throw new Error(`That account cannot be removed while ${host.accountSwitchBlocker()}. Try again when it is done.`);
    }
    // Its threads' retained tabs close first; the threads start fresh on the account in use.
    const threads = deps.threads();
    for (const entry of threads?.list() ?? []) {
      if (entry.accountId === accountId) host?.releaseThreadTabs?.(entry.threadId);
    }
    threads?.removeAccount(accountId);
    // Its page, if still loaded from an earlier switch, closes before its partition is erased.
    host?.releaseAccountHome?.(deps.registry.partitionOf(accountId));
    const partition = deps.registry.remove(accountId);
    signIns.delete(accountId);
    if (bridgeRefreshFor === accountId) bridgeRefreshFor = null;
    deps.forgetAccountData(accountId);
    // Every list shows it gone at once; its session (cookies, storage, a cache that took minutes to
    // erase on a busy HDD) is erased after.
    publish();
    const started = now();
    void deps.erasePartition(partition).then(
      () => context?.logger?.info?.("browser_accounts.removed", { accountId, eraseMs: now() - started }),
      (error) => context?.logger?.warn?.("browser_accounts.erase_failed", {
        accountId, eraseMs: now() - started, message: error instanceof Error ? error.message : String(error),
      }),
    );
    void refreshSignIns(context?.logger);
    return status();
  }

  /**
   * Removes several accounts at once (the management page's bulk delete): the ones not in use first,
   * so a switch happens at most once, and only if the account in use is among them. One that cannot
   * go (a turn running on it, or the last account) stays, and its reason is returned beside the rest.
   */
  async function removeMany(accountIds, context) {
    const wanted = [...new Set(Array.isArray(accountIds) ? accountIds.filter((id) => typeof id === "string") : [])];
    if (!wanted.length) throw new Error("Choose the accounts to remove");
    const listed = new Set(deps.registry.status().accounts.map((entry) => entry.id));
    if (wanted.every((id) => listed.has(id)) && wanted.length >= listed.size) throw new Error("Keep at least one account: the Browser tab needs one");
    const active = deps.registry.activeId();
    const order = [...wanted.filter((id) => id !== active), ...wanted.filter((id) => id === active)];
    const removed = [];
    const failed = [];
    for (const id of order) {
      try {
        await remove(id, context);
        removed.push(id);
      } catch (error) {
        failed.push({ id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    context?.logger?.info?.("browser_accounts.removed_many", { removed: removed.length, failed: failed.length });
    return { ...status(), removed, failed };
  }

  return {
    status,
    publish,
    refreshSignIns,
    switchTo,
    add,
    remove,
    removeMany,
    switching: () => switching !== null,
    /** Whether a switch left this account's plan for the bridge to pick up (takeBridgeRefresh clears it). */
    bridgeRefreshPending: (accountId) => bridgeRefreshFor === accountId,
    /** Whether a switch left this account's plan for the bridge to pick up; true once, then cleared. */
    takeBridgeRefresh(accountId) {
      if (bridgeRefreshFor !== accountId) return false;
      bridgeRefreshFor = null;
      return true;
    },
  };
}

module.exports = { createBrowserAccountService };
