const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");

const DEFAULT_SOURCE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_SOURCE_WAIT_INTERVAL_MS = 50;
const SET_ASIDE_FILE = /\.old-\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bundleIdFor(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function validateManifestPath(relativePath) {
  if (typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath === "manifest.json"
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Runtime manifest contains an unsafe file path: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

function readRuntimeManifest(runtimeRoot, { version, platform, arch, bundleId }) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Runtime manifest is invalid: ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedLauncher = `bin/${platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`;
  if (manifest?.schemaVersion !== 2
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch
    || manifest.launcher !== expectedLauncher
    || manifest.entrypoint !== "app/cli.js"
    || typeof manifest.bunVersion !== "string"
    || typeof manifest.playwright !== "string"
    || !SHA256_PATTERN.test(manifest.bundleId)
    || (bundleId && manifest.bundleId !== bundleId)
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0) {
    const received = manifest && typeof manifest === "object" ? {
      schemaVersion: manifest.schemaVersion,
      appVersion: manifest.appVersion,
      bundleId: manifest.bundleId,
      bunVersion: manifest.bunVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      launcher: manifest.launcher,
      entrypoint: manifest.entrypoint,
      playwright: manifest.playwright,
      fileCount: Array.isArray(manifest.files) ? manifest.files.length : null,
    } : manifest;
    throw new Error(
      `Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}, received ${JSON.stringify(received)}`,
    );
  }

  let previousPath = null;
  const files = manifest.files.map((file, index) => {
    if (!file || typeof file !== "object"
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Runtime manifest contains an invalid file record at index ${index}`);
    }
    const relativePath = validateManifestPath(file.path);
    if (previousPath !== null && comparePaths(previousPath, relativePath) >= 0) {
      throw new Error(`Runtime manifest file paths are not unique and sorted: ${relativePath}`);
    }
    previousPath = relativePath;
    return { path: relativePath, size: file.size, sha256: file.sha256 };
  });
  if (bundleIdFor(files) !== manifest.bundleId) {
    throw new Error(`Runtime manifest bundleId does not match its file records: ${manifestPath}`);
  }
  return { ...manifest, files };
}

function runtimeFilePaths(runtimeRoot) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(runtimeRoot, absolutePath).split(path.sep).join("/");
      if (relativePath === "manifest.json") continue;
      // A file an update renamed aside because something still ran it (app-update-worker.cjs) is
      // not part of the bundle; it is deleted once nothing runs it. Counting it failed startup.
      if (!entry.isDirectory() && SET_ASIDE_FILE.test(entry.name)) continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      paths.push(relativePath);
    }
  };
  visit(runtimeRoot);
  return paths.sort(comparePaths);
}

/** A runtime file's stat, checked for presence, kind, symlink escape and size. */
function statRuntimeFile(runtimeRoot, canonicalRoot, file) {
  const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
  // One call per file: a plain file's lstat is its stat; only a symlink is followed.
  let metadata;
  try {
    metadata = fs.lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) {
      const target = fs.realpathSync(absolutePath);
      if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new Error(`Runtime bundle symlink escapes the bundle: ${absolutePath}`);
      }
      metadata = fs.statSync(absolutePath);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Runtime bundle")) throw error;
    throw new Error(`Runtime bundle file is missing: ${absolutePath}`);
  }
  if (!metadata.isFile()) throw new Error(`Runtime bundle entry is not a file: ${absolutePath}`);
  if (metadata.size !== file.size) {
    throw new Error(`Runtime bundle file size mismatch: ${absolutePath}`);
  }
  return metadata;
}

function hashRuntimeFile(runtimeRoot, file) {
  const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
  const sha256 = createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  if (sha256 !== file.sha256) {
    throw new Error(`Runtime bundle file checksum mismatch: ${absolutePath}`);
  }
}

// Every launch checked the runtime by reading and hashing all of its files (6,002 files, 164 MB in
// 0.8.3), twice: the packaged copy and the version directory. On the hard disk holding the app that
// kept the window from opening for over two minutes after a restart, which looked like a crash.
// A bundle whose files were all hashed is remembered by the stat of every file (size, modified and
// changed times); while those stay the same, the files are checked but not read again. Changing a
// file's content changes its changed time (ctime), which even setting its modified time back does.
const MAX_VERIFIED_SIGNATURES = 4;
function verifiedSignatures(stampDir, bundleId) {
  if (!stampDir) return [];
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(stampDir, `${bundleId}.json`), "utf8"));
    return Array.isArray(saved?.signatures) ? saved.signatures.filter(value => SHA256_PATTERN.test(value)) : [];
  } catch {
    return [];
  }
}
function rememberVerified(stampDir, bundleId, signature) {
  if (!stampDir) return;
  try {
    const signatures = [signature, ...verifiedSignatures(stampDir, bundleId).filter(value => value !== signature)]
      .slice(0, MAX_VERIFIED_SIGNATURES);
    fs.mkdirSync(stampDir, { recursive: true, mode: 0o700 });
    const target = path.join(stampDir, `${bundleId}.json`);
    const temporary = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify({ signatures }), { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch {
    // Not remembering only means the next launch hashes the files again.
  }
}

function inspectRuntimeBundle(runtimeRoot, identity, { stampDir = null } = {}) {
  const manifest = readRuntimeManifest(runtimeRoot, identity);
  const expectedPaths = manifest.files.map(file => file.path);
  const expectedSet = new Set(expectedPaths);
  const paths = runtimeBundlePaths(runtimeRoot, identity.platform);
  for (const required of [
    paths.executable,
    paths.entrypoint,
    path.join(runtimeRoot, "app", "browser-helper.cjs"),
    path.join(runtimeRoot, ...manifest.launcher.split("/")),
  ]) {
    const relativePath = path.relative(runtimeRoot, required).split(path.sep).join("/");
    if (!expectedSet.has(relativePath)) {
      throw new Error(`Runtime manifest does not declare required file: ${required}`);
    }
  }

  const actualPaths = runtimeFilePaths(runtimeRoot);
  const actualSet = new Set(actualPaths);
  const missing = expectedPaths.find(relativePath => !actualSet.has(relativePath));
  if (missing) throw new Error(`Runtime bundle file is missing: ${path.join(runtimeRoot, ...missing.split("/"))}`);
  const unexpected = actualPaths.find(relativePath => !expectedSet.has(relativePath));
  if (unexpected) {
    throw new Error(`Runtime bundle contains an unmanifested file: ${path.join(runtimeRoot, ...unexpected.split("/"))}`);
  }
  if (actualPaths.length !== expectedPaths.length) {
    throw new Error(`Runtime bundle file count mismatch: expected ${expectedPaths.length}, received ${actualPaths.length}`);
  }

  const canonicalRoot = fs.realpathSync(runtimeRoot);
  const stats = createHash("sha256");
  for (const file of manifest.files) {
    const metadata = statRuntimeFile(runtimeRoot, canonicalRoot, file);
    stats.update(`${file.path}\0${metadata.size}\0${metadata.mtimeMs}\0${metadata.ctimeMs}\0`);
  }
  const signature = stats.digest("hex");
  if (!verifiedSignatures(stampDir, manifest.bundleId).includes(signature)) {
    for (const file of manifest.files) hashRuntimeFile(runtimeRoot, file);
    rememberVerified(stampDir, manifest.bundleId, signature);
  }
  if (identity.platform !== "win32" && (fs.statSync(paths.executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }
  return { manifest, runtimeRoot: paths.runtimeRoot };
}

function validateRuntimeBundle(runtimeRoot, identity, options = {}) {
  return inspectRuntimeBundle(runtimeRoot, identity, options).runtimeRoot;
}

/** Where verified bundles are remembered (see verifiedSignatures), outside every bundle. */
function runtimeVerifiedDir(coreHome) {
  return path.join(coreHome, "runtime-verified");
}

/**
 * This version's runtime as already installed under the core home, when it is whole. A packaged
 * source with one stray, missing or edited file (a backup left beside cli.js, a hand edit, an
 * interrupted update) stopped every launch although this copy, the one the app runs, was intact.
 */
function installedPackagedRuntime({ app, coreHome }) {
  if (!app.isPackaged || !coreHome) return null;
  const identity = { version: app.getVersion(), platform: process.platform, arch: process.arch };
  const destination = path.join(coreHome, "versions", `${identity.version}-${identity.platform}-${identity.arch}`);
  try { return validateRuntimeBundle(destination, identity, { stampDir: runtimeVerifiedDir(coreHome) }); } catch { return null; }
}

async function waitForPackagedRuntimeSource({
  app,
  resourcesPath,
  onFallback = null,
  timeoutMs = DEFAULT_SOURCE_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_SOURCE_WAIT_INTERVAL_MS,
  // The bundle's platform: this machine's, except where a test checks another platform's bundle.
  platform = process.platform,
  arch = process.arch,
  // The same remembered verification ensurePackagedRuntime uses: without it this wait hashed every
  // runtime file again on each launch, before the window could open.
  coreHome = null,
}) {
  if (!app.isPackaged) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Packaged runtime source wait requires non-negative timeoutMs and positive intervalMs");
  }
  const source = path.join(resourcesPath, "runtime");
  const identity = { version: app.getVersion(), platform, arch };
  const verify = coreHome ? { stampDir: runtimeVerifiedDir(coreHome) } : {};
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      return validateRuntimeBundle(source, identity, verify);
    } catch (error) {
      lastError = error;
      // A whole installed copy of this version runs the app; a damaged source is reported, not fatal.
      const installed = installedPackagedRuntime({ app, coreHome });
      if (installed) {
        onFallback?.(error);
        return installed;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Packaged runtime did not fully materialize within ${timeoutMs}ms: ${detail}`);
}

function directoryInUse(error) {
  return ["EBUSY", "EPERM", "EACCES"].includes(error?.code);
}

// Removes a directory only after renaming it succeeded, which proves no process holds it open;
// a recursive delete of a directory in use could strip files from under a running runtime.
function retireDirectory(directory) {
  const doomed = `${directory}.retired-${process.pid}-${Date.now()}`;
  try { fs.renameSync(directory, doomed); } catch { return false; }
  try { fs.rmSync(doomed, { recursive: true, force: true }); } catch {}
  return true;
}

function retireSideBundles(versionsRoot, baseName) {
  let entries = [];
  try { entries = fs.readdirSync(versionsRoot); } catch { return; }
  for (const name of entries) {
    if (name.startsWith(`${baseName}-`) && /^[0-9a-f]{12}$/.test(name.slice(baseName.length + 1))) {
      retireDirectory(path.join(versionsRoot, name));
    }
  }
}

// Moves a validated side bundle into the version directory. Returns null (keep using the side
// bundle) when either directory is still in use; the previous release is restored in that case.
function promoteSideBundle(side, destination, expectedIdentity, verify) {
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  const hadDestination = fs.existsSync(destination);
  if (hadDestination) {
    try { renameAtomicFile(destination, previous); } catch (error) {
      if (directoryInUse(error)) return null;
      throw error;
    }
  }
  try {
    renameAtomicFile(side, destination);
  } catch (error) {
    if (hadDestination) renameAtomicFile(previous, destination);
    if (directoryInUse(error)) return null;
    throw error;
  }
  if (hadDestination) retireDirectory(previous);
  return validateRuntimeBundle(destination, expectedIdentity, verify);
}

function ensurePackagedRuntime({ app, coreHome, resourcesPath }) {
  if (!app.isPackaged) return null;
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const source = path.join(resourcesPath, "runtime");
  // Bundles already hashed are remembered here (see verifiedSignatures), outside every bundle.
  const verify = { stampDir: runtimeVerifiedDir(coreHome) };
  // The packaged copy is a source to copy from: only its manifest (which bundle this release is)
  // is read up front, and its files are checked only when they are about to be copied. Checking
  // them at every launch, then the installed copy as well, was two walks of 6,149 files on the
  // main process before the app could start (blocked up to 1 s per stat on the busy hard disk,
  // 2026-10-31). The installed copy, which the app runs, is still checked whole every launch.
  const sourceFailed = (error) => {
    // The installed copy of this version, when whole, runs the app (installedPackagedRuntime).
    const installed = installedPackagedRuntime({ app, coreHome });
    if (installed) return installed;
    throw error;
  };
  let sourceManifest;
  try {
    sourceManifest = readRuntimeManifest(source, identity);
  } catch (error) {
    return sourceFailed(error);
  }
  const expectedIdentity = { ...identity, bundleId: sourceManifest.bundleId };
  const versionsRoot = path.join(coreHome, "versions");
  const destination = path.join(
    versionsRoot,
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );
  // A same-version release with different files cannot replace the version directory while the
  // persistent core (bridge, MCP, CPA) still runs from it: Windows refuses to rename an open
  // directory. That release then lives beside it, named by its bundle id, until a later launch
  // finds the version directory free and promotes it.
  const side = `${destination}-${String(sourceManifest.bundleId).slice(0, 12)}`;
  if (fs.existsSync(destination)) {
    try {
      const root = validateRuntimeBundle(destination, expectedIdentity, verify);
      retireSideBundles(versionsRoot, path.basename(destination));
      return root;
    } catch {
      // A terminated installer or external cleanup can leave a version directory present but
      // incomplete. Rebuild the launcher-owned bundle transactionally from the signed package.
    }
  }
  if (fs.existsSync(side)) {
    let sideRoot = null;
    try { sideRoot = validateRuntimeBundle(side, expectedIdentity, verify); } catch {}
    if (sideRoot) return promoteSideBundle(side, destination, expectedIdentity, verify) ?? sideRoot;
    retireDirectory(side);
  }

  // A copy is needed: the packaged files must be whole before they are copied.
  let sourceBundle;
  try {
    sourceBundle = inspectRuntimeBundle(source, identity, verify);
  } catch (error) {
    return sourceFailed(error);
  }
  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  try {
    try {
      fs.cpSync(source, temporary, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
        // Not a file an update set aside because something still ran it.
        filter: (from) => !SET_ASIDE_FILE.test(path.basename(from)),
      });
    } catch (error) {
      // A full disk stopped the app at every start ("ENOSPC ... copyfile"). The packaged copy was
      // just checked whole: this session runs from it, and a later start copies it again.
      if (error?.code === "ENOSPC") return sourceBundle.runtimeRoot;
      throw error;
    }
    validateRuntimeBundle(temporary, expectedIdentity, verify);
    if (fs.existsSync(destination)) {
      try {
        renameAtomicFile(destination, previous);
      } catch (error) {
        if (!directoryInUse(error)) throw error;
        renameAtomicFile(temporary, side);
        return validateRuntimeBundle(side, expectedIdentity, verify);
      }
      previousMoved = true;
    }
    try {
      renameAtomicFile(temporary, destination);
      validateRuntimeBundle(destination, expectedIdentity, verify);
    } catch (error) {
      try { fs.rmSync(destination, { recursive: true, force: true }); } catch { /* restored over below */ }
      if (previousMoved) {
        try {
          renameAtomicFile(previous, destination);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(
            `Runtime replacement failed: ${error instanceof Error ? error.message : String(error)}`
            + `; previous runtime restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
      }
      throw error;
    }
    if (previousMoved) {
      // The new runtime is in place and valid: removing the old one is cleanup, never a reason to
      // stop the app (seen: "EPERM, Permission denied ...versions\<ver>.previous-..." at startup).
      try { fs.rmSync(previous, { recursive: true, force: true }); } catch { /* left for a later start */ }
      previousMoved = false;
    }
  } finally {
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* left for a later start */ }
    if (previousMoved && fs.existsSync(previous) && !fs.existsSync(destination)) {
      renameAtomicFile(previous, destination);
      previousMoved = false;
    }
  }
  try { fs.chmodSync(destination, 0o700); } catch {}
  return validateRuntimeBundle(destination, expectedIdentity, verify);
}

const STALE_RUNTIME_TEMP_MS = 60 * 60_000;

/**
 * Removes other versions' runtime copies from the core home: every update copied a whole runtime
 * (~6,000 files, 165 MB) into versions\ and none was ever removed (ten were found, 2026-10-22).
 * This version's copy and the newest other one (a rollback) stay, and so does any copy still in
 * use: each is renamed first, which Windows refuses for a folder a process runs from. The rename is
 * all the caller waits for; the delete runs on fs.promises so a slow disk never holds startup.
 * Leftover .tmp-/.previous-/.retired- folders older than an hour go too.
 */
async function pruneOldRuntimes({ app, coreHome, now = Date.now(), keepOthers = 1 }) {
  if (!app.isPackaged || !coreHome) return [];
  const versionsRoot = path.join(coreHome, "versions");
  const current = `${app.getVersion()}-${process.platform}-${process.arch}`;
  let entries;
  try { entries = fs.readdirSync(versionsRoot, { withFileTypes: true }); } catch { return []; }
  const others = [];
  const doomed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const leftover = /\.(tmp|previous|retired)-/.test(name);
    // This version's own leftovers go too (a copy cut off by a full disk is 165 MB); its copy and
    // a same-version side bundle stay.
    if (!leftover && (name === current || name.startsWith(`${current}-`))) continue;
    let mtimeMs;
    try { mtimeMs = fs.statSync(path.join(versionsRoot, name)).mtimeMs; } catch { continue; }
    if (leftover) {
      if (now - mtimeMs > STALE_RUNTIME_TEMP_MS) doomed.push(name);
    } else if (/-(win32|darwin|linux)-[a-z0-9]+$/.test(name)) {
      others.push({ name, mtimeMs });
    }
  }
  others.sort((a, b) => b.mtimeMs - a.mtimeMs);
  doomed.push(...others.slice(keepOthers).map((other) => other.name));
  const removed = [];
  const deletes = [];
  for (const name of doomed) {
    const retired = path.join(versionsRoot, `${name}.retired-${process.pid}-${now}`);
    const from = /\.retired-/.test(name) ? null : path.join(versionsRoot, name);
    try { if (from) fs.renameSync(from, retired); } catch { continue; }
    removed.push(name);
    deletes.push(fs.promises.rm(from ? retired : path.join(versionsRoot, name), { recursive: true, force: true }).catch(() => undefined));
  }
  await Promise.all(deletes);
  return removed;
}

module.exports = {
  ensurePackagedRuntime,
  pruneOldRuntimes,
  installedPackagedRuntime,
  validateRuntimeBundle,
  waitForPackagedRuntimeSource,
};
