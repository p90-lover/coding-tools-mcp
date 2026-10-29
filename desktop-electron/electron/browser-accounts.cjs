"use strict";

// The Browser tab's ChatGPT accounts. The Browser tab is also the Codex bridge's browser, so the
// active account is the one Codex's WebGPT turns run on. Each account lives in its own partition
// (profile.cjs): the first keeps the partition every install signed in with before accounts, so
// that sign-in carries over; each added one gets a new partition, and removing it erases it.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { BROWSER_ACCOUNT_ID, browserAccountPartition } = require("./profile.cjs");

const MAX_ACCOUNTS = 12;
const MAX_LABEL = 60;
const FIRST_ACCOUNT_ID = "main";
// ChatGPT's sign-in: NextAuth's session token, split into .0/.1, kept 90 days from the last visit.
const CHATGPT_SESSION_COOKIE = "__Secure-next-auth.session-token";

/** Whether an account's chatgpt.com cookies (Electron's cookies.get) hold an unexpired sign-in. */
function signedInFromCookies(cookies, nowSeconds = Date.now() / 1000) {
  return (Array.isArray(cookies) ? cookies : []).some((cookie) => typeof cookie?.name === "string"
    && (cookie.name === CHATGPT_SESSION_COOKIE || cookie.name.startsWith(`${CHATGPT_SESSION_COOKIE}.`))
    && (cookie.session === true || !cookie.expirationDate || cookie.expirationDate > nowSeconds));
}

function createBrowserAccounts({ dataRoot, profile, logger }) {
  const statePath = path.join(dataRoot, "accounts.json");
  const firstAccount = () => ({ id: FIRST_ACCOUNT_ID, label: "ChatGPT account 1", email: null, proxyProfileId: null });
  let state = { activeId: FIRST_ACCOUNT_ID, accounts: [firstAccount()] };
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const accounts = (Array.isArray(saved?.accounts) ? saved.accounts : [])
      .filter((entry) => entry?.id === FIRST_ACCOUNT_ID || BROWSER_ACCOUNT_ID.test(entry?.id))
      .filter((entry, index, list) => list.findIndex((other) => other.id === entry.id) === index)
      .slice(0, MAX_ACCOUNTS)
      .map((entry) => ({
        id: entry.id,
        label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, MAX_LABEL) : "ChatGPT account",
        email: typeof entry.email === "string" ? entry.email.slice(0, 200) : null,
        proxyProfileId: typeof entry.proxyProfileId === "string" && entry.proxyProfileId ? entry.proxyProfileId.slice(0, 160) : null,
      }));
    if (accounts.length) {
      state = { accounts, activeId: accounts.some((entry) => entry.id === saved.activeId) ? saved.activeId : accounts[0].id };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") logger?.warn?.("browser_accounts.unreadable", { message: error instanceof Error ? error.message : String(error) });
  }

  function save() {
    fs.mkdirSync(dataRoot, { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temporary, statePath);
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

  return {
    status() {
      return {
        activeId: state.activeId,
        accounts: state.accounts.map(({ id, label, email, proxyProfileId }) => ({ id, label, email, proxyProfileId })),
        maxAccounts: MAX_ACCOUNTS,
      };
    },
    activeId: () => state.activeId,
    activePartition: () => partitionOf(state.activeId),
    partitionOf,
    /** Adds an account (not yet active); returns its id. */
    add() {
      if (state.accounts.length >= MAX_ACCOUNTS) throw new Error(`The Browser tab holds up to ${MAX_ACCOUNTS} accounts`);
      let id;
      do id = randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
      while (!BROWSER_ACCOUNT_ID.test(id) || state.accounts.some((entry) => entry.id === id));
      state.accounts.push({ id, label: `ChatGPT account ${state.accounts.length + 1}`, email: null, proxyProfileId: null });
      save();
      return id;
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
      return state.accounts.find((entry) => partitionOf(entry.id) === partition)?.proxyProfileId ?? null;
    },
    /** Forgets an account other than the active one; returns its partition for the caller to erase. */
    remove(id) {
      account(id);
      if (id === state.activeId) throw new Error("Switch to another account before removing this one");
      const partition = partitionOf(id);
      state.accounts = state.accounts.filter((entry) => entry.id !== id);
      save();
      return partition;
    },
  };
}

module.exports = { createBrowserAccounts, signedInFromCookies, FIRST_ACCOUNT_ID, MAX_ACCOUNTS };
