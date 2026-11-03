"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createBrowserAccounts } = require("../electron/browser-accounts.cjs");
const { mergeGptBrowserAccounts } = require("../electron/gpt-browser-merge.cjs");

const AI_TEMP = path.join(__dirname, "..", "..", "aiTemp");
const quiet = { info() {}, warn() {} };

function setup({ gpt, browser } = {}) {
  fs.mkdirSync(AI_TEMP, { recursive: true });
  const root = fs.mkdtempSync(path.join(AI_TEMP, "gpt-browser-merge-"));
  const gptDataRoot = path.join(root, "gpt-browser");
  const accountsRoot = path.join(root, "browser-accounts");
  const partitionsRoot = path.join(root, "Partitions");
  const trashRoot = path.join(root, "Trash", "gpt-browser");
  fs.mkdirSync(gptDataRoot, { recursive: true });
  fs.mkdirSync(accountsRoot, { recursive: true });
  fs.mkdirSync(partitionsRoot, { recursive: true });
  if (gpt) {
    fs.writeFileSync(path.join(gptDataRoot, "accounts.json"), JSON.stringify({ activeId: gpt[0]?.id ?? null, accounts: gpt }));
    // Each GPT Browser account's partition, with a "cookie" to follow.
    for (const entry of gpt) {
      fs.mkdirSync(path.join(partitionsRoot, `gpt-browser-${entry.id}`, "Network"), { recursive: true });
      fs.writeFileSync(path.join(partitionsRoot, `gpt-browser-${entry.id}`, "Network", "Cookies"), `cookies of ${entry.id}`);
    }
  }
  if (browser) fs.writeFileSync(path.join(accountsRoot, "accounts.json"), JSON.stringify(browser));
  const accounts = () => createBrowserAccounts({ dataRoot: accountsRoot, profile: "production", logger: quiet });
  const merge = (registry) => mergeGptBrowserAccounts({ gptDataRoot, partitionsRoot, trashRoot, accounts: registry, logger: quiet, now: () => 1234 });
  return { root, gptDataRoot, partitionsRoot, trashRoot, accounts, merge };
}

const cookies = (partitionsRoot, folder) => fs.readFileSync(path.join(partitionsRoot, folder, "Network", "Cookies"), "utf8");

test("each GPT Browser account joins the browser's list under its id, its sign-in moved with it", async () => {
  const context = setup({ gpt: [
    { id: "pct5jnj6jxgg", label: "ChatGPT account 1", email: "one@example.com" },
    { id: "t1lasuic06yt", label: "Work", email: null },
  ] });
  const registry = context.accounts();
  const result = await context.merge(registry);
  await registry.saved();

  assert.deepEqual(result.merged, [{ from: "pct5jnj6jxgg", to: "pct5jnj6jxgg" }, { from: "t1lasuic06yt", to: "t1lasuic06yt" }]);
  assert.equal(cookies(context.partitionsRoot, "coding-tools-chatgpt-pct5jnj6jxgg"), "cookies of pct5jnj6jxgg");
  assert.equal(cookies(context.partitionsRoot, "coding-tools-chatgpt-t1lasuic06yt"), "cookies of t1lasuic06yt");
  assert.equal(fs.existsSync(path.join(context.partitionsRoot, "gpt-browser-pct5jnj6jxgg")), false);

  // A fresh read of the saved list has them, after the first account, which stays active.
  const listed = context.accounts().status();
  assert.deepEqual(listed.accounts.map(({ id, label, email }) => ({ id, label, email })), [
    { id: "main", label: "ChatGPT account 1", email: null },
    { id: "pct5jnj6jxgg", label: "ChatGPT account 1", email: "one@example.com" },
    { id: "t1lasuic06yt", label: "Work", email: null },
  ]);
  assert.equal(listed.activeId, "main");
  // Done once: the GPT Browser's file is kept as a record, and a second start does nothing.
  assert.equal(fs.existsSync(path.join(context.gptDataRoot, "accounts.json")), false);
  assert.ok(fs.existsSync(path.join(context.gptDataRoot, "accounts.merged.json")));
  assert.deepEqual(await context.merge(context.accounts()), { merged: [], duplicates: [], left: [] });
});

test("an account the list already signs in to isn't added twice; its copy goes to Trash", async () => {
  const context = setup({
    gpt: [{ id: "pct5jnj6jxgg", label: "ChatGPT account 1", email: "Same@Example.com" }],
    browser: { activeId: "main", accounts: [{ id: "main", label: "Mine", email: "same@example.com" }] },
  });
  const registry = context.accounts();
  const result = await context.merge(registry);
  assert.deepEqual(result.duplicates, ["pct5jnj6jxgg"]);
  assert.deepEqual(registry.status().accounts.map((entry) => entry.id), ["main"]);
  assert.equal(fs.readFileSync(path.join(context.trashRoot, "gpt-browser-pct5jnj6jxgg-1234", "Network", "Cookies"), "utf8"), "cookies of pct5jnj6jxgg");
});

test("an id already in use, or a leftover folder of that name, gets the account a new id", async () => {
  const context = setup({
    gpt: [{ id: "pct5jnj6jxgg", label: "GPT one", email: "gpt@example.com" }],
    browser: { activeId: "main", accounts: [{ id: "main" }, { id: "pct5jnj6jxgg", label: "Other", email: "other@example.com" }] },
  });
  const registry = context.accounts();
  const [{ to }] = (await context.merge(registry)).merged;
  assert.notEqual(to, "pct5jnj6jxgg");
  assert.match(to, /^[a-z0-9]{12}$/);
  assert.equal(cookies(context.partitionsRoot, `coding-tools-chatgpt-${to}`), "cookies of pct5jnj6jxgg");
  assert.equal(registry.status().accounts.find((entry) => entry.id === to).label, "GPT one");
});

test("accounts that don't fit in the list stay the GPT Browser's, untouched", async () => {
  const browser = { activeId: "main", accounts: [{ id: "main" }] };
  for (let index = 1; index < 11; index += 1) browser.accounts.push({ id: `acct${String(index).padStart(8, "0")}`, email: `${index}@example.com` });
  const context = setup({ gpt: [
    { id: "pct5jnj6jxgg", label: "Fits", email: "fits@example.com" },
    { id: "t1lasuic06yt", label: "No room", email: "late@example.com" },
  ], browser });
  const registry = context.accounts();
  const result = await context.merge(registry);
  assert.deepEqual([result.merged.map((entry) => entry.from), result.left], [["pct5jnj6jxgg"], ["t1lasuic06yt"]]);
  assert.equal(registry.status().accounts.length, 12);
  assert.ok(fs.existsSync(path.join(context.partitionsRoot, "gpt-browser-t1lasuic06yt")));
  const rest = JSON.parse(fs.readFileSync(path.join(context.gptDataRoot, "accounts.json"), "utf8"));
  assert.deepEqual(rest.accounts.map((entry) => entry.id), ["t1lasuic06yt"]);
});

test("a start that stopped after listing the account finishes moving its folder", async () => {
  const context = setup({
    gpt: [{ id: "pct5jnj6jxgg", label: "Half done", email: "half@example.com" }],
    browser: { activeId: "main", accounts: [{ id: "main" }, { id: "pct5jnj6jxgg", label: "Half done", email: "half@example.com" }] },
  });
  const registry = context.accounts();
  const result = await context.merge(registry);
  assert.deepEqual(result.merged, [{ from: "pct5jnj6jxgg", to: "pct5jnj6jxgg" }]);
  assert.deepEqual(result.duplicates, []);
  assert.equal(cookies(context.partitionsRoot, "coding-tools-chatgpt-pct5jnj6jxgg"), "cookies of pct5jnj6jxgg");
  assert.equal(registry.status().accounts.length, 2);
});

test("no GPT Browser file means nothing to merge", async () => {
  const context = setup();
  assert.deepEqual(await context.merge(context.accounts()), { merged: [], duplicates: [], left: [] });
});
