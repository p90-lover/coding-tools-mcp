// Patches a portable Coding Tools folder from a local build, without an installer: only the
// files that differ are swapped in, by the same worker the in-app updater uses (each replaced
// file is renamed aside first, any failure rolls everything back, then the app starts again).
// Coding Tools.exe and Electron's other files are left alone unless --framework is given.
//
//   node scripts/patch-portable.cjs --target "G:\Apps\Coding Tools" --build
//   node scripts/patch-portable.cjs --target "G:\Apps\Coding Tools" --from <win-unpacked>
//
// --build packages only the unpacked app (electron-builder --dir: no installer, no zip) from
// this checkout; it refreshes the versioned runtime and package resources, and needs the AO
// and other native components from one full `bun run package:win` first. If the app is running
// from the target, the patch applies once it closes.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { hashFile, isFrameworkFile, STAGE_DIRECTORY, INSTALLED_MANIFEST } = require("../electron/app-update.cjs");
const { listFiles } = require("./package-app-update.cjs");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");

const root = path.resolve(__dirname, "..");
const HASH_CACHE = "hash-cache.json";

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

/** Builds the unpacked Windows app from this checkout and returns its folder. */
function buildUnpacked() {
  const output = path.join(root, "..", "aiTemp", "work", "patch-portable", `build-${Date.now()}`);
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" && command === "bun" });
    if (result.error || result.status !== 0) throw result.error || new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  };
  run("bun", ["run", "build"]);
  run("bun", ["run", "build:runtime"]);
  run("bun", ["run", "build:package-resources"]);
  const cli = require.resolve("electron-builder/out/cli/cli.js", { paths: [root] });
  run(process.execPath, [cli, "--win", "--dir", "--publish", "never", `--config.directories.output=${output}`]);
  return path.join(output, "win-unpacked");
}

/** A target file's hash, reused while its size and modification time are unchanged. */
async function cachedHash(cache, full, rel) {
  const stat = fs.statSync(full);
  const known = cache[rel];
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.sha256;
  const sha256 = await hashFile(full);
  cache[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256 };
  return sha256;
}

/**
 * Whether a Coding Tools.exe command line is the app's main process. Chromium's children carry
 * --type=; the bridge also runs the exe as Node for its browser helper ("Coding Tools.exe
 * ...\browser-helper.cjs"), which outlives the app, so waiting on it never applied the patch.
 */
function isAppMainProcess(commandLine) {
  const line = String(commandLine || "");
  return !/--type=/.test(line) && !/\.[cm]?js\b/i.test(line);
}

/** The PID of Coding Tools' main process when it runs from the target folder. */
function runningAppPid(executable) {
  if (process.platform !== "win32") return null;
  const query = `Get-CimInstance Win32_Process -Filter "Name='Coding Tools.exe'" | Where-Object { $_.ExecutablePath -eq '${executable.replace(/'/g, "''")}' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", query], { encoding: "utf8", windowsHide: true });
  let processes = [];
  try { processes = [JSON.parse(String(result.stdout).trim() || "[]")].flat(); } catch { return null; }
  const main = processes.find((entry) => isAppMainProcess(entry?.CommandLine));
  const pid = Number(main?.ProcessId);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function main() {
  const { values } = parseArgs({ options: {
    target: { type: "string" }, from: { type: "string" }, build: { type: "boolean" },
    framework: { type: "boolean" }, "dry-run": { type: "boolean" },
  } });
  if (!values.target || (!values.from && !values.build)) {
    throw new Error("Usage: patch-portable.cjs --target PORTABLE_FOLDER (--build | --from WIN_UNPACKED) [--framework] [--dry-run]");
  }
  const target = path.resolve(values.target);
  const executable = path.join(target, "Coding Tools.exe");
  if (!fs.existsSync(executable) || !fs.existsSync(path.join(target, "resources", "app.asar"))) {
    throw new Error(`${target} is not a Coding Tools app folder`);
  }
  const from = values.build ? buildUnpacked() : path.resolve(values.from);
  if (!fs.existsSync(path.join(from, "resources", "app.asar"))) throw new Error(`${from} is not an unpacked build`);

  const asar = require(require.resolve("@electron/asar", { paths: [root] }));
  const version = JSON.parse(asar.extractFile(path.join(from, "resources", "app.asar"), "package.json")).version;
  if (typeof version !== "string" || !version) throw new Error("The source launcher archive has no package version");
  validateRuntimeBundle(path.join(from, "resources", "runtime"), { version, platform: "win32", arch: "x64" });

  const updateRoot = path.join(target, STAGE_DIRECTORY);
  fs.mkdirSync(updateRoot, { recursive: true });
  const cachePath = path.join(updateRoot, HASH_CACHE);
  const cache = readJson(cachePath) || {};
  const files = listFiles(from);
  const listed = new Set(files.map((rel) => rel.toLowerCase()));
  const changed = [];
  for (const rel of files) {
    const source = path.join(from, ...rel.split("/"));
    const destination = path.join(target, ...rel.split("/"));
    const present = fs.statSync(destination, { throwIfNoEntry: false });
    if (present && isFrameworkFile(rel) && !values.framework) continue;
    if (present?.isFile() && present.size === fs.statSync(source).size
      && await cachedHash(cache, destination, rel) === await hashFile(source)) continue;
    changed.push(rel);
  }
  const previous = readJson(path.join(updateRoot, INSTALLED_MANIFEST));
  const obsolete = (Array.isArray(previous?.files) ? previous.files : [])
    .map((file) => file?.path)
    .filter((rel) => typeof rel === "string" && !listed.has(rel.toLowerCase()) && !isFrameworkFile(rel)
      && fs.existsSync(path.join(target, ...rel.split("/"))));
  fs.writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);
  console.log(`patch ${version}: ${changed.length} file(s) changed, ${obsolete.length} removed`);
  for (const rel of changed.slice(0, 20)) console.log(`  ${rel}`);
  if (changed.length > 20) console.log(`  ... and ${changed.length - 20} more`);
  if (values["dry-run"] || (!changed.length && !obsolete.length)) return;

  const stageRoot = fs.mkdtempSync(path.join(updateRoot, "stage-"));
  const filesRoot = path.join(stageRoot, "files");
  for (const rel of changed) {
    const staged = path.join(filesRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.copyFileSync(path.join(from, ...rel.split("/")), staged);
  }
  const workerPath = path.join(stageRoot, "app-update-worker.cjs");
  fs.copyFileSync(path.join(root, "electron", "app-update-worker.cjs"), workerPath);
  const appPid = runningAppPid(executable);
  const job = {
    version, parentPid: appPid ?? process.pid, installRoot: target, stageRoot, filesRoot, executable,
    changed, obsolete,
    installedManifest: { version, files: files.map((rel) => ({ path: rel, size: fs.statSync(path.join(from, ...rel.split("/"))).size })) },
    logPath: path.join(updateRoot, "patch-worker.log"),
  };
  const jobPath = path.join(stageRoot, "job.json");
  fs.writeFileSync(jobPath, `${JSON.stringify(job)}\n`);
  const child = spawn(process.execPath, [workerPath, jobPath], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  console.log(appPid
    ? `Coding Tools is running (PID ${appPid}): the patch applies when you close it, then it starts again.`
    : "Applying now; Coding Tools starts when the patch is in.");
  console.log(`Log: ${job.logPath}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}

module.exports = { isAppMainProcess };
