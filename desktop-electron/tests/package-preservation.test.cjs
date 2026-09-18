const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const helperPath = path.join(launcherRoot, "scripts", "preservation.cjs");
const packagePath = path.join(launcherRoot, "scripts", "package.cjs");
const smokePath = path.join(launcherRoot, "scripts", "smoke-package.cjs");

function uniqueFixtureRoot(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    repositoryRoot,
    "aiTemp",
    "package-preservation-tests",
    `${stamp}-${process.pid}-${label}`,
  );
}

function loadHelper() {
  assert.ok(fs.existsSync(helperPath), "package preservation helper must exist");
  delete require.cache[require.resolve(helperPath)];
  return require(helperPath);
}

test("packaging and smoke scripts use repository aiTemp preservation without deletion", () => {
  const helper = fs.readFileSync(helperPath, "utf8");
  const packager = fs.readFileSync(packagePath, "utf8");
  const smoke = fs.readFileSync(smokePath, "utf8");

  for (const [name, source] of [["preservation helper", helper], ["package", packager], ["smoke", smoke]]) {
    assert.doesNotMatch(source, /require\(["']node:os["']\)/, `${name} must not use node:os temp roots`);
    assert.doesNotMatch(source, /os\.tmpdir\s*\(/, `${name} must not use the system temp directory`);
    assert.doesNotMatch(source, /fs\.(?:rm|rmSync|unlink|unlinkSync)\s*\(/, `${name} must not delete files`);
  }
  for (const [name, source] of [["package", packager], ["smoke", smoke]]) {
    assert.match(source, /createPreservationSession/, `${name} must use the preservation session`);
    assert.match(source, /preservePath/, `${name} must preserve completed or failed scratch state`);
  }

  assert.match(packager, /replaceDirectory/, "artifact publication must preserve the prior directory");
  assert.doesNotMatch(packager, /process\.exit\s*\(/, "builder failures must unwind through preservation");
  const unregisterIndex = smoke.indexOf('["-u", macAppBundle]');
  const preserveIndex = smoke.indexOf('preservation.preservePath(scratch, "smoke-evidence")');
  assert.ok(unregisterIndex >= 0 && preserveIndex > unregisterIndex,
    "macOS smoke must unregister its staged app before preserving the evidence directory");
});

test("preservation sessions keep work and Trash inside repository aiTemp", () => {
  const { createPreservationSession } = loadHelper();
  const fixtureRepository = uniqueFixtureRoot("paths");
  fs.mkdirSync(fixtureRepository, { recursive: true });
  const session = createPreservationSession({
    repositoryRoot: fixtureRepository,
    label: "package-win",
    now: () => new Date("2026-09-14T15:30:00.000Z"),
    nonce: () => "fixture",
  });

  const work = session.createWorkDirectory("builder");
  assert.equal(
    path.relative(path.join(fixtureRepository, "aiTemp"), work).startsWith(".."),
    false,
    work,
  );

  const evidence = path.join(work, "builder.log");
  fs.writeFileSync(evidence, "preserve me\n");
  const preserved = session.preservePath(work, "builder-output");
  assert.equal(fs.existsSync(work), false);
  assert.equal(fs.readFileSync(path.join(preserved, "builder.log"), "utf8"), "preserve me\n");
  assert.equal(
    path.relative(path.join(fixtureRepository, "aiTemp", "Trash"), preserved).startsWith(".."),
    false,
    preserved,
  );
});

test("directory replacement preserves the prior artifacts and installs the prepared directory", () => {
  const { createPreservationSession } = loadHelper();
  const fixtureRepository = uniqueFixtureRoot("replace");
  const target = path.join(fixtureRepository, "desktop-electron", "artifacts");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "old.exe"), "old artifact\n");

  const session = createPreservationSession({
    repositoryRoot: fixtureRepository,
    label: "package-win",
    now: () => new Date("2026-09-14T15:31:00.000Z"),
    nonce: () => "fixture",
  });
  const prepared = session.createWorkDirectory("publication");
  fs.writeFileSync(path.join(prepared, "new.exe"), "new artifact\n");

  const result = session.replaceDirectory(prepared, target, { category: "prior-artifacts" });
  assert.equal(fs.readFileSync(path.join(target, "new.exe"), "utf8"), "new artifact\n");
  assert.equal(fs.existsSync(path.join(target, "old.exe")), false);
  assert.equal(fs.readFileSync(path.join(result.preservedPath, "old.exe"), "utf8"), "old artifact\n");
  assert.equal(
    path.relative(path.join(fixtureRepository, "aiTemp", "Trash"), result.preservedPath).startsWith(".."),
    false,
  );
});

test("failed directory replacement restores the prior artifacts and fails closed", () => {
  const { createPreservationSession } = loadHelper();
  const fixtureRepository = uniqueFixtureRoot("restore");
  const target = path.join(fixtureRepository, "desktop-electron", "artifacts");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "old.exe"), "old artifact\n");

  const realFs = fs;
  const failingFs = Object.create(realFs);
  const session = createPreservationSession({
    repositoryRoot: fixtureRepository,
    label: "package-win",
    now: () => new Date("2026-09-14T15:32:00.000Z"),
    nonce: () => "fixture",
    fsImpl: failingFs,
  });
  const prepared = session.createWorkDirectory("publication");
  fs.writeFileSync(path.join(prepared, "new.exe"), "new artifact\n");

  const originalRename = realFs.renameSync;
  failingFs.renameSync = (source, destination) => {
    if (path.resolve(source) === path.resolve(prepared)
        && path.resolve(destination) === path.resolve(target)) {
      throw new Error("simulated publication failure");
    }
    return originalRename(source, destination);
  };

  assert.throws(
    () => session.replaceDirectory(prepared, target, { category: "prior-artifacts" }),
    /PRESERVATION_REPLACE_FAILED/,
  );
  assert.equal(fs.readFileSync(path.join(target, "old.exe"), "utf8"), "old artifact\n");
  assert.equal(fs.existsSync(prepared), true, "prepared evidence must remain for diagnosis");
});

test("preservePath retries bounded Windows file locks without deleting the source", () => {
  const { PRESERVE_RENAME_RETRY_DELAYS_MS, createPreservationSession } = loadHelper();
  const fixtureRepository = uniqueFixtureRoot("eperm");
  fs.mkdirSync(fixtureRepository, { recursive: true });

  const realFs = fs;
  const lockedFs = Object.create(realFs);
  let attempts = 0;
  const waits = [];
  lockedFs.renameSync = (source, destination) => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("temporarily locked");
      error.code = attempts === 1 ? "EPERM" : "EBUSY";
      throw error;
    }
    return realFs.renameSync(source, destination);
  };

  const session = createPreservationSession({
    repositoryRoot: fixtureRepository,
    label: "package-win",
    now: () => new Date("2026-09-14T15:33:00.000Z"),
    nonce: () => "fixture",
    fsImpl: lockedFs,
    platform: "win32",
    wait: (milliseconds) => waits.push(milliseconds),
  });
  const work = session.createWorkDirectory("smoke");
  fs.writeFileSync(path.join(work, "ready.json"), "{\"ok\":true}\n");
  const preserved = session.preservePath(work, "smoke-evidence");

  assert.equal(attempts, 3);
  assert.deepEqual(waits, PRESERVE_RENAME_RETRY_DELAYS_MS.slice(0, 2));
  assert.equal(fs.existsSync(work), false);
  assert.equal(fs.readFileSync(path.join(preserved, "ready.json"), "utf8"), "{\"ok\":true}\n");
});
