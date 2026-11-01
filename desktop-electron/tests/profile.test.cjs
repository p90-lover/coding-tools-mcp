const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const {
  browserPartitionForLauncherProfile,
  resolveLauncherProfile,
} = require("../electron/profile.cjs");

test("default launcher data resolves an existing junction without moving its history or overriding explicit paths", () => {
  const scratch = path.resolve(__dirname, "../../aiTemp/profile-junction-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "case-"));
  try {
    const appData = path.join(root, "roaming");
    const physical = path.join(root, "physical");
    fs.mkdirSync(appData);
    fs.mkdirSync(physical);
    fs.writeFileSync(path.join(physical, "history.json"), '{"saved":true}');
    const junction = path.join(appData, "Coding Tools");
    fs.symlinkSync(physical, junction, process.platform === "win32" ? "junction" : "dir");
    const options = { argv: ["electron", "."], env: {}, homeDir: path.join(root, "home"), appData };
    const profile = resolveLauncherProfile(options);
    assert.equal(profile.userData, fs.realpathSync(physical));
    assert.equal(fs.readFileSync(path.join(profile.userData, "history.json"), "utf8"), '{"saved":true}');
    assert.equal(fs.lstatSync(junction).isSymbolicLink(), true, "the junction is preserved");
    const explicit = resolveLauncherProfile({ ...options, env: { CODING_TOOLS_LAUNCHER_DATA_DIR: junction } });
    assert.equal(explicit.userData, junction, "an explicit override keeps its path semantics");
    const development = resolveLauncherProfile({ ...options, argv: ["electron", ".", "--dev-profile"] });
    assert.equal(development.userData, path.join(root, "home", ".coding-tools-dev", "launcher"));
    const missingAppData = path.join(root, "new-roaming");
    assert.equal(resolveLauncherProfile({ ...options, appData: missingAppData }).userData,
      path.join(missingAppData, "Coding Tools"), "first launch still accepts an absent default directory");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.readdirSync(scratch).length === 0) fs.rmdirSync(scratch);
  }
});

test("DEV launcher profile isolates every durable home from production", () => {
  const homeDir = path.resolve("/Users/tester");
  const production = resolveLauncherProfile({
    argv: ["electron", "."],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(production.kind, "production");
  assert.equal(development.kind, "development");
  assert.equal(production.displayName, "Coding Tools");
  assert.equal(development.displayName, "Coding Tools DEV");
  assert.notEqual(development.coreHome, production.coreHome);
  assert.notEqual(development.codexHome, production.codexHome);
  assert.notEqual(development.userData, production.userData);
  assert.notEqual(development.browserPartition, production.browserPartition);
  assert.equal(development.userData, path.join(development.coreHome, "launcher"));
  assert.equal(development.codexHome, path.join(development.coreHome, "codex-home"));
});

test("BrowserHost partition identity is derived from the same launcher profile contract", () => {
  const homeDir = path.resolve("/Users/tester");
  const appData = path.join(homeDir, "Library", "Application Support");
  const production = resolveLauncherProfile({
    argv: ["electron", "."],
    env: {},
    homeDir,
    appData,
  });
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {},
    homeDir,
    appData,
  });

  assert.equal(
    production.browserPartition,
    browserPartitionForLauncherProfile(production.kind),
  );
  assert.equal(
    development.browserPartition,
    browserPartitionForLauncherProfile(development.kind),
  );
  assert.throws(
    () => browserPartitionForLauncherProfile("unknown"),
    /Launcher profile is invalid/,
  );
});

test("DEV launcher refuses an explicit home collision with production", () => {
  const homeDir = path.resolve("/Users/tester");
  const shared = path.join(homeDir, "shared");
  assert.throws(() => resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODING_TOOLS_DEV_HOME: shared,
      CODING_TOOLS_HOME: shared,
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  }), /must differ from the production Coding Tools home/);
});

test("DEV launcher ignores generic production and legacy path overrides", () => {
  const homeDir = path.resolve("/Users/tester");
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODING_TOOLS_HOME: path.join(homeDir, "production-core"),
      CODING_TOOLS_LAUNCHER_DATA_DIR: path.join(homeDir, "production-launcher"),
      CODING_TOOLS_DEV_HOME: path.join(homeDir, "isolated-dev"),
      CODEX_CHATGPT_WEB_HOME: path.join(homeDir, "legacy-production-core"),
      CODEX_HOME: path.join(homeDir, "production-codex"),
      CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(homeDir, "legacy-production-launcher"),
      CODEX_WEB_GPT_DEV_HOME: path.join(homeDir, "legacy-dev"),
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(development.coreHome, path.join(homeDir, "isolated-dev"));
  assert.equal(development.codexHome, path.join(homeDir, "isolated-dev", "codex-home"));
  assert.equal(development.userData, path.join(homeDir, "isolated-dev", "launcher"));
});
