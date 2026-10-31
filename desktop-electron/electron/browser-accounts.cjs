"use strict";

// The Browser tab's ChatGPT accounts. The Browser tab is also the Codex bridge's browser, so the
// active account is the one Codex's WebGPT turns run on. Each account lives in its own partition
// (profile.cjs): the first keeps the partition every install signed in with before accounts, so
// that sign-in carries over; each added one gets a new partition, and removing it erases it.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");
const { BROWSER_ACCOUNT_ID, browserAccountPartition } = require("./profile.cjs");

const MAX_ACCOUNTS = 12;
const MAX_LABEL = 60;
const FIRST_ACCOUNT_ID = "main";
// Browser tabs one account may hold at once (its Codex turns, and the Browser tab's own pages).
const MAX_TABS_PER_ACCOUNT = 5;
const DEFAULT_SETTINGS = Object.freeze({ newSessions: "active", keepFinishedTabsMinutes: 10 });
const KEEP_FINISHED_TABS_MINUTES = [5, 10, 20, 30, 60];
const MAX_ERROR = 300;
const MAX_IMPORTED_EMAILS = 500;
// ChatGPT's sign-in: NextAuth's session token, split into .0/.1, kept 90 days from the last visit.
const CHATGPT_SESSION_COOKIE = "__Secure-next-auth.session-token";

/** Whether an account's chatgpt.com cookies (Electron's cookies.get) hold an unexpired sign-in. */
function signedInFromCookies(cookies, nowSeconds = Date.now() / 1000) {
  return (Array.isArray(cookies) ? cookies : []).some((cookie) => typeof cookie?.name === "string"
    && (cookie.name === CHATGPT_SESSION_COOKIE || cookie.name.startsWith(`${CHATGPT_SESSION_COOKIE}.`))
    && (cookie.session === true || !cookie.expirationDate || cookie.expirationDate > nowSeconds));
}

const clampTabs = (value) => (Number.isInteger(value) && value >= 1 && value <= MAX_TABS_PER_ACCOUNT ? value : MAX_TABS_PER_ACCOUNT);
const timestamp = (value) => (Number.isFinite(value) && value > 0 ? value : null);

// What the account's last ChatGPT inspection found: Plus has 6 High at most, Team and Pro add
// Extra High and Pro (solAvailable/proAvailable, as the bridge's capability check reports them).
function normalizePlan(value) {
  if (!value || typeof value.solAvailable !== "boolean" || typeof value.proAvailable !== "boolean") return null;
  return { solAvailable: value.solAvailable, proAvailable: value.proAvailable, checkedAt: timestamp(value.checkedAt) };
}

// What the account's Codex turns showed about its ChatGPT connector: the last turn that bound it,
// and the last connector failure.
function normalizeConnector(value) {
  if (!value || typeof value !== "object") return null;
  const okAt = timestamp(value.okAt);
  const errorAt = timestamp(value.errorAt);
  const error = typeof value.error === "string" && value.error ? value.error.slice(0, MAX_ERROR) : null;
  return okAt || (error && errorAt) ? { okAt, error: error && errorAt ? error : null, errorAt: error ? errorAt : null } : null;
}

function normalizeEntry(entry, index) {
  return {
    id: entry.id,
    label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, MAX_LABEL) : `ChatGPT account ${index + 1}`,
    email: typeof entry.email === "string" && entry.email ? entry.email.slice(0, 200) : null,
    proxyProfileId: typeof entry.proxyProfileId === "string" && entry.proxyProfileId ? entry.proxyProfileId.slice(0, 160) : null,
    maxTabs: clampTabs(entry.maxTabs),
    acceptsNewSessions: entry.acceptsNewSessions !== false,
    plan: normalizePlan(entry.plan),
    connector: normalizeConnector(entry.connector),
  };
}

function createBrowserAccounts({ dataRoot, profile, logger, now = Date.now }) {
  const statePath = path.join(dataRoot, "accounts.json");
  const firstAccount = () => normalizeEntry({ id: FIRST_ACCOUNT_ID }, 0);
  // importedEmails: the CPA Codex sign-ins accounts were made from (importOauthAccounts), lowercase.
  let state = { activeId: FIRST_ACCOUNT_ID, accounts: [firstAccount()], settings: { ...DEFAULT_SETTINGS }, importedEmails: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (Array.isArray(saved?.importedEmails)) {
      state.importedEmails = saved.importedEmails.filter((email) => typeof email === "string" && email.includes("@")).slice(0, MAX_IMPORTED_EMAILS);
    }
    const accounts = (Array.isArray(saved?.accounts) ? saved.accounts : [])
      .filter((entry) => entry?.id === FIRST_ACCOUNT_ID || BROWSER_ACCOUNT_ID.test(entry?.id))
      .filter((entry, index, list) => list.findIndex((other) => other.id === entry.id) === index)
      .slice(0, MAX_ACCOUNTS)
      .map(normalizeEntry);
    if (accounts.length) {
      state = {
        accounts,
        activeId: accounts.some((entry) => entry.id === saved.activeId) ? saved.activeId : accounts[0].id,
        settings: { ...DEFAULT_SETTINGS },
        importedEmails: state.importedEmails,
      };
      const newSessions = saved?.settings?.newSessions;
      if (newSessions === "balance" || accounts.some((entry) => entry.id === newSessions)) state.settings.newSessions = newSessions;
      if (KEEP_FINISHED_TABS_MINUTES.includes(saved?.settings?.keepFinishedTabsMinutes)) {
        state.settings.keepFinishedTabsMinutes = saved.settings.keepFinishedTabsMinutes;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") logger?.warn?.("browser_accounts.unreadable", { message: error instanceof Error ? error.message : String(error) });
  }

  // Written off the main thread: the synchronous write and rename held every window up to 76 s on
  // the busy hard disk while accounts were removed and switched (2026-11-01), and one that never
  // came back left the app "not responding" until Windows closed it. The accounts in memory are
  // the truth; a burst of changes is one save plus at most one more with the latest state, flushed
  // to disk before it replaces the old file so a power cut leaves the old list or the new one.
  let saving = null;
  let saveAgain = false;
  function save() {
    if (saving) { saveAgain = true; return; }
    saving = writePrivateFileAtomicAsync(statePath, `${JSON.stringify(state, null, 2)}\n`, { durable: true, protectDirectory: false })
      .catch((error) => logger?.warn?.("browser_accounts.save_failed", { message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        saving = null;
        if (saveAgain) { saveAgain = false; save(); }
      });
  }

  function account(id) {
    const found = state.accounts.find((entry) => entry.id === id);
    if (!found) throw new Error("Unknown browser account");
    return found;
  }

  const partitionOf = (id) => {
    const entry = account(id);
    return browserAccountPartition(profile, entry.id === FIRST_ACCOUNT_ID ? null : entry.id);
  };
  const accountOfPartition = (partition) => state.accounts.find((entry) => partitionOf(entry.id) === partition) ?? null;

  function addEntry(label) {
    if (state.accounts.length >= MAX_ACCOUNTS) throw new Error(`The Browser tab holds up to ${MAX_ACCOUNTS} accounts`);
    let id;
    do id = randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
    while (!BROWSER_ACCOUNT_ID.test(id) || state.accounts.some((entry) => entry.id === id));
    state.accounts.push(normalizeEntry({ id, label }, state.accounts.length));
    return id;
  }

  return {
    /** Resolves once every change so far is on disk (the app's quit, and tests reopening the file). */
    async saved() { while (saving) await saving; },
    status() {
      return {
        activeId: state.activeId,
        accounts: state.accounts.map((entry) => ({
          ...entry,
          plan: entry.plan && { ...entry.plan },
          connector: entry.connector && { ...entry.connector },
        })),
        maxAccounts: MAX_ACCOUNTS,
        maxTabsPerAccount: MAX_TABS_PER_ACCOUNT,
        settings: { ...state.settings },
      };
    },
    activeId: () => state.activeId,
    activePartition: () => partitionOf(state.activeId),
    partitionOf,
    has: (id) => state.accounts.some((entry) => entry.id === id),
    /** The account that owns a partition (its id), or null. */
    accountIdOfPartition: (partition) => accountOfPartition(partition)?.id ?? null,
    /** Adds an account (not yet active); returns its id. */
    add() {
      const id = addEntry();
      save();
      return id;
    },
    /**
     * Adds an account, named after it, for each CPA Codex OAuth sign-in (`entries`: { email, plan })
     * not seen before, while there is room. An email seen once is never added again, so removing
     * its account sticks; an account already signed in to that email counts as seen. Returns the
     * ids added. The sign-in itself stays the user's: an OAuth token cannot make a ChatGPT web
     * session, so the account waits signed out under that name.
     */
    importOauthAccounts(entries) {
      const seen = new Set(state.importedEmails);
      const added = [];
      let changed = false;
      const remember = (email) => {
        if (seen.has(email)) return;
        seen.add(email);
        state.importedEmails = [...state.importedEmails, email].slice(-MAX_IMPORTED_EMAILS);
        changed = true;
      };
      for (const entry of state.accounts) if (entry.email) remember(entry.email.toLowerCase());
      for (const { email, plan } of Array.isArray(entries) ? entries : []) {
        const key = typeof email === "string" ? email.trim().toLowerCase() : "";
        if (!key.includes("@") || seen.has(key)) continue;
        // No room: not remembered, so it is added once an account is removed.
        if (state.accounts.length >= MAX_ACCOUNTS) break;
        added.push(addEntry(typeof plan === "string" && plan ? `${key} · ${plan}` : key));
        remember(key);
      }
      if (changed) save();
      return added;
    },
    setActive(id) {
      account(id);
      state.activeId = id;
      save();
    },
    rename(id, label) {
      const next = typeof label === "string" ? label.trim().slice(0, MAX_LABEL) : "";
      if (!next) throw new Error("Account name cannot be empty");
      account(id).label = next;
      save();
    },
    /** Records the signed-in email shown for an account; returns whether it changed. */
    setEmail(id, email) {
      const entry = state.accounts.find((item) => item.id === id);
      const next = typeof email === "string" && email ? email.slice(0, 200) : null;
      if (!entry || entry.email === next) return false;
      entry.email = next;
      save();
      return true;
    },
    /**
     * Binds one proxy profile to an account (null: follow Global Routing). One proxy per account and
     * one account per proxy, so two accounts never share an exit.
     */
    setProxy(id, profileId) {
      const entry = account(id);
      const next = typeof profileId === "string" && profileId ? profileId.slice(0, 160) : null;
      const holder = next && state.accounts.find((other) => other.id !== id && other.proxyProfileId === next);
      if (holder) throw new Error(`That proxy is already bound to ${holder.email ?? holder.label}`);
      entry.proxyProfileId = next;
      save();
    },
    /** The proxy profile bound to the account that owns this partition, or null. */
    proxyForPartition(partition) {
      return accountOfPartition(partition)?.proxyProfileId ?? null;
    },
    /** One account's own settings: how many tabs it may hold, and whether new sessions may start on it. */
    setAccountSettings(id, input = {}) {
      const entry = account(id);
      if (input.maxTabs !== undefined) {
        if (!Number.isInteger(input.maxTabs) || input.maxTabs < 1 || input.maxTabs > MAX_TABS_PER_ACCOUNT) {
          throw new Error(`An account holds 1 to ${MAX_TABS_PER_ACCOUNT} tabs`);
        }
        entry.maxTabs = input.maxTabs;
      }
      if (input.acceptsNewSessions !== undefined) entry.acceptsNewSessions = input.acceptsNewSessions === true;
      save();
    },
    /** The tabs the account owning this partition may hold (the most for an unknown partition). */
    tabLimitForPartition(partition) {
      return accountOfPartition(partition)?.maxTabs ?? MAX_TABS_PER_ACCOUNT;
    },
    /** Settings for every account: where new Codex sessions start and how long finished tabs stay. */
    setSettings(input = {}) {
      if (input.newSessions !== undefined) {
        if (input.newSessions !== "active" && input.newSessions !== "balance" && !state.accounts.some((entry) => entry.id === input.newSessions)) {
          throw new Error("New sessions start on the account in use, a chosen account, or the least busy one");
        }
        state.settings.newSessions = input.newSessions;
      }
      if (input.keepFinishedTabsMinutes !== undefined) {
        if (!KEEP_FINISHED_TABS_MINUTES.includes(input.keepFinishedTabsMinutes)) {
          throw new Error(`Finished tabs stay open for ${KEEP_FINISHED_TABS_MINUTES.join(", ")} minutes`);
        }
        state.settings.keepFinishedTabsMinutes = input.keepFinishedTabsMinutes;
      }
      save();
    },
    settings: () => ({ ...state.settings }),
    /** Records what an inspection of the account's ChatGPT session found; returns whether it changed. */
    recordPlan(id, inspected) {
      const entry = state.accounts.find((item) => item.id === id);
      const plan = normalizePlan({ ...inspected, checkedAt: now() });
      if (!entry || !plan) return false;
      entry.plan = plan;
      save();
      return true;
    },
    /** Records what a Codex turn showed about the account's connector: bound, or failed with `error`. */
    recordConnector(id, { bound = false, error = null } = {}) {
      const entry = state.accounts.find((item) => item.id === id);
      if (!entry || (!bound && !error)) return false;
      const previous = entry.connector ?? { okAt: null, error: null, errorAt: null };
      // A busy account binds its connector every turn: refresh a clean record at most every 5 minutes.
      if (bound && !previous.error && previous.okAt && now() - previous.okAt < 5 * 60 * 1000) return false;
      entry.connector = normalizeConnector(bound
        ? { ...previous, okAt: now(), error: null, errorAt: null }
        : { ...previous, error: String(error), errorAt: now() });
      save();
      return true;
    },
    /** Forgets an account other than the active one; returns its partition for the caller to erase. */
    remove(id) {
      account(id);
      if (id === state.activeId) throw new Error("Switch to another account before removing this one");
      const partition = partitionOf(id);
      state.accounts = state.accounts.filter((entry) => entry.id !== id);
      if (state.settings.newSessions === id) state.settings.newSessions = DEFAULT_SETTINGS.newSessions;
      save();
      return partition;
    },
  };
}

module.exports = {
  createBrowserAccounts, signedInFromCookies, FIRST_ACCOUNT_ID, MAX_ACCOUNTS, MAX_TABS_PER_ACCOUNT, KEEP_FINISHED_TABS_MINUTES,
};
