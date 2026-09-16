const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");
const { runPackagedLauncherProcess } = require("./launcher-process-smoke.cjs");
const { artifactNameFor, macBundlePaths } = require("./smoke-artifact-contract.cjs");
const { createPreservationSession } = require("./preservation.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const artifactsDirectory = path.join(launcherRoot, "artifacts");
const launcherManifest = JSON.parse(
  fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"),
);
const expectedVersion = launcherManifest.version;
const preservation = createPreservationSession({
  repositoryRoot,
  label: `electron-package-smoke-${process.platform}`,
});
const scratch = preservation.createWorkDirectory("smoke");
const markerPath = path.join(scratch, "ready.json");
const coreHome = path.join(scratch, "core-home");
const launcherDataDir = path.join(scratch, "launcher-data");
const codexHome = path.join(scratch, "codex-home");
let macAppBundle;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || scratch,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout || 45_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`,
    );
  }
}

function windowsInstallLocation() {
  const guid = launcherManifest.build.nsis.guid;
  const registryKey = `HKCU\\Software\\${guid}`;
  const result = spawnSync("reg.exe", ["query", registryKey, "/v", "InstallLocation"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Windows installer did not register ${registryKey}: ${result.stderr?.trim() || "no output"}`);
  }
  const match = result.stdout.match(/^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/mi);
  if (!match || !path.win32.isAbsolute(match[1])) {
    throw new Error(`Windows installer registered an invalid InstallLocation: ${result.stdout.trim()}`);
  }
  return match[1];
}

function configuredArtifact(osName, extension, label) {
  const name = artifactNameFor({
    template: launcherManifest.build.artifactName,
    version: expectedVersion,
    os: osName,
    arch: process.arch,
    extension,
  });
  const matches = fs.readdirSync(artifactsDirectory).filter((entry) => entry === name);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in ${artifactsDirectory}; found ${matches.join(", ") || "none"}; expected ${name}`);
  }
  return path.join(artifactsDirectory, name);
}

function smokeEnvironment() {
  return {
    ...process.env,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    CODING_TOOLS_LAUNCHER_DATA_DIR: launcherDataDir,
    CODING_TOOLS_HOME: coreHome,
    CODEX_HOME: codexHome,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: launcherDataDir,
    CODEX_CHATGPT_WEB_HOME: coreHome,
    CODEX_WEB_GPT_SMOKE_FILE: markerPath,
  };
}

async function runSmoke() {
  let executable;
  let command;
  let args;
  const env = smokeEnvironment();

  if (process.platform === "darwin") {
    const archive = configuredArtifact("mac", "zip", "macOS launcher archive");
    const stage = path.join(scratch, "stage");
    fs.mkdirSync(stage);
    run("ditto", ["-x", "-k", archive, stage]);
    const bundle = macBundlePaths({ stage, productName: launcherManifest.build.productName });
    macAppBundle = bundle.appBundle;
    executable = bundle.executable;
    command = executable;
    args = ["--launcher-smoke-test"];
  } else if (process.platform === "linux") {
    executable = configuredArtifact("linux", "AppImage", "Linux AppImage");
    fs.chmodSync(executable, 0o755);
    run(path.join(launcherRoot, "scripts", "smoke-linux-appimage-symbols.sh"), [executable], {
      timeout: 120_000,
    });
    command = "xvfb-run";
    args = ["-a", executable, "--launcher-smoke-test"];
    env.APPIMAGE_EXTRACT_AND_RUN = "1";
  } else if (process.platform === "win32") {
    const installer = configuredArtifact("win", "exe", "Windows installer");
    run(installer, ["/S", "/currentuser"], { timeout: 120_000 });
    executable = path.join(windowsInstallLocation(), `${launcherManifest.build.productName}.exe`);
    command = executable;
    args = ["--launcher-smoke-test"];
  } else {
    throw new Error(`Unsupported package smoke platform: ${process.platform}`);
  }

  if (!fs.existsSync(executable)) throw new Error(`Packaged launcher executable is missing: ${executable}`);
  const launched = await runPackagedLauncherProcess({
    command,
    args,
    cwd: scratch,
    env,
    markerPath,
    fatalLogPath: path.join(launcherDataDir, "logs", "launcher-fatal.log"),
    timeoutMs: 120_000,
    exitGraceMs: 5_000,
    pollIntervalMs: 100,
  });
  if (launched.forcedTermination) {
    process.stdout.write(`PACKAGED_LAUNCHER_SMOKE_REAPED_AFTER_MARKER ${process.platform}/${process.arch}\n`);
  }
  const marker = launched.marker;
  if (marker.ok !== true
    || marker.packaged !== true
    || marker.runtimeVerified !== true
    || marker.version !== expectedVersion
    || marker.platform !== process.platform) {
    throw new Error(`Unexpected packaged launcher marker: ${JSON.stringify(marker)}`);
  }
  const installedRuntime = path.join(
    coreHome,
    "versions",
    `${expectedVersion}-${process.platform}-${process.arch}`,
  );
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedRuntime, "manifest.json"), "utf8"),
  );
  validateRuntimeBundle(installedRuntime, {
    version: expectedVersion,
    platform: process.platform,
    arch: process.arch,
  });
  if (installedManifest.schemaVersion !== 2
    || installedManifest.appVersion !== expectedVersion
    || installedManifest.platform !== process.platform
    || installedManifest.arch !== process.arch
    || !Array.isArray(installedManifest.files)
    || installedManifest.files.length === 0
    || !/^[a-f0-9]{64}$/.test(installedManifest.bundleId)) {
    throw new Error(`Packaged launcher installed the wrong durable runtime: ${JSON.stringify(installedManifest)}`);
  }
}

async function main() {
  let smokeError = null;
  try {
    await runSmoke();
  } catch (error) {
    smokeError = error;
  }

  const finalizationErrors = [];
  if (macAppBundle) {
    try {
      const launchServices =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
      run(launchServices, ["-u", macAppBundle]);
      run(launchServices, ["-gc"]);
    } catch (error) {
      finalizationErrors.push(error);
    }
  }
  try {
    if (fs.existsSync(scratch)) preservation.preservePath(scratch, "smoke-evidence");
  } catch (error) {
    finalizationErrors.push(error);
  }

  if (smokeError && finalizationErrors.length > 0) {
    throw new AggregateError(
      [smokeError, ...finalizationErrors],
      "Packaged launcher smoke failed and evidence finalization also failed",
    );
  }
  if (smokeError) throw smokeError;
  if (finalizationErrors.length > 0) {
    throw new AggregateError(finalizationErrors, "Packaged launcher smoke evidence could not be preserved");
  }
  process.stdout.write(`PACKAGED_LAUNCHER_SMOKE_OK ${process.platform}/${process.arch}\n`);
}

void main().catch((error) => {
  process.nextTick(() => { throw error; });
});
