require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runtimeInvocation } = require("../electron/runtime-command.cjs");
const {
  ensurePackagedRuntime,
  pruneOldRuntimes,
  validateRuntimeBundle,
  waitForPackagedRuntimeSource,
} = require("../electron/runtime-install.cjs");

test("older versions' runtime copies are removed, keeping this version, the newest other and fresh temporaries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-prune-"));
  const coreHome = path.join(root, "core-home");
  const versions = path.join(coreHome, "versions");
  const suffix = `-${process.platform}-${process.arch}`;
  const now = Date.now();
  const make = (name, ageMs) => {
    const folder = path.join(versions, name);
    fs.mkdirSync(path.join(folder, "app"), { recursive: true });
    fs.writeFileSync(path.join(folder, "app", "cli.js"), name);
    const when = new Date(now - ageMs);
    fs.utimesSync(folder, when, when);
  };
  const hour = 60 * 60_000;
  make(`0.8.11${suffix}`, 1 * hour);                       // this version
  make(`0.8.11${suffix}-0123456789ab`, 1 * hour);          // its side bundle: ensurePackagedRuntime's
  make(`0.8.10${suffix}`, 5 * hour);                       // newest other: kept for a rollback
  make(`0.8.6${suffix}`, 30 * hour);
  make(`0.7.0-rc.26${suffix}`, 90 * hour);
  make(`0.8.1${suffix}.tmp-35972-1792488529502`, 50 * hour); // stale temporary
  make(`0.8.9${suffix}.tmp-1-2`, 5 * 60_000);              // a temporary still being written
  make(`0.8.11${suffix}.tmp-7-8`, 3 * hour);               // this version's copy cut off by a full disk
  make(`0.8.11${suffix}.previous-7-9`, 20 * 60_000);       // ...and one just replaced: not yet
  fs.writeFileSync(path.join(versions, "stray.txt"), "x");
  try {
    const removed = await pruneOldRuntimes({ app: { isPackaged: true, getVersion: () => "0.8.11" }, coreHome, now });
    assert.deepEqual(removed.sort(), [`0.7.0-rc.26${suffix}`, `0.8.1${suffix}.tmp-35972-1792488529502`, `0.8.6${suffix}`,
      `0.8.11${suffix}.tmp-7-8`].sort());
    assert.deepEqual(fs.readdirSync(versions).sort(), [`0.8.10${suffix}`, `0.8.11${suffix}`, `0.8.11${suffix}-0123456789ab`,
      `0.8.11${suffix}.previous-7-9`, `0.8.9${suffix}.tmp-1-2`, "stray.txt"].sort());
    assert.deepEqual(await pruneOldRuntimes({ app: { isPackaged: false, getVersion: () => "0.8.11" }, coreHome, now }), [],
      "a development run leaves the core home alone");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestFiles(source) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(source, absolutePath).split(path.sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const content = fs.readFileSync(absolutePath);
      files.push({
        path: relativePath,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  visit(source);
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

function bundleIdFor(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function writeRuntimeManifest(source, version = "0.2.0") {
  const files = manifestFiles(source);
  fs.writeFileSync(path.join(source, "manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    appVersion: version,
    bundleId: bundleIdFor(files),
    bunVersion: "1.4.3",
    platform: process.platform,
    arch: process.arch,
    launcher: `bin/${process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`,
    entrypoint: "app/cli.js",
    playwright: "1.62.0",
    files,
  })}\n`);
}

function runtimeFixture(root, version = "0.2.0") {
  const source = path.join(root, "resources", "runtime");
  const executable = path.join(source, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(source, "app"), { recursive: true });
  fs.writeFileSync(executable, "bun");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(source, "app", "cli.js"), "cli");
  fs.writeFileSync(path.join(source, "app", "browser-helper.cjs"), "helper");
  fs.mkdirSync(path.join(source, "app", "node_modules", "zod", "v4"), { recursive: true });
  fs.writeFileSync(path.join(source, "app", "node_modules", "zod", "v4", "index.js"), "zod-v4");
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(source, "app", "node_modules", ".bin"), { recursive: true });
    fs.symlinkSync("../zod/v4/index.js", path.join(source, "app", "node_modules", ".bin", "zod-v4"));
  }
  fs.mkdirSync(path.join(source, "app", "node_modules", "nested-dependency", "dist", "runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "app", "node_modules", "nested-dependency", "dist", "runtime", "worker.js"),
    "nested-worker",
  );
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "bin", process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"),
    "launcher",
  );
  writeRuntimeManifest(source, version);
  return path.join(root, "resources");
}

test("packaged runtime is installed once into a durable versioned directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-install-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.equal(installed, path.join(coreHome, "versions", `0.2.0-${process.platform}-${process.arch}`));
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli");
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);

    const invocation = runtimeInvocation({
      app,
      sourceRoot: root,
      installedRuntimeRoot: installed,
      args: ["serve"],
    });
    assert.equal(invocation.cwd, installed);
    assert.equal(invocation.args[0], path.join(installed, "app", "cli.js"));
    assert.equal(invocation.args[1], "serve");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a full disk while copying the runtime runs this session from the packaged copy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-enospc-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  const originalCopy = fs.cpSync;
  fs.cpSync = function full(from, to, options) {
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, "partial"), "x");
    throw Object.assign(new Error("ENOSPC: no space left on device, copyfile"), { code: "ENOSPC" });
  };
  try {
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), path.join(resourcesPath, "runtime"));
    assert.deepEqual(fs.readdirSync(path.join(coreHome, "versions")), [], "the partial copy is removed");
    fs.cpSync = originalCopy;
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }),
      path.join(coreHome, "versions", `0.2.0-${process.platform}-${process.arch}`), "a later start with room copies it");
    fs.cpSync = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
    fs.rmSync(path.join(coreHome, "versions"), { recursive: true, force: true });
    assert.throws(() => ensurePackagedRuntime({ app, coreHome, resourcesPath }), /EIO/, "other copy errors still stop the start");
  } finally {
    fs.cpSync = originalCopy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a launch after the runtime was hashed does not read its files again, and still catches a changed one", async () => {
  // Seen live: hashing 6,002 runtime files (164 MB) twice on every launch kept the window from
  // opening for over two minutes on a hard disk.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-verified-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  const originalRead = fs.readFileSync;
  const reads = [];
  fs.readFileSync = function (file, ...rest) { reads.push(String(file)); return originalRead.call(this, file, ...rest); };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.ok(reads.some(file => file.endsWith("cli.js")), "the first launch hashes the files");
    reads.length = 0;
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.deepEqual(reads.filter(file => !file.endsWith("manifest.json") && !file.includes("runtime-verified")), [],
      "the next launch reads only the manifests and what it remembered");
    // The startup wait before it checks the same packaged bundle, and remembers it the same way.
    reads.length = 0;
    await waitForPackagedRuntimeSource({ app, resourcesPath, coreHome });
    assert.deepEqual(reads.filter(file => !file.endsWith("manifest.json") && !file.includes("runtime-verified")), [],
      "the startup wait reads no runtime file either");

    // Same size, different content: its changed time moves, so it is hashed again and rejected.
    fs.writeFileSync(path.join(installed, "app", "cli.js"), "CLI");
    assert.throws(() => validateRuntimeBundle(installed, { version: "0.2.0", platform: process.platform, arch: process.arch },
      { stampDir: path.join(coreHome, "runtime-verified") }), /checksum mismatch/);
    // The launch itself replaces the damaged version directory from the package.
    const repaired = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.equal(originalRead(path.join(repaired, "app", "cli.js"), "utf8"), "cli");
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a launch with a whole installed copy does not walk the packaged copy's files again", () => {
  // Seen live 2026-10-31: each launch walked the runtime's 6,149 files three times on the main
  // process, each stat up to a second on the busy hard disk; the packaged copy is only a source.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-source-walk-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  const source = path.join(resourcesPath, "runtime");
  const originals = { lstatSync: fs.lstatSync, readdirSync: fs.readdirSync };
  const touched = [];
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    fs.lstatSync = function (file, ...rest) { if (String(file).startsWith(source)) touched.push(String(file)); return originals.lstatSync.call(this, file, ...rest); };
    fs.readdirSync = function (file, ...rest) { if (String(file).startsWith(source)) touched.push(String(file)); return originals.readdirSync.call(this, file, ...rest); };
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.deepEqual(touched, [], "only the packaged manifest is read");
    // A damaged installed copy is still repaired from the packaged one, checked whole first.
    Object.assign(fs, originals);
    fs.rmSync(path.join(installed, "app", "cli.js"));
    const repaired = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.equal(fs.readFileSync(path.join(repaired, "app", "cli.js"), "utf8"), "cli");
  } finally {
    Object.assign(fs, originals);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime installation rejects a platform or version mismatch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-mismatch-"));
  const resourcesPath = runtimeFixture(root, "0.1.0");
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome: path.join(root, "core-home"),
        resourcesPath,
      }),
      /identity mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime rejects a missing executable before creating durable state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-missing-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const executable = path.join(
    resourcesPath,
    "runtime",
    "runtime",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  fs.rmSync(executable);
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome,
        resourcesPath,
      }),
      /Runtime bundle file is missing/,
    );
    assert.equal(fs.existsSync(coreHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const relativePath of [
  ["app", "node_modules", "zod", "v4", "index.js"],
  ["app", "node_modules", "nested-dependency", "dist", "runtime", "worker.js"],
]) {
  test(`packaged runtime rejects a missing nested dependency: ${relativePath.join("/")}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-dependency-"));
    const resourcesPath = runtimeFixture(root);
    const coreHome = path.join(root, "core-home");
    fs.rmSync(path.join(resourcesPath, "runtime", ...relativePath));
    try {
      assert.throws(
        () => ensurePackagedRuntime({
          app: { isPackaged: true, getVersion: () => "0.2.0" },
          coreHome,
          resourcesPath,
        }),
        /Runtime bundle file is missing/,
      );
      assert.equal(fs.existsSync(coreHome), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("packaged runtime rejects same-count content corruption", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-corrupt-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const dependency = path.join(resourcesPath, "runtime", "app", "node_modules", "zod", "v4", "index.js");
  fs.writeFileSync(dependency, "bad-v4");
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome,
        resourcesPath,
      }),
      /checksum mismatch/,
    );
    assert.equal(fs.existsSync(coreHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime source wait accepts a delayed final dependency within its bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-delayed-"));
  const resourcesPath = runtimeFixture(root);
  const delayed = path.join(
    resourcesPath,
    "runtime",
    "app",
    "node_modules",
    "nested-dependency",
    "dist",
    "runtime",
    "worker.js",
  );
  const content = fs.readFileSync(delayed);
  fs.rmSync(delayed);
  const materialize = setTimeout(() => fs.writeFileSync(delayed, content), 40);
  try {
    assert.equal(
      await waitForPackagedRuntimeSource({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        resourcesPath,
        timeoutMs: 500,
        intervalMs: 10,
      }),
      path.join(resourcesPath, "runtime"),
    );
  } finally {
    clearTimeout(materialize);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime source wait fails closed when materialization exceeds its bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-timeout-"));
  const resourcesPath = runtimeFixture(root);
  fs.rmSync(path.join(resourcesPath, "runtime", "app", "node_modules", "zod", "v4", "index.js"));
  try {
    await assert.rejects(
      waitForPackagedRuntimeSource({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        resourcesPath,
        timeoutMs: 30,
        intervalMs: 5,
      }),
      /did not fully materialize within 30ms.*Runtime bundle file is missing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime transactionally repairs an incomplete installed bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-repair-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const dependency = path.join(
      installed,
      "app",
      "node_modules",
      "nested-dependency",
      "dist",
      "runtime",
      "worker.js",
    );
    fs.rmSync(dependency);
    fs.writeFileSync(path.join(installed, "corrupt.partial"), "interrupted copy");

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(dependency, "utf8"), "nested-worker");
    assert.equal(fs.existsSync(path.join(installed, "corrupt.partial")), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed)).filter(name => name.includes(".previous-") || name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed candidate validation preserves the previous validated runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-preserve-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  const originalCopy = fs.cpSync;
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    fs.cpSync = (from, to, options) => {
      originalCopy(from, to, options);
      fs.rmSync(path.join(to, "app", "node_modules", "zod", "v4", "index.js"));
    };
    assert.throws(
      () => ensurePackagedRuntime({ app, coreHome, resourcesPath }),
      /Runtime bundle file is missing/,
    );
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli");
    assert.equal(
      validateRuntimeBundle(installed, {
        version: "0.2.0",
        platform: process.platform,
        arch: process.arch,
      }),
      installed,
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed)).filter(name => name.includes(".previous-") || name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.cpSync = originalCopy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime replaces stale files when a release is refreshed under the same version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-refresh-"));
  const resourcesPath = runtimeFixture(root, "0.2.0");
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    fs.writeFileSync(path.join(installed, "old-release-marker"), "old");

    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "new cli");
    assert.equal(fs.existsSync(path.join(installed, "old-release-marker")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a same-version release whose directory is in use runs beside it, then is promoted once free", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-busy-"));
  const resourcesPath = runtimeFixture(root, "0.2.0");
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  const rename = fs.renameSync;
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    // The persistent core still runs from the version directory: Windows refuses to move it.
    fs.renameSync = function busy(from, to) {
      if (path.resolve(from) === path.resolve(installed)) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return rename.call(this, from, to);
    };
    const beside = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.notEqual(beside, installed);
    assert.equal(path.dirname(beside), path.dirname(installed));
    assert.equal(fs.readFileSync(path.join(beside, "app", "cli.js"), "utf8"), "new cli");
    assert.notEqual(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "new cli", "the running release is left untouched");
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), beside, "a busy launch reuses the side bundle without copying again");

    // The core has restarted: the side bundle takes the version directory's place.
    fs.renameSync = rename;
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "new cli");
    assert.equal(fs.existsSync(beside), false);
    assert.deepEqual(fs.readdirSync(path.dirname(installed)), [path.basename(installed)]);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file an update set aside because something still ran it does not fail startup or get copied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-set-aside-"));
  const resourcesPath = runtimeFixture(root);
  const executable = process.platform === "win32" ? "bun.exe" : "bun";
  fs.writeFileSync(path.join(resourcesPath, "runtime", "runtime", `${executable}.old-1791112467550`), "old bun");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    assert.equal(await waitForPackagedRuntimeSource({ app, resourcesPath, timeoutMs: 100, intervalMs: 10 }), path.join(resourcesPath, "runtime"));
    const installed = ensurePackagedRuntime({ app, coreHome: path.join(root, "core-home"), resourcesPath });
    assert.equal(fs.existsSync(path.join(installed, "runtime", `${executable}.old-1791112467550`)), false);
    // Any other stray file is still refused.
    fs.writeFileSync(path.join(resourcesPath, "runtime", "app", "stray.js"), "x");
    await assert.rejects(waitForPackagedRuntimeSource({ app, resourcesPath, timeoutMs: 30, intervalMs: 10 }), /unmanifested file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
