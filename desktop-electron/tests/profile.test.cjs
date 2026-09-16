// Rebuild trigger after browser profile source fix 33acd13694e4f6945870ffb856b93bde202cfa48.
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
