const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const {
  DEFAULT_UPDATE_CHECK_INTERVAL_MS, RELEASE_API_URL, downloadFile, downloadText,
  expectedChecksum, parseVersion, sha256, validateReleaseAssetUrl,
} = require("./update.cjs");

const MAX_GUI_BYTES = 64 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

function guiShellHash(directory = __dirname) {
  const hash = crypto.createHash("sha256");
  for (const name of ["main.cjs", "preload.cjs", "ipc-schema.cjs", "gui-update.cjs"]) {
    hash.update(name).update("\0").update(fs.readFileSync(path.join(directory, name), "utf8").replace(/\r\n/g, "\n")).update("\0");
  }
  return hash.digest("hex");
}

function guiAssetName(shellVersion, revision) {
  return `Coding.Tools_${shellVersion}_gui_r${revision}.json.gz`;
}

function selectGuiRelease(payload, shellVersion) {
  const prefix = `v${shellVersion}-gui.r`;
  let selected = null;
  for (const release of Array.isArray(payload) ? payload : [payload]) {
    if (!release || release.draft || !String(release.tag_name).startsWith(prefix)) continue;
    const value = release.tag_name.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(value)) continue;
    const revision = Number(value);
    if (!Number.isSafeInteger(revision)) continue;
    const assetName = guiAssetName(shellVersion, revision);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((entry) => entry?.name === assetName);
    const checksums = assets.find((entry) => entry?.name === "SHA256SUMS.txt");
    if (!asset?.browser_download_url || !checksums?.browser_download_url
      || asset.size > MAX_DOWNLOAD_BYTES) continue;
    if (!selected || revision > selected.revision) {
      selected = { revision, tag: release.tag_name, assetName, asset, checksums };
    }
  }
  return selected;
}

function parseGuiBundle(bytes, { shellVersion, shellHash, revision }) {
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("GUI download exceeded its size limit");
  const bundle = JSON.parse(zlib.gunzipSync(bytes, { maxOutputLength: MAX_GUI_BYTES }).toString("utf8"));
  if (bundle.schema !== 1 || bundle.shellVersion !== shellVersion || bundle.shellHash !== shellHash
    || bundle.revision !== revision) throw new Error("GUI bundle is incompatible with this installed shell");
  if (!Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 256) {
    throw new Error("GUI bundle has an invalid file inventory");
  }
  const seen = new Set();
  const files = bundle.files.map((file) => {
    if (!file || typeof file.path !== "string"
      || !(file.path === "index.html" || /^assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(js|css|json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|wasm)$/i.test(file.path))
      || /(^|\/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.path)
      || seen.has(file.path) || typeof file.content !== "string") {
      throw new Error("GUI bundle contains an unsafe or duplicate file path");
    }
    seen.add(file.path);
    const content = Buffer.from(file.content, "base64");
    if (content.toString("base64") !== file.content) throw new Error("GUI bundle contains invalid file data");
    return { path: file.path, content };
  });
  if (!files.some((file) => file.path === "index.html" && file.content.length)) {
    throw new Error("GUI bundle has no renderer entry point");
  }
  return files;
}

function createGuiUpdateController({
  currentVersion, shellHash, packaged, rendererPath, updateRoot,
  reloadRenderer, publish, logger, dependencies = {},
}) {
  if (!parseVersion(currentVersion)) throw new Error("Invalid installed GUI shell version");
  const root = path.join(updateRoot, currentVersion);
  const pointer = path.join(root, "current.json");
  const deps = {
    fetchRelease: async () => JSON.parse(await downloadText(RELEASE_API_URL)),
    downloadText, downloadFile, sha256, ...dependencies,
  };
  let current = { entry: rendererPath, revision: 0 };
  if (packaged) {
    try {
      const saved = JSON.parse(fs.readFileSync(pointer, "utf8"));
      if (saved.shellHash !== shellHash || !Number.isSafeInteger(saved.revision) || saved.revision < 1
        || !new RegExp(`^r${saved.revision}-[a-f0-9]{12}$`).test(saved.directory)) {
        throw new Error("Saved GUI is incompatible");
      }
      const entry = path.join(root, "bundles", saved.directory, "index.html");
      if (!fs.statSync(entry).isFile()) throw new Error("Saved GUI entry is missing");
      current = { entry, revision: saved.revision };
    } catch (error) {
      if (error.code !== "ENOENT") logger?.warn("launcher.saved_gui_unavailable", { message: error.message });
    }
  }
  let state = { status: packaged ? "idle" : "disabled" };
  let candidate = null;
  let checking = null;
  let pending = null;
  let checked = false;
  let timer = null;
  const transition = (next) => { state = next; publish?.(state); return state; };

  async function checkNow({ force = true } = {}) {
    if (state.status === "disabled" || ["downloading", "installing"].includes(state.status)) return state;
    if (checking) return checking;
    if (!force && checked) return state;
    checked = true;
    checking = (async () => {
      if (state.status !== "available") transition({ status: "checking" });
      try {
        const selected = selectGuiRelease(await deps.fetchRelease(), currentVersion);
        if (!selected || selected.revision <= current.revision) {
          candidate = null;
          return transition({ status: "up-to-date" });
        }
        candidate = {
          ...selected,
          assetUrl: validateReleaseAssetUrl(selected.asset.browser_download_url, selected.tag.slice(1), selected.assetName),
          checksumsUrl: validateReleaseAssetUrl(selected.checksums.browser_download_url, selected.tag.slice(1), "SHA256SUMS.txt"),
        };
        return transition({ status: "available", version: `r${selected.revision}` });
      } catch (error) {
        candidate = null;
        return transition({ status: "error", message: error.message });
      }
    })();
    try { return await checking; } finally { checking = null; }
  }

  async function beginInstall() {
    if (pending) return pending;
    pending = (async () => {
      const next = state.status === "available" && candidate ? state : await checkNow();
      if (next.status === "disabled") throw new Error("GUI updates are available in packaged desktop builds");
      if (next.status === "up-to-date") return false;
      if (next.status === "error") throw new Error(next.message);
      const available = candidate;
      if (!available) throw new Error("No compatible GUI update is available");
      const version = `r${available.revision}`;
      transition({ status: "downloading", version });
      const scratch = path.join(root, "aiTemp");
      fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
      const stage = fs.mkdtempSync(path.join(scratch, "update-"));
      try {
        const checksums = await deps.downloadText(available.checksumsUrl);
        const expected = expectedChecksum(checksums, available.assetName);
        const archive = path.join(stage, available.assetName);
        await deps.downloadFile(available.assetUrl, archive);
        if (fs.statSync(archive).size > MAX_DOWNLOAD_BYTES) throw new Error("GUI download exceeded its size limit");
        if (deps.sha256(archive) !== expected) throw new Error("GUI update SHA-256 verification failed");
        const files = parseGuiBundle(fs.readFileSync(archive), {
          shellVersion: currentVersion, shellHash, revision: available.revision,
        });
        const directory = `r${available.revision}-${crypto.randomBytes(6).toString("hex")}`;
        const destination = path.join(root, "bundles", directory);
        const stagedRenderer = path.join(stage, "renderer");
        for (const file of files) {
          const output = path.join(stagedRenderer, file.path);
          fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
          fs.writeFileSync(output, file.content, { flag: "wx", mode: 0o600 });
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.renameSync(stagedRenderer, destination);
        const previous = current;
        current = { entry: path.join(destination, "index.html"), revision: available.revision };
        transition({ status: "installing", version });
        try {
          await reloadRenderer(current.entry);
          writePrivateFileAtomic(pointer, JSON.stringify({ directory, revision: current.revision, shellHash }));
        } catch (error) {
          current = previous;
          try { await reloadRenderer(previous.entry); } catch (rollback) {
            logger?.warn("launcher.gui_rollback_load_failed", { message: rollback.message });
          }
          throw error;
        }
        candidate = null;
        logger?.info("launcher.gui_updated", { revision: current.revision });
        transition({ status: "up-to-date" });
        return true;
      } catch (error) {
        transition({ status: "available", version });
        throw error;
      }
    })();
    try { return await pending; } finally { pending = null; }
  }

  function stopPeriodicChecks() { if (timer) clearInterval(timer); timer = null; }
  function startPeriodicChecks({ intervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000) throw new Error("Invalid GUI update check interval");
    stopPeriodicChecks();
    timer = setInterval(() => { void checkNow(); }, intervalMs);
    timer.unref?.();
  }

  return {
    getState: () => state, getRendererPath: () => current.entry,
    checkNow, checkOnce: () => checkNow({ force: false }), beginInstall,
    startPeriodicChecks, stopPeriodicChecks,
  };
}

module.exports = { createGuiUpdateController, guiAssetName, guiShellHash, parseGuiBundle, selectGuiRelease };
