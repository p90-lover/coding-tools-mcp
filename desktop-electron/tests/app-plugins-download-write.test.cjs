"use strict";
require("./support/temp-dirs.cjs");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAppPlugins } = require("../electron/app-plugins.cjs");

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("a plugin download whose file can't be written fails and installs nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-plugins-write-"));
  const stateDir = path.join(root, "cpa");
  const pluginDir = path.join(stateDir, "plugins", "windows", "amd64");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "cpa-provider-manager-v0.2.1.dll"), "old");
  const dll = Buffer.from("provider manager 0.2.2");
  const asset = { id: 7, name: "cpa-provider-manager-v0.2.2.dll", size: dll.length, digest: `sha256:${sha(dll)}` };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/p90-lover/cpa_provider_manager/releases") {
      return json([{ tag_name: "v0.2.2", draft: false, prerelease: false, html_url: "https://github.com/x", assets: [asset] }]);
    }
    if (url.pathname.endsWith("/releases/assets/7")) return new Response(dll);
    return new Response("unexpected", { status: 500 });
  };
  // The staging file can't be opened for writing (here: a folder already holds its name; on a
  // user's disk a full drive or a locked file does the same). The bytes received still match
  // GitHub's SHA-256, so only the write error can say the file on disk is not that download.
  fs.mkdirSync(path.join(stateDir, "plugin-downloads", "1000-cpa-provider-manager-v0.2.2.dll.part"), { recursive: true });
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  let restarts = 0;
  try {
    const plugins = createAppPlugins({
      cpaStateDir: stateDir, services: () => ({ managedComponentsSnapshot: () => ({ components: [] }) }),
      restartCpa: async () => { restarts += 1; }, fetchImpl, env: { GH_TOKEN: "ghp_testtoken0123456789abcdef" },
      spawnImpl: () => { throw new Error("no gh"); }, platform: "win32", arch: "x64", logger: { info() {}, warn() {} },
      pluginBundleFile: path.join(root, "BUNDLE.json"), now: () => 1000,
    });
    await assert.rejects(plugins.update("cpa-plugin:cpa-provider-manager"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.deepEqual(uncaught.map((error) => error.code), []);
  assert.deepEqual(fs.readdirSync(pluginDir), ["cpa-provider-manager-v0.2.1.dll"]);
  assert.equal(fs.existsSync(path.join(stateDir, "plugin-updates.json")), false);
  assert.equal(restarts, 0);
});
