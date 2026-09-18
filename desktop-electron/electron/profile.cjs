const os = require("node:os");
const path = require("node:path");

const PRODUCTION_PROFILE = "production";
const DEVELOPMENT_PROFILE = "development";

function browserPartitionForLauncherProfile(profile) {
  if (profile === PRODUCTION_PROFILE) return "persist:coding-tools-chatgpt";
  if (profile === DEVELOPMENT_PROFILE) return "persist:coding-tools-dev-chatgpt";
  throw new Error("Launcher profile is invalid");
}

function resolveUserPath(value, homeDir = os.homedir()) {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(homeDir, value.slice(2));
  }
  return path.resolve(value);
}

function configuredPath(env, key, fallback, homeDir) {
  const value = env[key]?.trim();
  return value ? resolveUserPath(value, homeDir) : fallback;
}

function resolveLauncherProfile({
  argv = process.argv,
  env = process.env,
  homeDir = os.homedir(),
  appData,
} = {}) {
  if (typeof appData !== "string" || !path.isAbsolute(appData)) {
    throw new Error("Launcher profile resolution requires an absolute appData path");
  }
  const development = argv.includes("--dev-profile");
  if (!development) {
    return {
      kind: PRODUCTION_PROFILE,
      displayName: "Coding Tools",
      coreHome: configuredPath(env, "CODING_TOOLS_HOME", path.join(homeDir, ".coding-tools"), homeDir),
      codexHome: configuredPath(env, "CODEX_HOME", path.join(homeDir, ".codex"), homeDir),
      userData: configuredPath(env, "CODING_TOOLS_LAUNCHER_DATA_DIR", path.join(appData, "Coding Tools"), homeDir),
      browserPartition: browserPartitionForLauncherProfile(PRODUCTION_PROFILE),
    };
  }

  const coreHome = configuredPath(
    env,
    "CODING_TOOLS_DEV_HOME",
    path.join(homeDir, ".coding-tools-dev"),
    homeDir,
  );
  const productionHome = configuredPath(
    env,
    "CODING_TOOLS_HOME",
    path.join(homeDir, ".coding-tools"),
    homeDir,
  );
  if (path.resolve(coreHome) === path.resolve(productionHome)) {
    throw new Error("DEV profile home must differ from the production Coding Tools home");
  }
  return {
    kind: DEVELOPMENT_PROFILE,
    displayName: "Coding Tools DEV",
    coreHome,
    codexHome: path.join(coreHome, "codex-home"),
    userData: path.join(coreHome, "launcher"),
    browserPartition: browserPartitionForLauncherProfile(DEVELOPMENT_PROFILE),
  };
}

module.exports = {
  DEVELOPMENT_PROFILE,
  PRODUCTION_PROFILE,
  browserPartitionForLauncherProfile,
  resolveLauncherProfile,
};
