const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  browserPartitionForLauncherProfile,
  resolveLauncherProfile,
} = require("../electron/profile.cjs");

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

test("production userData resolves an existing junction without changing other profile paths", (t) => {
  const scratch = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, "profile-junction-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const appData = path.join(fixture, "logical-appdata");
  const physical = path.join(fixture, "physical-profile");
  const logical = path.join(appData, "Coding Tools");
  fs.mkdirSync(appData);
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, logical, process.platform === "win32" ? "junction" : "dir");
  const env = { CODING_TOOLS_HOME: path.join(logical, "core"), CODEX_HOME: path.join(logical, "codex") };
  for (const overrides of [env, { ...env, CODING_TOOLS_LAUNCHER_DATA_DIR: logical }]) {
    const profile = resolveLauncherProfile({ argv: ["electron"], env: overrides, appData, homeDir: fixture });
    assert.equal(profile.userData, fs.realpathSync(physical));
    assert.equal(profile.coreHome, env.CODING_TOOLS_HOME);
    assert.equal(profile.codexHome, env.CODEX_HOME);
  }
  const missing = path.join(logical, "new-profile");
  assert.equal(resolveLauncherProfile({ argv: ["electron"], env: { CODING_TOOLS_LAUNCHER_DATA_DIR: missing },
    appData, homeDir: fixture }).userData, missing);
  fs.writeFileSync(path.join(physical, "file"), "fixture");
  const file = path.join(logical, "file");
  assert.equal(resolveLauncherProfile({ argv: ["electron"], env: { CODING_TOOLS_LAUNCHER_DATA_DIR: file },
    appData, homeDir: fixture }).userData, file);
  fs.mkdirSync(path.join(physical, "launcher"));
  const development = resolveLauncherProfile({ argv: ["electron", "--dev-profile"], env: { CODING_TOOLS_DEV_HOME: logical },
    appData, homeDir: fixture });
  assert.equal(development.userData, path.join(logical, "launcher"));
});
