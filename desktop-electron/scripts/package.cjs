const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");
const { createPreservationSession } = require("./preservation.cjs");

const root = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(root, "..");
const launcherManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const executable = "node";
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js", { paths: [root] });
const requested = process.argv[2];
const target = requested || (process.platform === "darwin" ? "--mac"
  : process.platform === "win32" ? "--win"
    : process.platform === "linux" ? "--linux"
      : null);
if (!["--mac", "--win", "--linux"].includes(target)) {
  throw new Error(`Unsupported packaging target: ${requested || process.platform}`);
}
const nativeTarget = process.platform === "darwin" ? "--mac"
  : process.platform === "win32" ? "--win"
    : process.platform === "linux" ? "--linux"
      : null;
if (target !== nativeTarget) {
  throw new Error(
    `Cross-packaging ${target} from ${process.platform}/${process.arch} is disabled because the launcher embeds a native Bun runtime. `
    + "Build each target on its matching operating system.",
  );
}

const env = { ...process.env };
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const builderArgs = [
  electronBuilderCli,
  target,
  "--publish",
  "never",
];
if (target === "--mac" && !env.CSC_LINK && !env.CSC_NAME) {
  builderArgs.push("--config.mac.identity=-");
}

const preservation = createPreservationSession({
  repositoryRoot,
  label: `electron-package-${target.slice(2)}`,
});
const staging = preservation.createWorkDirectory("builder-output");
const publication = preservation.createWorkDirectory("publication");
const artifactsDirectory = path.join(root, "artifacts");
const distributablePattern = /\.(?:AppImage|dmg|exe|zip|blockmap)$/i;

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? "unknown"}`);
  }
}

function preserveAfterOperation(sourcePath, category, operation) {
  let operationError = null;
  try {
    operation();
  } catch (error) {
    operationError = error;
  }
  let preservationError = null;
  try {
    if (fs.existsSync(sourcePath)) preservation.preservePath(sourcePath, category);
  } catch (error) {
    preservationError = error;
  }
  if (operationError && preservationError) {
    throw new AggregateError(
      [operationError, preservationError],
      `${category} operation and preservation both failed`,
    );
  }
  if (operationError) throw operationError;
  if (preservationError) throw preservationError;
}

function verifySignedMacArchive() {
  const archives = fs.readdirSync(staging)
    .filter(name => /-mac-(?:arm64|x64)\.zip$/.test(name));
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one macOS ZIP for verification; found ${archives.join(", ") || "none"}`);
  }
  const verificationRoot = preservation.createWorkDirectory("mac-verification");
  preserveAfterOperation(verificationRoot, "mac-verification", () => {
    runChecked("ditto", ["-x", "-k", path.join(staging, archives[0]), verificationRoot]);
    const appBundle = path.join(verificationRoot, `${launcherManifest.build.productName}.app`);
    runChecked("codesign", ["--verify", "--deep", "--strict", appBundle]);
    validateRuntimeBundle(path.join(appBundle, "Contents", "Resources", "runtime"), {
      version: launcherManifest.version,
      platform: "darwin",
      arch: process.arch,
    });
  });
}

function copyRetainedArtifactEntries() {
  if (!fs.existsSync(artifactsDirectory)) return;
  for (const entry of fs.readdirSync(artifactsDirectory, { withFileTypes: true })) {
    if (entry.isFile() && distributablePattern.test(entry.name)) continue;
    fs.cpSync(
      path.join(artifactsDirectory, entry.name),
      path.join(publication, entry.name),
      {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      },
    );
  }
}

function preparePublication() {
  copyRetainedArtifactEntries();
  const artifacts = fs.readdirSync(staging, { withFileTypes: true })
    .filter((entry) => entry.isFile() && distributablePattern.test(entry.name));
  if (!artifacts.some((entry) => /\.(?:AppImage|dmg|exe|zip)$/i.test(entry.name))) {
    throw new Error(`electron-builder produced no distributable artifact in ${staging}`);
  }
  for (const artifact of artifacts) {
    const publicName = artifact.name.replace(/-linux-x86_64(?=\.)/, "-linux-x64");
    fs.copyFileSync(
      path.join(staging, artifact.name),
      path.join(publication, publicName),
      fs.constants.COPYFILE_EXCL,
    );
  }
}

let packagingError = null;
try {
  runChecked(executable, [
    ...builderArgs,
    `--config.directories.output=${staging}`,
  ]);
  if (target === "--mac") verifySignedMacArchive();
  preparePublication();
  preservation.replaceDirectory(publication, artifactsDirectory, {
    category: "prior-artifacts",
  });
} catch (error) {
  packagingError = error;
}

const preservationErrors = [];
for (const [sourcePath, category] of [
  [publication, "unpublished-artifacts"],
  [staging, "builder-output"],
]) {
  try {
    if (fs.existsSync(sourcePath)) preservation.preservePath(sourcePath, category);
  } catch (error) {
    preservationErrors.push(error);
  }
}

if (packagingError && preservationErrors.length > 0) {
  throw new AggregateError(
    [packagingError, ...preservationErrors],
    "Packaging failed and one or more diagnostic directories could not be preserved",
  );
}
if (packagingError) throw packagingError;
if (preservationErrors.length > 0) {
  throw new AggregateError(preservationErrors, "Packaging completed but diagnostic preservation failed");
}
