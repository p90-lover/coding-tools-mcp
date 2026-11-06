"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const VENDOR_ROOT = path.join(REPOSITORY_ROOT, "desktop-electron", "vendor", "register");
const PACKAGES = ["api", "application", "core", "domain", "infrastructure", "platforms", "providers", "services"];

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

function verifyRegisterSource(vendorRoot = VENDOR_ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendorRoot, "SOURCE_MANIFEST.json"), "utf8"));
  const seen = new Set();
  for (const item of manifest.files) {
    if (typeof item.path !== "string" || item.path.includes("\\") || item.path.split("/").some(part => !part || part === "." || part === "..") || seen.has(item.path)) throw new Error("REGISTER_SOURCE_MANIFEST_INVALID");
    seen.add(item.path);
    if (item.path.split("/").some(part => /^(?:\.git|\.env.*|\.venv|node_modules|reg-factory|aiTemp|Trash|data|exports|runtime|profiles|__pycache__)$/i.test(part)) || /\.(?:db|sqlite|sqlite3|pyc|log)$/i.test(item.path)) throw new Error("REGISTER_SOURCE_PRIVATE_FILE");
    const file = path.join(vendorRoot, "app", item.path);
    if (fs.lstatSync(file).isSymbolicLink() || sha256(file) !== item.sha256) throw new Error(`REGISTER_SOURCE_HASH_MISMATCH: ${item.path}`);
  }
  function checkDirectory(directory, prefix = "") {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error("REGISTER_SOURCE_SYMLINK");
      if (item.isDirectory()) checkDirectory(path.join(directory, item.name), name + "/");
      else if (!seen.has(name)) throw new Error(`REGISTER_SOURCE_UNMANIFESTED: ${name}`);
    }
  }
  checkDirectory(path.join(vendorRoot, "app"));
  for (const [name, expected] of Object.entries(manifest.buildInputs || {})) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || sha256(path.join(vendorRoot, name)) !== expected) throw new Error(`REGISTER_BUILD_INPUT_HASH_MISMATCH: ${name}`);
  }
  return manifest;
}

function runtimeFiles(runtimeRoot, hashes = true) {
  const files = [];
  function walk(directory, prefix = "") {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (name === "RUNTIME.json") continue;
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        if (!fs.realpathSync(file).startsWith(fs.realpathSync(runtimeRoot) + path.sep)) throw new Error("REGISTER_RUNTIME_LINK_ESCAPE");
        files.push({ path: name, link: fs.readlinkSync(file) });
      } else if (item.isDirectory()) walk(file, name + "/");
      else if (item.isFile()) files.push(hashes ? { path: name, sha256: sha256(file) } : { path: name });
      else throw new Error("REGISTER_RUNTIME_SPECIAL_FILE");
    }
  }
  walk(runtimeRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function validateRegisterRuntime(runtimeRoot, options = {}) {
  const root = path.resolve(runtimeRoot);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "RUNTIME.json"), "utf8"));
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (receipt.schemaVersion !== 1 || receipt.platform !== platform || receipt.arch !== arch || !Array.isArray(receipt.files) || !Array.isArray(receipt.requiredFiles)) throw new Error("REGISTER_RUNTIME_MANIFEST_INVALID");
  if (options.sourceManifestSha256 && receipt.sourceManifestSha256 !== options.sourceManifestSha256) throw new Error("REGISTER_RUNTIME_SOURCE_STALE");
  if (options.preparerSha256 && receipt.preparerSha256 !== options.preparerSha256) throw new Error("REGISTER_RUNTIME_PREPARER_STALE");
  const names = new Set();
  for (const item of receipt.files) {
    if (typeof item.path !== "string" || item.path.includes("\\") || item.path.split("/").some(part => !part || part === "." || part === "..") || names.has(item.path)) throw new Error("REGISTER_RUNTIME_PATH_INVALID");
    names.add(item.path);
    const file = path.join(root, item.path);
    const metadata = fs.lstatSync(file);
    if (typeof item.link === "string") {
      if (!metadata.isSymbolicLink() || fs.readlinkSync(file) !== item.link || !fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error("REGISTER_RUNTIME_LINK_INVALID");
    } else if (!/^[a-f0-9]{64}$/.test(item.sha256) || !metadata.isFile() || metadata.isSymbolicLink() || sha256(file) !== item.sha256) throw new Error(`REGISTER_RUNTIME_HASH_MISMATCH: ${item.path}`);
  }
  const actualNames = runtimeFiles(root, false).map(item => item.path);
  if (actualNames.length !== names.size || actualNames.some(name => !names.has(name))) throw new Error("REGISTER_RUNTIME_INVENTORY_MISMATCH");
  const binary = platform === "win32" ? "register-service.exe" : "register-service";
  const camoufox = platform === "win32" ? "browsers/camoufox/camoufox.exe" : platform === "darwin" ? "browsers/camoufox/Camoufox.app/Contents/MacOS/camoufox" : "browsers/camoufox/camoufox-bin";
  for (const required of [binary, "_internal/static/index.html", camoufox, "LICENSE.register", "source/register/LICENSE", "source/register/SOURCE_MANIFEST.json", "source/register/app/main.py", ...receipt.requiredFiles]) {
    if (typeof required !== "string" || !names.has(required)) throw new Error(`REGISTER_RUNTIME_REQUIRED_FILE_MISSING: ${required}`);
  }
  if (!actualNames.some(name => /^_internal\/(?:.*\/)?(?:python\d+\.dll|libpython[^/]+|Python)$/i.test(name)) || !actualNames.some(name => /^_internal\/static\/assets\/.+\.js$/.test(name)) || !actualNames.some(name => name.startsWith("browsers/playwright/chromium-") && /(?:chrome\.exe|chrome|Google Chrome for Testing)$/.test(name))) throw new Error("REGISTER_RUNTIME_DEPENDENCY_MISSING");
  if (sha256(path.join(root, binary)) !== receipt.binarySha256 || sha256(path.join(root, "source/register/SOURCE_MANIFEST.json")) !== receipt.sourceManifestSha256) throw new Error("REGISTER_RUNTIME_IDENTITY_MISMATCH");
  verifyRegisterSource(path.join(root, "source/register"));
  return { root, platform, arch, fileCount: names.size, binarySha256: receipt.binarySha256, sourceManifestSha256: receipt.sourceManifestSha256 };
}

function writeRuntimeManifest(runtimeRoot, receipt) {
  const files = runtimeFiles(runtimeRoot);
  const requiredFiles = files.filter(item => /^(?:_internal\/(?:.*\/)?(?:python\d+\.dll|libpython[^/]+|Python)|_internal\/static\/|browsers\/camoufox\/(?:camoufox(?:\.exe|-bin)|Camoufox.app\/Contents\/MacOS\/camoufox)$|browsers\/playwright\/.*(?:chrome\.exe|chrome|chrome-headless-shell\.exe|headless_shell|Google Chrome for Testing))/.test(item.path)).map(item => item.path);
  const complete = { ...receipt, chromium: { playwright: "1.62.0", patchright: "1.63.0" }, requiredFiles, files };
  fs.writeFileSync(path.join(runtimeRoot, "RUNTIME.json"), JSON.stringify(complete, null, 2) + "\n");
  validateRegisterRuntime(runtimeRoot, { platform: receipt.platform, arch: receipt.arch });
  return complete;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`REGISTER_BUILD_COMMAND_FAILED: ${command} (${result.status ?? result.error?.code})`);
}

function reuseBrowserTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) reuseBrowserTree(from, to);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else {
      try { fs.linkSync(from, to); }
      catch (error) {
        if (!["EXDEV", "EPERM", "ENOTSUP"].includes(error.code)) throw error;
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      }
    }
  }
}

async function downloadBrowser(asset, file, url) {
  if (!fs.existsSync(file)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`REGISTER_BROWSER_DOWNLOAD_FAILED: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file, { flags: "wx" }));
  }
  if (sha256(file) !== asset.sha256) throw new Error("REGISTER_BROWSER_HASH_MISMATCH");
}

async function prepareRegisterRuntime(options = {}) {
  const root = path.resolve(options.repositoryRoot || REPOSITORY_ROOT);
  const vendor = path.join(root, "desktop-electron", "vendor", "register");
  const manifest = verifyRegisterSource(vendor);
  const sourceManifestSha256 = sha256(path.join(vendor, "SOURCE_MANIFEST.json"));
  const preparerSha256 = sha256(__filename);
  const browsers = JSON.parse(fs.readFileSync(path.join(vendor, "BROWSERS.json"), "utf8"));
  const browser = browsers.camoufox.assets[`${process.platform}-${process.arch}`];
  if (!browser) throw new Error("REGISTER_BROWSER_PLATFORM_UNSUPPORTED");
  const output = path.join(root, "aiTemp", "register-runtime");
  let previousReceipt;
  if (fs.existsSync(path.join(output, "RUNTIME.json"))) {
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(output, "RUNTIME.json"), "utf8"));
      if (existing.sourceManifestSha256 === sourceManifestSha256 && existing.preparerSha256 === preparerSha256) {
        validateRegisterRuntime(output, { sourceManifestSha256, preparerSha256 });
        return { output, receipt: existing, cached: true };
      }
      validateRegisterRuntime(output);
      previousReceipt = existing;
    } catch { /* A stale or incomplete generated bundle is rebuilt and retained in Trash. */ }
  }
  const work = path.join(root, "aiTemp", "register-cpa-20261023", "runtime-build");
  const runRoot = path.join(work, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  const stage = path.join(runRoot, "app");
  fs.mkdirSync(runRoot, { recursive: true });
  fs.cpSync(path.join(vendor, "app"), stage, { recursive: true, errorOnExist: true, force: false });
  const environment = { ...process.env, TEMP: runRoot, TMP: runRoot, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" };
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // npm.cmd needs cmd.exe on Windows; arguments are fixed and the cwd is supplied separately.
  if (process.platform === "win32") {
    run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd ci --ignore-scripts --no-audit --no-fund"], { cwd: path.join(stage, "frontend"), env: { ...environment, npm_config_cache: path.join(work, "npm-cache") } });
    run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd run build"], { cwd: path.join(stage, "frontend"), env: environment });
  } else {
    run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: path.join(stage, "frontend"), env: { ...environment, npm_config_cache: path.join(work, "npm-cache") } });
    run(npm, ["run", "build"], { cwd: path.join(stage, "frontend"), env: environment });
  }
  const bootstrapPython = process.env.REGISTER_BUILD_PYTHON || (process.platform === "win32" ? "python.exe" : "python3");
  let python = bootstrapPython;
  if (process.env.REGISTER_BUILD_REUSE_PYTHON !== "1") {
    const virtualenv = path.join(work, "venv");
    python = path.join(virtualenv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (!fs.existsSync(python)) run(bootstrapPython, ["-m", "venv", virtualenv], { env: environment });
    run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--requirement", path.join(vendor, "requirements-build.lock.txt")], { env: environment });
  }
  run(python, ["-c", "import importlib.metadata as m; assert m.version('pyinstaller') == '6.22.3'; assert m.version('camoufox') == '0.5.6'; assert m.version('playwright') == '1.62.0'; assert m.version('patchright') == '1.63.0'"], { env: environment });
  const args = ["-m", "PyInstaller", "--noconfirm", "--onedir", "--name", "register-service", "--distpath", path.join(runRoot, "frozen"), "--workpath", path.join(runRoot, "pyinstaller"), "--specpath", runRoot, "--paths", stage, "--add-data", `${path.join(stage, "static")}${path.delimiter}static`, "--hidden-import", "main"];
  for (const name of PACKAGES) args.push("--collect-submodules", name, "--add-data", `${path.join(stage, name)}${path.delimiter}${name}`);
  for (const name of ["uvicorn", "curl_cffi", "playwright", "patchright", "quart", "rich", "browserforge", "apify_fingerprint_datapoints", "camoufox", "language_tags", "hypercorn", "geoip2", "maxminddb"]) args.push("--collect-all", name);
  args.push(path.join(vendor, "entry.py"));
  run(python, args, { cwd: runRoot, env: environment });
  const bundle = path.join(runRoot, "frozen", "register-service");
  const browserRoot = path.join(bundle, "browsers");
  const url = `${browsers.camoufox.repository}/releases/download/${browsers.camoufox.tag}/${browser.name}`;
  const reuse = previousReceipt?.browser?.sha256 === browser.sha256
    && ["playwright", "patchright"].every(name => previousReceipt.chromium?.[name] === browsers.chromium[name]
      && sha256(path.join(output, "_internal", name, "driver/package/browsers.json")) === sha256(path.join(bundle, "_internal", name, "driver/package/browsers.json")));
  if (reuse) reuseBrowserTree(path.join(output, "browsers"), browserRoot);
  else {
    fs.mkdirSync(path.join(work, "downloads"), { recursive: true });
    const archive = path.join(work, "downloads", browser.name);
    await downloadBrowser(browser, archive, url);
    run(python, [path.join(vendor, "extract_browser.py"), archive, path.join(browserRoot, "camoufox")], { env: environment });
    fs.writeFileSync(path.join(browserRoot, "camoufox", "version.json"), JSON.stringify({ version: browsers.camoufox.version, build: browsers.camoufox.build }));
    const browserEnvironment = { ...environment, PLAYWRIGHT_BROWSERS_PATH: path.join(browserRoot, "playwright") };
    for (const name of ["playwright", "patchright"]) run(python, ["-m", name, "install", "chromium"], { env: browserEnvironment });
  }
  // Installer GC links point at the build interpreter; browser launches do not need them.
  for (const name of [".links", "__dirlock"]) {
    const installerState = path.join(browserRoot, "playwright", name);
    if (fs.existsSync(installerState)) fs.renameSync(installerState, path.join(runRoot, `browser-installer-${name}`));
  }
  const source = path.join(bundle, "source", "register");
  verifyRegisterSource(vendor);
  if (sha256(path.join(vendor, "SOURCE_MANIFEST.json")) !== sourceManifestSha256) throw new Error("REGISTER_SOURCE_CHANGED_DURING_BUILD");
  fs.mkdirSync(source, { recursive: true });
  for (const name of ["LICENSE", "README.md", "SOURCE_MANIFEST.json", "requirements-build.lock.txt", "BROWSERS.json", "entry.py", "extract_browser.py"]) fs.copyFileSync(path.join(vendor, name), path.join(source, name));
  fs.cpSync(path.join(vendor, "app"), path.join(source, "app"), { recursive: true });
  fs.copyFileSync(__filename, path.join(source, "prepare-register-runtime.cjs"));
  fs.copyFileSync(path.join(vendor, "LICENSE"), path.join(bundle, "LICENSE.register"));
  const receipt = { schemaVersion: 1, platform: process.platform, arch: process.arch, upstream: manifest.upstream, sourceManifestSha256, preparerSha256, binarySha256: sha256(path.join(bundle, process.platform === "win32" ? "register-service.exe" : "register-service")), browser: { ...browser, url }, builtAt: new Date().toISOString() };
  writeRuntimeManifest(bundle, receipt);
  if (sha256(path.join(vendor, "SOURCE_MANIFEST.json")) !== sourceManifestSha256 || sha256(__filename) !== preparerSha256) throw new Error("REGISTER_SOURCE_CHANGED_DURING_BUILD");
  if (fs.existsSync(output)) {
    const backup = path.join(root, "Trash", "register-runtime", path.basename(runRoot));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(output, backup);
  }
  fs.renameSync(bundle, output);
  return { output, receipt };
}

if (require.main === module) prepareRegisterRuntime().then(result => process.stdout.write(JSON.stringify(result) + "\n"), error => { process.stderr.write((error.message || String(error)) + "\n"); process.exitCode = 1; });

module.exports = { prepareRegisterRuntime, verifyRegisterSource, validateRegisterRuntime, writeRuntimeManifest, sha256 };
