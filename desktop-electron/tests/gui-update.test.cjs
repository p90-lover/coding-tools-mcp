"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { createGuiUpdateController, guiAssetName } = require("../electron/gui-update.cjs");

function fixture(t, { failDownload = false, failReload = false, failRollback = false } = {}) {
  const scratch = path.resolve(__dirname, "../../aiTemp/tmp");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "gui-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "0.8.40", shellHash = "a".repeat(64), builtin = path.join(root, "builtin.html");
  let revision = 1;
  const loaded = [];
  const controller = createGuiUpdateController({
    currentVersion: version, shellHash, packaged: true, rendererPath: builtin, updateRoot: root,
    reloadRenderer: async entry => { loaded.push(entry); if (failRollback || (failReload && entry !== builtin)) throw new Error("fixture reload failed"); },
    dependencies: {
      fetchRelease: async () => {
        const tag = `v${version}-gui.r${revision}`, assetName = guiAssetName(version, revision);
        const url = name => `https://github.com/p90-lover/coding-tools-mcp/releases/download/${tag}/${name}`;
        return { tag_name: tag, assets: [{ name: assetName, browser_download_url: url(assetName) }, { name: "SHA256SUMS.txt", browser_download_url: url("SHA256SUMS.txt") }] };
      },
      downloadText: async () => `${crypto.createHash("sha256").update(bundle()).digest("hex")}  ${guiAssetName(version, revision)}`,
      downloadFile: async (_url, destination) => {
        fs.writeFileSync(destination, bundle());
        if (failDownload) throw new Error("fixture download failed");
      },
    },
  });
  function bundle() {
    return zlib.gzipSync(JSON.stringify({ schema: 1, shellVersion: version, shellHash, revision,
      files: [{ path: "index.html", content: Buffer.from(`<main>Revision ${revision}</main>`).toString("base64") }] }));
  }
  return { controller, loaded, builtin, versionRoot: path.join(root, version), next: () => { revision += 1; } };
}

test("GUI update success removes staging downloads and retains only current and rollback bundles", async t => {
  const f = fixture(t);
  const bundles = () => fs.readdirSync(path.join(f.versionRoot, "bundles"));
  for (let revision = 1; revision <= 3; revision += 1) {
    await f.controller.checkNow();
    assert.equal(await f.controller.beginInstall(), true);
    assert.deepEqual(fs.readdirSync(path.join(f.versionRoot, "aiTemp")), []);
    assert.equal(bundles().length, Math.min(revision, 2));
    f.next();
  }
  assert.ok(bundles().some(name => name.startsWith("r3-")));
  assert.ok(bundles().some(name => name.startsWith("r2-")));
  assert.ok(fs.existsSync(f.controller.getRendererPath()));
});

test("GUI update failure removes partial downloads and a rolled-back renderer", async t => {
  for (const phase of ["download", "reload"]) await t.test(phase, async t => {
    const f = fixture(t, { failDownload: phase === "download", failReload: phase === "reload" });
    await f.controller.checkNow();
    await assert.rejects(f.controller.beginInstall(), /fixture .* failed/);
    assert.deepEqual(fs.readdirSync(path.join(f.versionRoot, "aiTemp")), []);
    const bundles = path.join(f.versionRoot, "bundles");
    assert.deepEqual(fs.existsSync(bundles) ? fs.readdirSync(bundles) : [], []);
    assert.equal(f.controller.getRendererPath(), f.builtin);
    assert.equal(f.controller.getState().status, "available");
  });
});

test("GUI staging creation failures return to available and can be retried", async t => {
  for (const phase of ["scratch", "stage"]) await t.test(phase, async t => {
    const f = fixture(t);
    await f.controller.checkNow();
    const method = phase === "scratch" ? "mkdirSync" : "mkdtempSync", original = fs[method];
    const target = path.join(f.versionRoot, "aiTemp", ...(phase === "stage" ? ["update-"] : []));
    let injected = false;
    fs[method] = function (directory, ...args) {
      if (!injected && String(directory) === target) {
        injected = true;
        throw Object.assign(new Error("fixture staging disk full"), { code: "ENOSPC" });
      }
      return original.call(this, directory, ...args);
    };
    try { await assert.rejects(f.controller.beginInstall(), { code: "ENOSPC" }); }
    finally { fs[method] = original; }
    assert.ok(injected);
    assert.equal(f.controller.getState().status, "available", "a setup failure cannot leave an active download");
    assert.equal(await f.controller.beginInstall(), true, "the same candidate can retry after storage recovers");
    assert.equal(f.controller.getState().status, "up-to-date");
    assert.deepEqual(fs.readdirSync(path.join(f.versionRoot, "aiTemp")), []);
  });
});

test("GUI update keeps a possibly active renderer when rollback cannot load", async t => {
  const f = fixture(t, { failRollback: true });
  await f.controller.checkNow();
  await assert.rejects(f.controller.beginInstall(), /fixture reload failed/);
  assert.deepEqual(fs.readdirSync(path.join(f.versionRoot, "aiTemp")), []);
  assert.equal(fs.readdirSync(path.join(f.versionRoot, "bundles")).length, 1, "assets stay available to a renderer whose rollback is unconfirmed");
});
