"use strict";
// Whole-app updates with no installer. A release carries a manifest of every file in the
// Windows install (path, size, SHA-256 and the pack that holds it) and the packs themselves.
// The app downloads only the packs that hold files differing from the install, stages those
// files in <install>/_update, and app-update-worker.cjs swaps them in once the app has closed.
// The app closes the way "Restart app (keep Codex bridge, MCP, CPA)" does, so those keep running.
//
// Pack format (.ctpack): a gzip stream of records, each a 4-byte big-endian header length, a
// JSON header {"path","size"}, then the file's bytes.

const crypto = require("node:crypto");
const asarFs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

// The proxy variables as the app started. Global Routing sets them in this process (the built-in
// gateway's URL carries its local token); the relaunched app must start from the originals, not
// route through the gateway of the app that just closed.
const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const LAUNCH_PROXY_ENV = Object.fromEntries(PROXY_VARIABLES.map((name) => [name, process.env[name]]));
function launchEnvironment(base = process.env) {
  const env = { ...base };
  for (const name of PROXY_VARIABLES) {
    if (LAUNCH_PROXY_ENV[name] === undefined) delete env[name];
    else env[name] = LAUNCH_PROXY_ENV[name];
  }
  return env;
}

// Electron's fs treats every *.asar path as a folder; the install's app.asar is a plain file here.
const fs = (() => { try { return require("original-fs"); } catch { return asarFs; } })();
const {
  DEFAULT_UPDATE_CHECK_INTERVAL_MS, RELEASE_API_URL, compareVersions, downloadFile, downloadText,
  expectedChecksum, parseVersion, validateReleaseAssetUrl,
} = require("./update.cjs");

const SCHEMA = 1;
const CHECKSUMS = "SHA256SUMS.txt";
const STAGE_DIRECTORY = "_update";
const INSTALLED_MANIFEST = "installed.json";
const SET_ASIDE_LIST = "set-aside.json";
const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_HEADER_BYTES = 4096;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const PLAN_HASH_CONCURRENCY = 8;
// The update bar: checking the installed files fills its first part, downloading the packs the rest.
const CHECK_SHARE = 0.2;
const MAX_FILES = 50_000;
const WINDOWS_RESERVED = /(^|\/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|\/|$)/i;

function platformTag(platform = process.platform, arch = process.arch) {
  return platform === "win32" && arch === "x64" ? "win_x64" : null;
}

function manifestAssetName(version, tag) {
  return `Coding.Tools_${version}_${tag}_update.json`;
}

function packAssetName(version, tag, pack) {
  return `Coding.Tools_${version}_${tag}_${pack}.ctpack`;
}

/** An install-relative path with forward slashes, or null when it could leave the install. */
function safeInstallPath(value) {
  if (typeof value !== "string" || !value || value.length > 400 || /[\0\\:*?"<>|]/.test(value)) return null;
  if (value.startsWith("/") || value.endsWith("/") || WINDOWS_RESERVED.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) return null;
  if (parts[0].toLowerCase() === STAGE_DIRECTORY) return null;
  return value;
}

/** Files outside resources/ are Electron's own; they change only with the Electron version. */
function isFrameworkFile(rel) {
  return !rel.startsWith("resources/");
}

function parseManifest(text, { version, tag }) {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error("Update manifest exceeded its size limit");
  const manifest = JSON.parse(text);
  if (manifest?.schema !== SCHEMA || manifest.version !== version || manifest.platform !== tag) {
    throw new Error("Update manifest does not describe this release and platform");
  }
  if (typeof manifest.electron !== "string" || !manifest.electron) throw new Error("Update manifest has no Electron version");
  if (!Array.isArray(manifest.packs) || !Array.isArray(manifest.files)
    || !manifest.files.length || manifest.files.length > MAX_FILES) {
    throw new Error("Update manifest has an invalid inventory");
  }
  const packs = new Map();
  for (const pack of manifest.packs) {
    if (!PACK_NAME.test(String(pack?.name)) || packs.has(pack.name)
      || !Number.isSafeInteger(pack.size) || pack.size <= 0 || !/^[a-f0-9]{64}$/.test(String(pack.sha256))) {
      throw new Error("Update manifest lists an invalid pack");
    }
    packs.set(pack.name, pack);
  }
  const seen = new Set();
  for (const file of manifest.files) {
    const rel = safeInstallPath(file?.path);
    if (!rel || seen.has(rel.toLowerCase()) || !packs.has(file.pack)
      || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(String(file.sha256))) {
      throw new Error(`Update manifest lists an invalid file: ${String(file?.path)}`);
    }
    seen.add(rel.toLowerCase());
  }
  if (!seen.has("resources/app.asar")) throw new Error("Update manifest has no app.asar");
  return manifest;
}

/** The newest release newer than this install that carries a whole-app update for this platform. */
function selectAppRelease(payload, currentVersion, tag) {
  let selected = null;
  for (const release of Array.isArray(payload) ? payload : [payload]) {
    if (!release || release.draft === true) continue;
    const version = String(release.tag_name || "").replace(/^v/, "");
    if (!parseVersion(version) || compareVersions(version, currentVersion) <= 0) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const manifest = assets.find((asset) => asset?.name === manifestAssetName(version, tag));
    const checksums = assets.find((asset) => asset?.name === CHECKSUMS);
    if (!manifest?.browser_download_url || !checksums?.browser_download_url) continue;
    if (!selected || compareVersions(version, selected.version) > 0) {
      selected = { version, release, manifest, checksums, assets };
    }
  }
  return selected;
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * What an update changes: the files whose bytes differ from the install, the files the previous
 * update listed that this one drops, and the packs to download. Electron's own files are
 * replaced only when the Electron version changes; otherwise only their version stamp differs.
 */
async function planUpdate({ manifest, installRoot, electronVersion, previous = null, hash = hashFile, onProgress }) {
  const withFramework = manifest.electron !== electronVersion;
  const listed = new Set(manifest.files.map((file) => file.path.toLowerCase()));
  const candidates = manifest.files.filter((file) => withFramework || !isFrameworkFile(file.path));
  // An install holds thousands of files: hash several at once, and say how far the check is,
  // since it runs before any download and took minutes with the bar still at 0%.
  const differs = new Array(candidates.length);
  let next = 0;
  let checked = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const index = next++;
      const file = candidates[index];
      const target = path.join(installRoot, ...file.path.split("/"));
      // Only a missing file counts as one to replace; an unreadable install still stops the update
      // here, before anything is downloaded or the app is closed for it.
      const stat = await fs.promises.stat(target).catch((error) => {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
        throw error;
      });
      differs[index] = !(stat?.isFile() && stat.size === file.size && await hash(target) === file.sha256);
      onProgress?.(++checked, candidates.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PLAN_HASH_CONCURRENCY, candidates.length) }, worker));
  const changed = candidates.filter((_file, index) => differs[index]);
  const obsolete = [];
  for (const file of Array.isArray(previous?.files) ? previous.files : []) {
    const rel = safeInstallPath(file?.path);
    if (!rel || listed.has(rel.toLowerCase())) continue;
    if (isFrameworkFile(rel) && !withFramework) continue;
    if (fs.existsSync(path.join(installRoot, ...rel.split("/")))) obsolete.push(rel);
  }
  const packNames = new Set(changed.map((file) => file.pack));
  const packs = manifest.packs.filter((pack) => packNames.has(pack.name));
  return {
    changed, obsolete, packs, withFramework,
    downloadBytes: packs.reduce((sum, pack) => sum + pack.size, 0),
  };
}

/**
 * Reads a pack and writes the wanted files (path -> {size, sha256}) under stageRoot, checking each
 * file's size and hash. Files the update does not need are read past.
 */
async function extractPack(packPath, wanted, stageRoot) {
  // It runs in the launcher's main process while the app is in use: writing and closing each file
  // synchronously held every window (one close took 2 s on the hard disk, measured live during a
  // background update), so files are written through promises.
  const written = new Set();
  let buffer = Buffer.alloc(0);
  let current = null;
  const finish = async () => {
    if (current.file !== null) {
      const file = current.file;
      current.file = null;
      await file.close();
      if (current.hash.digest("hex") !== current.want.sha256) {
        throw new Error(`Update file failed SHA-256 verification: ${current.rel}`);
      }
      written.add(current.rel);
    }
    current = null;
  };
  try {
    for await (const chunk of fs.createReadStream(packPath).pipe(zlib.createGunzip())) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (current) {
          const take = Math.min(current.remaining, buffer.length);
          if (take > 0) {
            const part = buffer.subarray(0, take);
            if (current.file !== null) {
              await current.file.write(part);
              current.hash.update(part);
            }
            current.remaining -= take;
            buffer = buffer.subarray(take);
          }
          if (current.remaining > 0) break;
          await finish();
          continue;
        }
        if (buffer.length < 4) break;
        const length = buffer.readUInt32BE(0);
        if (length < 2 || length > MAX_HEADER_BYTES) throw new Error("Update pack has a corrupt record");
        if (buffer.length < 4 + length) break;
        const header = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        const rel = safeInstallPath(header?.path);
        if (!rel || !Number.isSafeInteger(header.size) || header.size < 0) throw new Error("Update pack has an unsafe record");
        const want = wanted.get(rel) || null;
        if (want && want.size !== header.size) throw new Error(`Update pack size does not match the manifest: ${rel}`);
        let file = null;
        if (want) {
          const output = path.join(stageRoot, ...rel.split("/"));
          await fs.promises.mkdir(path.dirname(output), { recursive: true });
          file = await fs.promises.open(output, "wx", 0o600);
        }
        current = { rel, want, file, remaining: header.size, hash: want ? crypto.createHash("sha256") : null };
        if (current.remaining === 0) await finish();
      }
    }
    if (current || buffer.length) throw new Error("Update pack ended early");
  } finally {
    if (current?.file) {
      try { await current.file.close(); } catch {}
    }
  }
  for (const rel of wanted.keys()) {
    if (!written.has(rel)) throw new Error(`Update pack is missing ${rel}`);
  }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

/** Deletes files an earlier update set aside because something still ran them. */
function sweepUpdateLeftovers(installRoot) {
  const listPath = path.join(installRoot, STAGE_DIRECTORY, SET_ASIDE_LIST);
  const list = readJson(listPath);
  if (!Array.isArray(list)) return 0;
  const remaining = [];
  let removed = 0;
  for (const rel of list) {
    if (typeof rel !== "string" || !/\.old-\d+$/.test(rel) || !safeInstallPath(rel)) continue;
    try {
      fs.rmSync(path.join(installRoot, ...rel.split("/")), { force: true });
      removed += 1;
    } catch {
      remaining.push(rel);
    }
  }
  try {
    if (remaining.length) fs.writeFileSync(listPath, `${JSON.stringify(remaining)}\n`);
    else fs.rmSync(listPath, { force: true });
  } catch {}
  return removed;
}

const APPLY_WAIT_MAX_MS = 10 * 60_000;
/**
 * Waits while an update worker is swapping files into the install (its `_update/applying.json`
 * names a live process), at most APPLY_WAIT_MAX_MS from when it started. A launch during the swap
 * found the runtime half-replaced and aborted. A stale marker (its worker gone) is removed.
 */
async function waitForUpdateApply(installRoot, { now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } } } = {}) {
  const marker = path.join(installRoot, STAGE_DIRECTORY, "applying.json");
  for (;;) {
    const state = readJson(marker);
    if (!state) return false;
    const started = Number.isFinite(state.at) ? state.at : 0;
    if (!Number.isInteger(state.pid) || !alive(state.pid) || now() - started > APPLY_WAIT_MAX_MS) {
      try { fs.rmSync(marker, { force: true }); } catch {}
      return true;
    }
    await sleep(500);
  }
}

function createAppUpdateController({
  currentVersion, electronVersion, platform = process.platform, arch = process.arch,
  packaged, executablePath, logsDirectory, publish, logger, closeForUpdate, closeBlocker, dependencies = {},
}) {
  const tag = platformTag(platform, arch);
  const installRoot = executablePath ? path.dirname(executablePath) : null;
  const usable = Boolean(packaged && tag && installRoot
    && fs.existsSync(path.join(installRoot, "resources", "app.asar")));
  const deps = {
    fetchRelease: async () => JSON.parse(await downloadText(RELEASE_API_URL)),
    downloadText, downloadFile, hash: hashFile,
    spawnWorker(runtime, worker, job) {
      const env = { ...launchEnvironment(), ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1" };
      const child = spawn(runtime, [worker, job], { detached: true, stdio: "ignore", windowsHide: true, env });
      // A refused start (antivirus, Smart App Control) is reported by the caller from the missing
      // pid; the 'error' event that follows on the next tick must not be uncaught.
      child.once("error", () => undefined);
      return child;
    },
    ...dependencies,
  };
  let state = { status: usable ? "idle" : "disabled", kind: "app" };
  let candidate = null;
  let checking = null;
  let pending = null;
  let checked = false;
  let timer = null;
  const transition = (next) => { state = { ...next, kind: "app" }; publish?.(state); return state; };

  async function checkNow({ force = true } = {}) {
    if (state.status === "disabled" || ["downloading", "installing"].includes(state.status)) return state;
    if (checking) return checking;
    if (!force && checked) return state;
    checked = true;
    checking = (async () => {
      if (state.status !== "available") transition({ status: "checking" });
      try {
        const selected = selectAppRelease(await deps.fetchRelease(), currentVersion, tag);
        if (!selected) {
          candidate = null;
          return transition({ status: "up-to-date" });
        }
        const assetUrl = (asset) => validateReleaseAssetUrl(asset.browser_download_url, selected.version, asset.name);
        candidate = {
          version: selected.version,
          manifestName: selected.manifest.name,
          manifestUrl: assetUrl(selected.manifest),
          checksumsUrl: assetUrl(selected.checksums),
          packUrl: (name) => {
            const asset = selected.assets.find((entry) => entry?.name === packAssetName(selected.version, tag, name));
            if (!asset?.browser_download_url) throw new Error(`The release has no update pack ${name}`);
            return assetUrl(asset);
          },
        };
        logger?.info("launcher.app_update_available", { currentVersion, version: selected.version });
        return transition({ status: "available", version: selected.version });
      } catch (error) {
        candidate = null;
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn("launcher.app_update_check_failed", { message });
        return transition({ status: "error", message });
      }
    })();
    try { return await checking; } finally { checking = null; }
  }

  async function stage(available) {
    const checksums = await deps.downloadText(available.checksumsUrl);
    const manifestText = await deps.downloadText(available.manifestUrl, MAX_MANIFEST_BYTES);
    const manifestHash = crypto.createHash("sha256").update(manifestText).digest("hex");
    if (manifestHash !== expectedChecksum(checksums, available.manifestName)) {
      throw new Error("Update manifest failed SHA-256 verification");
    }
    const manifest = parseManifest(manifestText, { version: available.version, tag });
    const updateRoot = path.join(installRoot, STAGE_DIRECTORY);
    const previous = readJson(path.join(updateRoot, INSTALLED_MANIFEST));
    let shown = -1;
    const report = (fraction) => {
      const progress = Math.min(1, Math.floor(fraction * 100) / 100);
      if (progress === shown) return;
      shown = progress;
      transition({ status: "downloading", version: available.version, progress });
    };
    const plan = await planUpdate({
      manifest, installRoot, electronVersion, previous, hash: deps.hash,
      onProgress: (done, total) => report(CHECK_SHARE * (done / total)),
    });
    logger?.info("launcher.app_update_plan", {
      version: available.version, files: plan.changed.length, obsolete: plan.obsolete.length,
      packs: plan.packs.map((pack) => pack.name), downloadBytes: plan.downloadBytes, withFramework: plan.withFramework,
    });
    fs.mkdirSync(updateRoot, { recursive: true });
    // An earlier stage holds a whole update's files: removing it synchronously held the windows.
    for (const entry of fs.readdirSync(updateRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("stage-")) {
        await fs.promises.rm(path.join(updateRoot, entry.name), { recursive: true, force: true });
      }
    }
    const stageRoot = fs.mkdtempSync(path.join(updateRoot, "stage-"));
    const filesRoot = path.join(stageRoot, "files");
    let downloaded = 0;
    const downloadShare = (bytes) => report(CHECK_SHARE + (1 - CHECK_SHARE) * (plan.downloadBytes ? bytes / plan.downloadBytes : 1));
    for (const pack of plan.packs) {
      const packPath = path.join(stageRoot, `${pack.name}.ctpack`);
      let received = 0;
      await deps.downloadFile(available.packUrl(pack.name), packPath, (bytes) => {
        received += bytes;
        downloadShare(downloaded + Math.min(received, pack.size));
      });
      const stat = fs.statSync(packPath);
      if (stat.size !== pack.size || await deps.hash(packPath) !== pack.sha256) {
        throw new Error(`Update pack ${pack.name} failed SHA-256 verification`);
      }
      const wanted = new Map(plan.changed.filter((file) => file.pack === pack.name).map((file) => [file.path, file]));
      await extractPack(packPath, wanted, filesRoot);
      await fs.promises.rm(packPath, { force: true });
      downloaded += pack.size;
      downloadShare(downloaded);
    }
    const workerPath = path.join(stageRoot, "app-update-worker.cjs");
    // The worker ships inside app.asar, which only Electron's fs reads.
    fs.writeFileSync(workerPath, asarFs.readFileSync(path.join(__dirname, "app-update-worker.cjs")));
    const job = {
      version: available.version,
      parentPid: process.pid,
      installRoot,
      stageRoot,
      filesRoot,
      executable: executablePath,
      changed: plan.changed.map((file) => file.path),
      obsolete: plan.obsolete,
      installedManifest: { version: manifest.version, files: manifest.files.map(({ path: rel, size, sha256 }) => ({ path: rel, size, sha256 })) },
      logPath: path.join(logsDirectory, "app-update-worker.log"),
    };
    const jobPath = path.join(stageRoot, "job.json");
    fs.writeFileSync(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    return { stageRoot, workerPath, jobPath };
  }

  async function beginInstall() {
    if (pending) return pending;
    pending = (async () => {
      if (state.status !== "available" || !candidate) throw new Error("No app update is available");
      // Refused before anything downloads: a click while a ChatGPT turn ran staged the whole update
      // on disk, then the app would not close and the stage was deleted again.
      const blocked = closeBlocker?.();
      if (blocked) {
        logger?.warn("launcher.app_update_failed", { message: blocked });
        throw new Error(blocked);
      }
      const available = candidate;
      transition({ status: "downloading", version: available.version, progress: 0 });
      let staged = null;
      let child = null;
      try {
        staged = await stage(available);
        child = deps.spawnWorker(executablePath, staged.workerPath, staged.jobPath);
        if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("The update worker did not start");
        child.unref?.();
        logger?.info("launcher.app_update_worker_started", { pid: child.pid, version: available.version });
        transition({ status: "installing", version: available.version });
        const closed = await closeForUpdate();
        if (closed?.ok === false) throw new Error(closed.message || "The app couldn't close for the update. Close it and try again.");
        return true;
      } catch (error) {
        try { child?.kill(); } catch {}
        if (staged) await fs.promises.rm(staged.stageRoot, { recursive: true, force: true }).catch(() => undefined);
        transition({ status: "available", version: available.version });
        logger?.warn("launcher.app_update_failed", { message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    })();
    try { return await pending; } finally { pending = null; }
  }

  function stopPeriodicChecks() { if (timer) clearInterval(timer); timer = null; }
  function startPeriodicChecks({ intervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000) throw new Error("Invalid app update check interval");
    stopPeriodicChecks();
    timer = setInterval(() => { void checkNow(); }, intervalMs);
    timer.unref?.();
  }

  return {
    getState: () => state, checkNow, checkOnce: () => checkNow({ force: false }), beginInstall,
    startPeriodicChecks, stopPeriodicChecks, installRoot: usable ? installRoot : null,
  };
}

const ACTIVE = ["available", "downloading", "installing"];

/** The state the GUI shows: a whole-app update wins over a renderer-only one. */
function combinedUpdateState(appState, guiState) {
  if (ACTIVE.includes(appState.status)) return appState;
  if (ACTIVE.includes(guiState.status)) return guiState;
  if (appState.status === "checking" || guiState.status === "checking") return { status: "checking" };
  if (appState.status === "error") return appState;
  if (guiState.status === "error") return guiState;
  if (appState.status === "up-to-date" || guiState.status === "up-to-date") return { status: "up-to-date" };
  if (appState.status === "disabled" && guiState.status === "disabled") return { status: "disabled" };
  return { status: "idle" };
}

/** One update controller for the GUI: whole-app updates first, then renderer-only updates. */
function combineUpdateControllers(appUpdates, guiUpdates) {
  const state = () => combinedUpdateState(appUpdates.getState(), guiUpdates.getState());
  return {
    getState: state,
    getRendererPath: () => guiUpdates.getRendererPath(),
    async checkNow(options) {
      const appState = await appUpdates.checkNow(options);
      if (ACTIVE.includes(appState.status)) return state();
      await guiUpdates.checkNow(options);
      return state();
    },
    async checkOnce() {
      const appState = await appUpdates.checkOnce();
      if (!ACTIVE.includes(appState.status)) await guiUpdates.checkOnce();
      return state();
    },
    async beginInstall() {
      if (appUpdates.getState().status !== "available") {
        const appState = await appUpdates.checkNow({ force: true });
        if (appState.status !== "available") return guiUpdates.beginInstall();
      }
      return appUpdates.beginInstall();
    },
    startPeriodicChecks(options) {
      appUpdates.startPeriodicChecks(options);
      guiUpdates.startPeriodicChecks(options);
    },
    stopPeriodicChecks() {
      appUpdates.stopPeriodicChecks();
      guiUpdates.stopPeriodicChecks();
    },
  };
}

// With automatic updates on, a found update installs by itself once nobody is using the app: no
// keyboard or mouse input for AUTO_INSTALL_IDLE_SECONDS and no work running (isBusy). A failed
// install waits AUTO_INSTALL_RETRY_MS before the next try instead of downloading again each minute.
const AUTO_INSTALL_IDLE_SECONDS = 10 * 60;
const AUTO_INSTALL_POLL_MS = 60 * 1000;
const AUTO_INSTALL_RETRY_MS = 60 * 60 * 1000;

function createAutoInstaller({
  controller, enabled, idleSeconds, isBusy, logger, now = Date.now,
  pollMs = AUTO_INSTALL_POLL_MS, idleThreshold = AUTO_INSTALL_IDLE_SECONDS, retryMs = AUTO_INSTALL_RETRY_MS,
}) {
  let timer = null;
  let attempting = false;
  let failedAt = null;

  async function tick() {
    if (attempting || !enabled()) return false;
    const state = controller.getState();
    if (state.status !== "available") return false;
    if (failedAt !== null && now() - failedAt < retryMs) return false;
    if (idleSeconds() < idleThreshold) return false;
    attempting = true;
    try {
      // A busy check that cannot answer counts as busy: never restart over work it could not see.
      if (await Promise.resolve().then(isBusy).catch(() => true)) return false;
      logger?.info("launcher.update_auto_install", { version: state.version ?? null, kind: state.kind ?? null });
      await controller.beginInstall();
      failedAt = null;
      return true;
    } catch (error) {
      failedAt = now();
      logger?.warn("launcher.update_auto_install_failed", { message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      attempting = false;
    }
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }
  function start() {
    stop();
    timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref?.();
  }
  return { tick, start, stop };
}

module.exports = {
  AUTO_INSTALL_IDLE_SECONDS,
  INSTALLED_MANIFEST,
  SET_ASIDE_LIST,
  STAGE_DIRECTORY,
  combineUpdateControllers,
  combinedUpdateState,
  createAppUpdateController,
  createAutoInstaller,
  extractPack,
  hashFile,
  isFrameworkFile,
  manifestAssetName,
  packAssetName,
  parseManifest,
  planUpdate,
  platformTag,
  safeInstallPath,
  selectAppRelease,
  sweepUpdateLeftovers,
  waitForUpdateApply,
};
