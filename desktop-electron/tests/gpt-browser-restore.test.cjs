const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { restoreGptBrowserAccounts } = require("../electron/gpt-browser-restore.cjs");

function layout() {
  const root = fs.mkdtempSync(path.join(process.env.CODING_TOOLS_TEST_TMP || os.tmpdir(), "gpt-restore-"));
  const dirs = { gptDataRoot: path.join(root, "gpt-browser"), partitionsRoot: path.join(root, "Partitions"), trashRoot: path.join(root, "Trash", "gpt-browser") };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return { root, ...dirs, logger: { info() {}, warn() {} } };
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const merged = (dirs, accounts) => write(path.join(dirs.gptDataRoot, "accounts.merged.json"), JSON.stringify({ version: 1, activeId: accounts[0].id, accounts }));

test("merged accounts come back: a trashed folder moves back, a Browser tab account is copied without caches", async () => {
  const dirs = layout();
  merged(dirs, [{ id: "pct5jnj6jxgg", label: "Account 1", email: "a@example.com" }, { id: "t1lasuic06yt", label: "Account 2" }, { id: "zzzzzzzzzzzz", label: "Gone" }]);
  write(path.join(dirs.trashRoot, "gpt-browser-pct5jnj6jxgg-100", "Cookies"), "old");
  write(path.join(dirs.trashRoot, "gpt-browser-pct5jnj6jxgg-200", "Cookies"), "newest");
  write(path.join(dirs.partitionsRoot, "coding-tools-chatgpt-t1lasuic06yt", "Cookies"), "signed in");
  write(path.join(dirs.partitionsRoot, "coding-tools-chatgpt-t1lasuic06yt", "Cache", "Cache_Data", "f_000001"), "cache");

  const result = await restoreGptBrowserAccounts(dirs);

  assert.deepEqual(result, { restored: [{ id: "pct5jnj6jxgg", from: "trash" }, { id: "t1lasuic06yt", from: "browser" }], missing: ["zzzzzzzzzzzz"] });
  assert.equal(fs.readFileSync(path.join(dirs.partitionsRoot, "gpt-browser-pct5jnj6jxgg", "Cookies"), "utf8"), "newest");
  assert.ok(fs.existsSync(path.join(dirs.trashRoot, "gpt-browser-pct5jnj6jxgg-100")));
  assert.equal(fs.readFileSync(path.join(dirs.partitionsRoot, "gpt-browser-t1lasuic06yt", "Cookies"), "utf8"), "signed in");
  assert.equal(fs.existsSync(path.join(dirs.partitionsRoot, "gpt-browser-t1lasuic06yt", "Cache")), false);
  // The Browser tab keeps its account.
  assert.ok(fs.existsSync(path.join(dirs.partitionsRoot, "coding-tools-chatgpt-t1lasuic06yt", "Cookies")));
  const saved = JSON.parse(fs.readFileSync(path.join(dirs.gptDataRoot, "accounts.json"), "utf8"));
  assert.deepEqual(saved.accounts.map((entry) => entry.id), ["pct5jnj6jxgg", "t1lasuic06yt", "zzzzzzzzzzzz"]);
  assert.ok(fs.existsSync(path.join(dirs.gptDataRoot, "accounts.merged.json")));
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test("nothing is restored when accounts.json is there or nothing was merged", async () => {
  const dirs = layout();
  assert.equal(await restoreGptBrowserAccounts(dirs), null);
  merged(dirs, [{ id: "t1lasuic06yt", label: "Account 2" }]);
  write(path.join(dirs.gptDataRoot, "accounts.json"), JSON.stringify({ version: 1, accounts: [] }));
  write(path.join(dirs.partitionsRoot, "coding-tools-chatgpt-t1lasuic06yt", "Cookies"), "signed in");
  assert.equal(await restoreGptBrowserAccounts(dirs), null);
  assert.equal(fs.existsSync(path.join(dirs.partitionsRoot, "gpt-browser-t1lasuic06yt")), false);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

test("a second start after a restore leaves everything as it is", async () => {
  const dirs = layout();
  merged(dirs, [{ id: "t1lasuic06yt", label: "Account 2" }]);
  write(path.join(dirs.partitionsRoot, "coding-tools-chatgpt-t1lasuic06yt", "Cookies"), "signed in");
  await restoreGptBrowserAccounts(dirs);
  write(path.join(dirs.partitionsRoot, "gpt-browser-t1lasuic06yt", "Cookies"), "used since");
  assert.equal(await restoreGptBrowserAccounts(dirs), null);
  assert.equal(fs.readFileSync(path.join(dirs.partitionsRoot, "gpt-browser-t1lasuic06yt", "Cookies"), "utf8"), "used since");
  fs.rmSync(dirs.root, { recursive: true, force: true });
});
