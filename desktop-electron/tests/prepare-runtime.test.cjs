"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const {
  prepareRuntime,
  publishStagedRuntime,
  resolveRuntimeLayout,
} = require("../scripts/runtime-preparation.cjs");

function fixtureRoot(label) {
  const root = path.join(
    repositoryRoot,
    "aiTemp",
    "Trash",
    "prepare-runtime-tests",
    `${label}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function fixtureLayout(label) {
  const root = fixtureRoot(label);
  const desktopRoot = path.join(root, "desktop-electron");
  const runtimeRoot = path.join(root, "runtime-web");
  fs.mkdirSync(path.join(desktopRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "scripts", "build-runtime-bundle.ts"), "// fixture\n");
  fs.writeFileSync(path.join(desktopRoot, "package.json"), JSON.stringify({ version: "0.6.0-rc.1" }));
  return {
    desktopRoot,
    repositoryRoot: root,
    runtimeRoot,
    output: path.join(desktopRoot, "build", "runtime"),
    workRoot: path.join(root, "aiTemp", "work", "runtime-bundle"),
    trashRoot: path.join(root, "aiTemp", "Trash", "runtime-bundle"),
    buildScript: "scripts/build-runtime-bundle.ts",
    bun: "fixture-bun",
    version: "0.6.0-rc.1",
    platform: "win32",
    arch: "x64",
  };
}

test("resolves the materialized runtime-web tree instead of the repository root", () => {
  const root = fixtureRoot("layout");
  const desktopRoot = path.join(root, "desktop-electron");
  const scriptDirectory = path.join(desktopRoot, "scripts");
  fs.mkdirSync(scriptDirectory, { recursive: true });
  fs.writeFileSync(path.join(desktopRoot, "package.json"), JSON.stringify({ version: "0.6.0-rc.1" }));
  const layout = resolveRuntimeLayout({ scriptDirectory, env: {} });
  assert.equal(layout.runtimeRoot, path.join(root, "runtime-web"));
  assert.equal(layout.output, path.join(root, "desktop-electron", "build", "runtime"));
  assert.ok(layout.workRoot.startsWith(path.join(root, "aiTemp", "work")));
  assert.ok(layout.trashRoot.startsWith(path.join(root, "aiTemp", "Trash")));
});

test("builds once from runtime-web and preserves the previous published runtime", () => {
  const layout = fixtureLayout("success");
  fs.mkdirSync(layout.output, { recursive: true });
  fs.writeFileSync(path.join(layout.output, "old.txt"), "old-runtime");
  const calls = [];
  const result = prepareRuntime({
    layout,
    sessionId: "success-session",
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      const staged = args[2];
      fs.mkdirSync(staged, { recursive: true });
      fs.writeFileSync(path.join(staged, "new.txt"), "new-runtime");
      return { status: 0, error: null };
    },
    validateRuntimeBundle(staged, identity) {
      assert.equal(staged, path.join(layout.workRoot, "success-session"));
      assert.deepEqual(identity, { version: "0.6.0-rc.1", platform: "win32", arch: "x64" });
    },
  });

  assert.deepEqual(calls, [{
    command: "fixture-bun",
    args: ["run", "scripts/build-runtime-bundle.ts", path.join(layout.workRoot, "success-session")],
    cwd: layout.runtimeRoot,
  }]);
  assert.equal(fs.readFileSync(path.join(layout.output, "new.txt"), "utf8"), "new-runtime");
  assert.equal(fs.readFileSync(path.join(result.retainedPrevious, "old.txt"), "utf8"), "old-runtime");
  assert.ok(result.retainedPrevious.startsWith(layout.trashRoot));
});

test("retains partial failed output and leaves the previous runtime untouched", () => {
  const layout = fixtureLayout("failure");
  fs.mkdirSync(layout.output, { recursive: true });
  fs.writeFileSync(path.join(layout.output, "old.txt"), "old-runtime");
  assert.throws(
    () => prepareRuntime({
      layout,
      sessionId: "failed-session",
      spawnSyncImpl(_command, args) {
        fs.mkdirSync(args[2], { recursive: true });
        fs.writeFileSync(path.join(args[2], "partial.txt"), "partial-runtime");
        return { status: 17, error: null };
      },
      validateRuntimeBundle() {
        assert.fail("failed builds must not be validated");
      },
    }),
    /RUNTIME_BUILD_FAILED.*retained=/,
  );
  assert.equal(fs.readFileSync(path.join(layout.output, "old.txt"), "utf8"), "old-runtime");
  const failureRoot = path.join(layout.trashRoot, "failures");
  const retained = fs.readdirSync(failureRoot);
  assert.equal(retained.length, 1);
  assert.equal(fs.readFileSync(path.join(failureRoot, retained[0], "partial.txt"), "utf8"), "partial-runtime");
});

test("rolls the previous runtime back if final publication fails", () => {
  const layout = fixtureLayout("rollback");
  const staged = path.join(layout.workRoot, "rollback-session");
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, "new.txt"), "new-runtime");
  fs.mkdirSync(layout.output, { recursive: true });
  fs.writeFileSync(path.join(layout.output, "old.txt"), "old-runtime");

  let publicationRenameSeen = false;
  const fsImpl = {
    ...fs,
    renameSync(source, destination) {
      if (source === staged && destination === layout.output) {
        publicationRenameSeen = true;
        throw new Error("simulated publication failure");
      }
      return fs.renameSync(source, destination);
    },
  };
  assert.throws(
    () => publishStagedRuntime({ staged, layout, fsImpl, sessionId: "rollback-session" }),
    /RUNTIME_PUBLICATION_FAILED/,
  );
  assert.equal(publicationRenameSeen, true);
  assert.equal(fs.readFileSync(path.join(layout.output, "old.txt"), "utf8"), "old-runtime");
  assert.equal(fs.readFileSync(path.join(staged, "new.txt"), "utf8"), "new-runtime");
});

test("runtime preparation source contains no destructive filesystem operation", () => {
  const files = [
    path.join(repositoryRoot, "desktop-electron", "scripts", "prepare-runtime.cjs"),
    path.join(repositoryRoot, "desktop-electron", "scripts", "runtime-preparation.cjs"),
  ];
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const pattern of [
    /fs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/,
    /\brm\s+-rf\b/i,
    /Remove-Item[^\n]*-Recurse[^\n]*-Force/i,
    /os\.tmpdir\s*\(/,
  ]) {
    assert.doesNotMatch(source, pattern);
  }
});
