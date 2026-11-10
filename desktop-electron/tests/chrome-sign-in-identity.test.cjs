"use strict";
// A Chrome sign-in copies the profile's ChatGPT cookies. Chrome can hold two ChatGPT logins at once
// (ChatGPT's account switcher), and the copy opened as the other one: a card took another card's
// login and name. The import now checks which login it got before the account keeps it.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeSessionUser, sameSessionUser } = require("../electron/chatgpt-auth-session.cjs");
const { captureUser } = require("../electron/chrome-profile-login.cjs");
const { createBrowserAccounts } = require("../electron/browser-accounts.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

const ALICE = { id: "user-Alicexxxxxxxxxxxxxxxxxx", email: "alice@example.test" };
const BOB = { id: "user-Bobxxxxxxxxxxxxxxxxxxxx", email: "bob@example.test" };
const PARTITION = "persist:coding-tools-chatgpt-newcard00001";

test("a session user is its id and email; the same login matches by id, else by email", () => {
  assert.deepEqual(normalizeSessionUser({ id: ALICE.id, email: ALICE.email, name: "ignored" }), ALICE);
  assert.deepEqual(normalizeSessionUser({ email: "Only@Example.test" }), { id: null, email: "Only@Example.test" });
  assert.equal(normalizeSessionUser({ id: "not-a-user-id", email: "no at sign" }), null);
  assert.equal(normalizeSessionUser("user-abc"), null);
  assert.equal(sameSessionUser(ALICE, { ...ALICE }), true);
  assert.equal(sameSessionUser(ALICE, BOB), false);
  assert.equal(sameSessionUser({ id: null, email: "A@Example.test" }, { id: ALICE.id, email: "a@example.test" }), true, "email when one has no id");
  assert.equal(sameSessionUser({ id: ALICE.id, email: BOB.email }, { id: BOB.id, email: BOB.email }), false, "ids decide when both have one");
  assert.equal(sameSessionUser(null, ALICE), false);
});

test("a Chrome capture's user is optional (older connectors) but never malformed", () => {
  assert.equal(captureUser({ cookies: [] }), null);
  assert.equal(captureUser({ user: null }), null);
  assert.deepEqual(captureUser({ user: ALICE }), ALICE);
  assert.throws(() => captureUser({ user: { id: 42 } }), /Invalid Chrome sign-in capture/);
  assert.throws(() => captureUser({ user: "alice@example.test" }), /Invalid Chrome sign-in capture/);
});

test("another card already signed in to a login is found by email or user id, never the card itself", (t) => {
  const root = path.join(__dirname, "..", "..", "aiTemp", "chrome-sign-in-identity-tests", crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  const accounts = createBrowserAccounts({ dataRoot: path.join(root, "browser-accounts"), profile: "production" });
  t.after(async () => { await accounts.saved(); fs.rmSync(root, { recursive: true, force: true }); });
  const bob = accounts.add();
  accounts.setEmail(bob, "Bob@Example.test");
  const team = accounts.add();
  accounts.recordPlan(team, { userId: ALICE.id, workspaceId: "7c1d2e3f-0000-4000-8000-000000000001", workspaceStructure: "workspace",
    workspaceRole: "standard-user", planType: "team" });
  const fresh = accounts.add();

  assert.deepEqual(accounts.otherAccountWithLogin(accounts.partitionOf(fresh), BOB),
    { id: bob, label: "ChatGPT account 2", email: "Bob@Example.test" }, "email, ignoring case");
  assert.equal(accounts.otherAccountWithLogin(accounts.partitionOf(fresh), { id: ALICE.id, email: null })?.id, team, "user id from its plan");
  assert.equal(accounts.otherAccountWithLogin(accounts.partitionOf(bob), BOB), null, "re-signing a card into its own login");
  assert.equal(accounts.otherAccountWithLogin(accounts.partitionOf(fresh), { id: "user-Somebodyelsexxxxxxxxx", email: "new@example.test" }), null);
  assert.equal(accounts.otherAccountWithLogin(accounts.partitionOf(fresh), null), null);
});

// installPasskeyLogin with a Chrome capture: the session opens as `opensAs`; `taken` is another
// card's login (signInConflict).
function importFixture({ opensAs, taken = null }) {
  const calls = [];
  const verifications = [];
  const contents = {
    session: {
      cookies: { set: async () => calls.push("cookie"), flushStore: async () => {} },
      flushStorageData() {},
    },
    isDestroyed: () => false,
    loadURL: async () => {},
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    partition: PARTITION,
    view: { webContents: contents },
    state: { authenticated: false },
    clearOwnedSessionForPasskey: async () => {
      calls.push("clear");
      verifications.push(host.signInVerificationFor(PARTITION));
    },
    resetFailedPasskeyLogin: async () => calls.push("reset"),
    waitForAuthenticated: async () => { calls.push("signed-in"); return { authenticated: true }; },
    readSessionUser: async () => opensAs,
    signInConflict: (partition, user) => (partition === PARTITION && taken && sameSessionUser(user, taken) ? "ChatGPT account 2" : null),
    runSessionInspection: async () => calls.push("inspect"),
    activateHomeSurface() {},
    show() {},
    logger: { info() {} },
    snapshot: () => ({ authenticated: true }),
  });
  const transfer = (expectedUser) => {
    const transferCalls = [];
    return {
      calls: transferCalls,
      source: "approved-chrome-profile-connector",
      expectedUser,
      storageState: {
        cookies: [{ name: "__Secure-next-auth.session-token", value: "private", domain: ".chatgpt.com", path: "/",
          expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
        origins: [],
      },
      complete: (verified) => transferCalls.push(["complete", verified]),
      cleanup: async () => transferCalls.push("cleanup"),
    };
  };
  return { host, calls, verifications, transfer };
}

test("a Chrome sign-in that opens as another card's login is refused, wiped and named", async () => {
  // The reported case: an older connector (no user), Chrome holding two logins, opening as bob.
  const { host, calls, verifications, transfer } = importFixture({ opensAs: BOB, taken: BOB });
  const handoff = transfer(undefined);
  await assert.rejects(BrowserHost.prototype.installPasskeyLogin.call(host, handoff), (error) => {
    assert.match(error.message, /bob@example\.test, which is already the account "ChatGPT account 2", so nothing was added/);
    assert.match(error.message, /signed in to more than one account/);
    assert.doesNotMatch(error.message, /private/, "never a cookie value");
    return true;
  });
  assert.deepEqual(calls.filter((call) => call !== "cookie"), ["clear", "signed-in", "reset"], "refused before any inspection records a plan");
  assert.equal(await verifications[0], false, "main records no email for the refused sign-in");
  assert.equal(host.signInVerificationFor(PARTITION), null);
  assert.deepEqual(handoff.calls, ["cleanup", ["complete", false]]);
});

test("a Chrome sign-in that opens as another login than Chrome showed is refused", async () => {
  const { host, calls, transfer } = importFixture({ opensAs: BOB });
  const handoff = transfer(ALICE);
  await assert.rejects(BrowserHost.prototype.installPasskeyLogin.call(host, handoff),
    /Chrome showed alice@example\.test, but its copied session opened as bob@example\.test, so nothing was added/);
  assert.ok(calls.includes("reset"));
  assert.ok(!calls.includes("inspect"));
});

test("Chrome's own login that another card holds is refused before anything is imported", async () => {
  const { host, calls, transfer } = importFixture({ opensAs: BOB, taken: BOB });
  const handoff = transfer(BOB);
  await assert.rejects(BrowserHost.prototype.installPasskeyLogin.call(host, handoff), /already the account "ChatGPT account 2"/);
  assert.deepEqual(calls, [], "the account's session is never cleared or written");
  assert.deepEqual(handoff.calls, ["cleanup", ["complete", false]]);
});

test("a Chrome sign-in whose login cannot be read is refused rather than guessed", async () => {
  const { host, transfer } = importFixture({ opensAs: null });
  await assert.rejects(BrowserHost.prototype.installPasskeyLogin.call(host, transfer(ALICE)), /could not confirm which ChatGPT account/);
});

test("the login Chrome showed, held by no other card, is kept and confirmed before inspection", async () => {
  const { host, calls, verifications, transfer } = importFixture({ opensAs: ALICE, taken: BOB });
  const handoff = transfer(ALICE);
  const result = await BrowserHost.prototype.installPasskeyLogin.call(host, handoff);
  assert.equal(result.authenticated, true);
  assert.equal(await verifications[0], true);
  assert.deepEqual(calls.filter((call) => call !== "cookie"), ["clear", "signed-in", "inspect"]);
  assert.deepEqual(handoff.calls, ["cleanup", ["complete", true]]);
  assert.equal(host.signInVerificationFor(PARTITION), null, "nothing stays pending");
});

test("main records a signed-in account's email only once its copied sign-in is confirmed", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf("async function onBrowserAccountSignedIn(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const gate = body.indexOf("signInVerificationFor");
  assert.ok(gate > 0, "the sign-in waits on the host's verification");
  assert.ok(gate < body.indexOf("automaticAccountMcp?.sync()") && gate < body.indexOf("setEmail("),
    "before MCP setup or the email are touched");
  assert.match(source, /signInConflict: \(partition, user\) => browserAccounts\.otherAccountWithLogin\(partition, user\)/);
});
