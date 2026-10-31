const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { createBrowserAccounts: openBrowserAccounts, FIRST_ACCOUNT_ID } = require("../electron/browser-accounts.cjs");
const { createBrowserAccountService } = require("../electron/browser-account-service.cjs");

// Accounts save off the main thread: a test folder goes once every store opened in it is written.
const opened = new Set();
function createBrowserAccounts(options) {
  const accounts = openBrowserAccounts(options);
  opened.add(accounts);
  return accounts;
}
const accountsSaved = () => Promise.all([...opened].map((accounts) => accounts.saved()));

// Test files stay in the repo's aiTemp, never the system temp folder on C: (AGENTS.md).
function tempRoot(t) {
  const root = path.join(__dirname, "..", "..", "aiTemp", "browser-account-service-tests", crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  t.after(async () => {
    await accountsSaved();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, "browser-accounts");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeHost(accountId, partition) {
  return {
    accountId,
    destroyed: false,
    blocker: null,
    released: [],
    visible: false,
    destroy() { this.destroyed = true; },
    async ready() {},
    async persistSession() {},
    accountSwitchBlocker() { return this.blocker; },
    livePartitions() { return [partition]; },
    releaseThreadTabs(threadId) { this.released.push(threadId); },
  };
}

function logger() {
  const lines = [];
  const log = level => (event, fields) => lines.push({ level, event, ...fields });
  return { lines, info: log("info"), warn: log("warn") };
}

/** A service over a real account registry, with every Electron piece faked and recorded. */
function setup(t, overrides = {}) {
  const registry = createBrowserAccounts({ dataRoot: tempRoot(t), profile: "production" });
  const published = [];
  const forgotten = [];
  const erased = [];
  const reads = [];
  const hosts = [];
  const signedIn = new Map();
  let host;
  const createHost = (accountId) => {
    if (overrides.failCreate?.(accountId)) throw new Error(`no host for ${accountId}`);
    const created = fakeHost(accountId, registry.partitionOf(accountId));
    hosts.push(created);
    return created;
  };
  host = createHost(registry.activeId());
  const threads = {
    removed: [],
    list: () => [],
    removeAccount(accountId) { this.removed.push(accountId); },
  };
  const service = createBrowserAccountService({
    registry: overrides.registry?.(registry) ?? registry,
    publish: status => published.push(status),
    host: () => host,
    setHost: next => { host = next; },
    hostFactory: () => (overrides.starting ? null : createHost),
    routePartition: async () => {},
    readSignIn: async (partition) => {
      reads.push(partition);
      await overrides.readGate?.();
      return signedIn.get(partition) ?? false;
    },
    erasePartition: partition => {
      erased.push(partition);
      return overrides.erase?.(partition) ?? Promise.resolve();
    },
    forgetAccountData: accountId => forgotten.push(accountId),
    threads: () => threads,
  });
  return { registry, service, published, forgotten, erased, reads, hosts, threads, signedIn, host: () => host };
}

const ids = status => status.accounts.map(entry => entry.id);

test("switching replaces the host, marks the account active and tells the lists while it runs", async (t) => {
  const { registry, service, published, hosts, host } = setup(t);
  const first = host();
  const id = registry.add();
  const status = await service.switchTo(id, { logger: logger() });
  assert.equal(status.activeId, id);
  assert.equal(first.destroyed, true);
  assert.equal(host(), hosts.at(-1));
  assert.equal(host().accountId, id);
  assert.deepEqual(published.map(entry => entry.switching), [true, false]);
  assert.equal(service.switching(), false);
  assert.equal(service.takeBridgeRefresh(FIRST_ACCOUNT_ID), false);
  assert.equal(service.takeBridgeRefresh(id), true);
  assert.equal(service.takeBridgeRefresh(id), false, "the bridge refresh is handed out once");
});

test("a host that switches in place keeps running: only what owns its page holds the switch", async (t) => {
  const { registry, service, hosts, host } = setup(t);
  const warm = host();
  const shown = [];
  warm.homeBlocker = null;
  warm.homeSwitchBlocker = function () { return this.homeBlocker; };
  warm.switchAccount = async (partition, { chatLifecycleSync }) => { shown.push([partition, chatLifecycleSync]); };
  warm.blocker = "a ChatGPT chat turn is running"; // a Codex turn elsewhere no longer holds the switch
  const id = registry.add();
  assert.equal((await service.switchTo(id, { logger: logger() })).activeId, id);
  assert.equal(host(), warm, "the same host shows the other account");
  assert.equal(warm.destroyed, false);
  assert.equal(hosts.length, 1, "no host is built");
  assert.deepEqual(shown, [[registry.partitionOf(id), null]]);
  assert.equal(service.bridgeRefreshPending(id), true, "the account's sign-in may refresh the bridge");

  warm.homeBlocker = "sign-in is in progress";
  await assert.rejects(service.switchTo(FIRST_ACCOUNT_ID, {}), /cannot change account while sign-in is in progress/);
  warm.homeBlocker = null;
  warm.switchAccount = async () => { throw new Error("page failed"); };
  await assert.rejects(service.switchTo(FIRST_ACCOUNT_ID, {}), /page failed/);
  assert.equal(registry.activeId(), id, "a failed switch leaves the account it was on");
  assert.equal(service.bridgeRefreshPending(id), true, "and the refresh it was waiting for");
});

test("a switch is refused while another runs, while the browser starts, or while a turn runs", async (t) => {
  const { registry, service, host } = setup(t);
  const id = registry.add();
  assert.equal((await service.switchTo(FIRST_ACCOUNT_ID, {})).activeId, FIRST_ACCOUNT_ID, "the account in use is a no-op");
  const third = registry.add();
  const running = service.switchTo(id, {});
  await assert.rejects(service.switchTo(third, {}), /Another account switch is in progress/);
  await running;
  host().blocker = "a Codex turn is running";
  await assert.rejects(service.switchTo(FIRST_ACCOUNT_ID, {}), /cannot change account while a Codex turn is running/);
  assert.equal(host().destroyed, false, "a refused switch leaves the browser as it was");
  assert.equal(registry.activeId(), id);

  const starting = setup(t, { starting: true });
  await assert.rejects(starting.service.switchTo(starting.registry.add(), {}), /The browser is still starting/);
});

test("a switch that cannot build its browser brings the previous account back", async (t) => {
  const { registry, service, hosts, host, published } = setup(t, { failCreate: accountId => accountId !== FIRST_ACCOUNT_ID });
  await assert.rejects(service.switchTo(registry.add(), {}), /no host for/);
  const [original, restored] = hosts;
  assert.equal(original.destroyed, true);
  assert.equal(host(), restored);
  assert.equal(restored.accountId, FIRST_ACCOUNT_ID);
  assert.equal(registry.activeId(), FIRST_ACCOUNT_ID);
  assert.equal(service.switching(), false);
  assert.equal(published.at(-1).switching, false, "the lists hear the switch ended");
});

test("a host built before the active account failed to save is closed, not left running", async (t) => {
  const { registry, service, hosts, host } = setup(t, {
    registry: real => ({ ...real, setActive: () => { throw new Error("disk full"); } }),
  });
  await assert.rejects(service.switchTo(registry.add(), {}), /disk full/);
  const [original, built, restored] = hosts;
  assert.equal(original.destroyed, true);
  assert.equal(built.destroyed, true);
  assert.equal(host(), restored);
  assert.equal(restored.accountId, FIRST_ACCOUNT_ID);
  assert.equal(registry.activeId(), FIRST_ACCOUNT_ID);
});

test("an added account is listed before the switch, and stays listed when the switch is refused", async (t) => {
  const { service, published, host } = setup(t);
  host().blocker = "a Codex turn is running";
  await assert.rejects(service.add({}), /cannot change account/);
  assert.equal(ids(published[0]).length, 2, "the first publish already lists the new account");
  assert.equal(ids(published.at(-1)).length, 2);
  assert.equal(published.at(-1).activeId, FIRST_ACCOUNT_ID);
});

test("removing an account updates every list at once; its session is erased after", async (t) => {
  const erase = deferred();
  const log = logger();
  const { registry, service, published, forgotten, erased, threads, host } = setup(t, { erase: () => erase.promise });
  const id = registry.add();
  const partition = registry.partitionOf(id);
  threads.list = () => [{ threadId: "t-1", accountId: id }, { threadId: "t-2", accountId: FIRST_ACCOUNT_ID }];
  const status = await service.remove(id, { logger: log });
  assert.deepEqual(ids(status), [FIRST_ACCOUNT_ID]);
  assert.deepEqual(ids(published.at(-1)), [FIRST_ACCOUNT_ID], "published before the erase finished");
  assert.deepEqual(erased, [partition]);
  assert.deepEqual(forgotten, [id]);
  assert.deepEqual(host().released, ["t-1"]);
  assert.deepEqual(threads.removed, [id]);
  assert.equal(log.lines.some(line => line.event === "browser_accounts.removed"), false);
  erase.resolve();
  await erase.promise;
  await new Promise(setImmediate);
  assert.equal(log.lines.find(line => line.event === "browser_accounts.removed")?.accountId, id);
});

test("a session that fails to erase is logged; the account is still gone", async (t) => {
  const log = logger();
  const { registry, service } = setup(t, { erase: () => Promise.reject(new Error("EBUSY")) });
  const id = registry.add();
  await service.remove(id, { logger: log });
  await new Promise(setImmediate);
  assert.equal(registry.has(id), false);
  assert.equal(log.lines.find(line => line.event === "browser_accounts.erase_failed")?.message, "EBUSY");
});

test("removing the account in use switches away first; the last account cannot be removed", async (t) => {
  const { registry, service, host } = setup(t);
  await assert.rejects(service.remove(FIRST_ACCOUNT_ID, {}), /needs at least one account/);
  const id = registry.add();
  await service.switchTo(id, {});
  const status = await service.remove(id, {});
  assert.equal(status.activeId, FIRST_ACCOUNT_ID);
  assert.equal(host().accountId, FIRST_ACCOUNT_ID);
  assert.equal(service.takeBridgeRefresh(id), false, "a removed account leaves no bridge refresh");
});

test("bulk delete removes every ticked account, the one in use last, and keeps the rest", async (t) => {
  // The user (2026-10-31): "remove all account expect for matrena … and add a bulk delete account".
  const log = logger();
  const { registry, service, erased, host } = setup(t);
  const kept = registry.add();
  const others = [registry.add(), registry.add(), registry.add()];
  await service.switchTo(others[1], {});
  const status = await service.removeMany([FIRST_ACCOUNT_ID, ...others, others[0]], { logger: log });
  assert.deepEqual(ids(status), [kept], "only the unticked account is left");
  assert.equal(status.activeId, kept, "the account in use was removed last, after switching away once");
  assert.equal(host().accountId, kept);
  assert.deepEqual(status.removed, [FIRST_ACCOUNT_ID, others[0], others[2], others[1]], "duplicates once, the one in use last");
  assert.deepEqual(status.failed, []);
  assert.equal(erased.length, 4);
  assert.deepEqual(log.lines.find(line => line.event === "browser_accounts.removed_many"), { level: "info", event: "browser_accounts.removed_many", removed: 4, failed: 0 });
});

test("bulk delete keeps an account it cannot remove, says why, and never removes them all", async (t) => {
  const { registry, service, host } = setup(t);
  const busy = registry.add();
  const free = registry.add();
  await assert.rejects(service.removeMany([FIRST_ACCOUNT_ID, busy, free], {}), /Keep at least one account/);
  await assert.rejects(service.removeMany([], {}), /Choose the accounts to remove/);
  assert.equal(registry.status().accounts.length, 3, "nothing was removed");
  host().livePartitions = () => [registry.partitionOf(busy)];
  host().blocker = "a Codex turn is running";
  const status = await service.removeMany([busy, free], {});
  assert.deepEqual(status.removed, [free]);
  assert.deepEqual(status.failed.map(entry => entry.id), [busy]);
  assert.match(status.failed[0].message, /cannot be removed while a Codex turn is running/);
  assert.deepEqual(ids(status), [FIRST_ACCOUNT_ID, busy]);
});

test("an account in a running turn cannot be removed", async (t) => {
  const { registry, service, host, erased } = setup(t);
  const id = registry.add();
  const live = registry.partitionOf(id);
  host().livePartitions = () => [live];
  host().blocker = "a Codex turn is running";
  await assert.rejects(service.remove(id, {}), /cannot be removed while a Codex turn is running/);
  assert.equal(registry.has(id), true);
  assert.deepEqual(erased, []);
});

test("sign-in reads that arrive during a read coalesce into one more read", async (t) => {
  let gate = deferred();
  const { service, registry, reads, signedIn, published } = setup(t, { readGate: () => gate.promise });
  signedIn.set(registry.partitionOf(FIRST_ACCOUNT_ID), true);
  const first = service.refreshSignIns();
  const second = service.refreshSignIns();
  const third = service.refreshSignIns();
  assert.equal(second, first);
  assert.equal(third, first);
  const opened = gate;
  gate = { promise: Promise.resolve() };
  opened.resolve();
  await first;
  assert.equal(reads.length, 2, "one read, then one more for the calls that arrived during it");
  assert.equal(published.length, 1, "only the read that changed something publishes");
  assert.equal(service.status().accounts[0].signedIn, true);
});

test("a bridge refresh steps aside once another account is shown, and never reports that as a failure", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const body = main.slice(main.indexOf("async function onBrowserAccountSignedIn"), main.indexOf("function switchBrowserAccount"));
  const skippedBeforeSetup = body.indexOf("if (shownElsewhere())");
  assert.ok(skippedBeforeSetup > 0 && skippedBeforeSetup < body.indexOf("await runtimeHost.setupCore()"), "checked before setup checks the shown page");
  const failure = body.slice(body.indexOf("} catch (error) {"));
  assert.ok(failure.indexOf("if (shownElsewhere())") < failure.indexOf("publishOperation("), "a switch during setup is no failure");
  assert.match(body, /browserAccounts\.activeId\(\) !== accountId/);
});
