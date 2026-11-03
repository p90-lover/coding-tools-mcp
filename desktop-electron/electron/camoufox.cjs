"use strict";

/**
 * Camoufox (daijro/camoufox), the Firefox build the ChatGPT browser can run in, as an App plugin:
 * one folder per version under <userData>/tools/camoufox/<version>, its version.json naming it.
 *
 * A release is a ~1.3 GB zip that unpacks to ~2.5 GB, and 2 GB of that is its font pack, which
 * rarely changes between builds. An update reads the zip's central directory, hard-links every font
 * whose size and CRC-32 match the installed version's copy, and unpacks only the rest, so an update
 * needs ~0.5 GB beside the download rather than 2.5 GB. The old version goes to Trash.
 *
 * Every call is async: this runs on Electron main (main-sync-calls.test.cjs).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const { compareVersions } = require("./update.cjs");

// 156.0.1-beta.39, 158.0-beta.40: a release's tag without its "v".
const VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[a-z]+\.\d+)?$/u;
const EXECUTABLE = "camoufox.exe";
const MANIFEST = "version.json";
// What an unpack needs beyond the files it writes (the file system's own records, a margin).
const FREE_MARGIN_BYTES = 512 * 1024 * 1024;
// A name a bsdtar exclude pattern would read as a glob is unpacked instead of linked.
const GLOB = /[*?[\]\\]/u;

const tarBinary = (platform) => (platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar");

/** The Windows x64 zip a release ships for `version`. */
const releaseAssetName = (version) => `camoufox-${version}-win.x86_64.zip`;

function compare(left, right) {
  try { return compareVersions(left, right); } catch { return String(left).localeCompare(String(right), "en", { numeric: true }); }
}

/**
 * The files in a zip, from its central directory: name, uncompressed size and CRC-32. Null for a
 * zip this can't read (zip64 sizes, a damaged directory), which then unpacks in full.
 */
async function zipEntries(file) {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 22 + 65_535);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let at = tailLength - 22; at >= 0; at -= 1) if (tail.readUInt32LE(at) === 0x06054b50) { end = at; break; }
    if (end < 0) return null;
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff || offset + length > size) return null;
    const directory = Buffer.alloc(length);
    await handle.read(directory, 0, length, offset);
    const entries = [];
    for (let at = 0; at + 46 <= length && entries.length < count;) {
      if (directory.readUInt32LE(at) !== 0x02014b50) return null;
      const nameLength = directory.readUInt16LE(at + 28);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      const entrySize = directory.readUInt32LE(at + 24);
      if (!name.endsWith("/")) entries.push({ name, size: entrySize, crc32: directory.readUInt32LE(at + 16), zip64: entrySize === 0xffffffff });
      at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function crc32File(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) crc = zlib.crc32(chunk, crc);
  return crc >>> 0;
}

/** The bytes free for this user on the drive holding `dir`, or null when it can't be read. */
async function freeBytes(dir) {
  try {
    const stats = await fs.promises.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch { return null; }
}

const gigabytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function createCamoufox({ root, logger = console, platform = process.platform, spawnImpl = spawn, now = () => Date.now(), free = freeBytes }) {
  if (!root || !path.isAbsolute(root)) throw new Error("Camoufox needs an absolute install folder");
  const trashRoot = path.join(path.dirname(root), "Trash", "camoufox");
  let installing = null;

  async function readInstall(version) {
    const dir = path.join(root, version);
    try {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, MANIFEST), "utf8"));
      // Camoufox's own installer writes { version: "156.0.1", build: "beta.39" }; ours writes the whole version.
      const named = manifest.build && !String(manifest.version).includes("-") ? `${manifest.version}-${manifest.build}` : String(manifest.version);
      const executable = path.join(dir, EXECUTABLE);
      if (named !== version || !(await fs.promises.stat(executable)).isFile()) return null;
      return { version, dir, executable, sha256: manifest.sha256 || null };
    } catch { return null; }
  }

  async function versionDirs() {
    try {
      return (await fs.promises.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && VERSION.test(entry.name)).map((entry) => entry.name);
    } catch { return []; }
  }

  /** The newest complete install, or null. */
  async function installed() {
    for (const version of (await versionDirs()).sort((left, right) => compare(right, left))) {
      const found = await readInstall(version);
      if (found) return found;
    }
    return null;
  }

  async function status() {
    const current = await installed();
    return { installed: Boolean(current), version: current?.version ?? null, executable: current?.executable ?? null, installing: Boolean(installing), root };
  }

  async function toTrash(source, name) {
    const target = path.join(trashRoot, name);
    await fs.promises.mkdir(trashRoot, { recursive: true });
    await fs.promises.rename(source, target);
  }

  /** The fonts in `entries` the current install already has byte for byte (same size and CRC-32). */
  async function reusableFonts(entries, current) {
    if (!entries || !current || typeof zlib.crc32 !== "function") return [];
    const reusable = [];
    for (const entry of entries) {
      if (!entry.name.startsWith("fonts/") || entry.zip64 || GLOB.test(entry.name)) continue;
      const source = path.join(current.dir, ...entry.name.split("/"));
      if (!source.startsWith(current.dir + path.sep)) continue;
      try {
        if ((await fs.promises.stat(source)).size !== entry.size || await crc32File(source) !== entry.crc32) continue;
      } catch { continue; }
      reusable.push({ name: entry.name, source });
    }
    return reusable;
  }

  function unpack(zip, staging, excludeFile) {
    return new Promise((resolve, reject) => {
      const args = ["-xf", zip, "-C", staging, ...(excludeFile ? ["-X", excludeFile] : [])];
      const child = spawnImpl(tarBinary(platform), args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      // A 2 GB unpack on the shared disk: low priority, so the app and other work keep the disk.
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch {}
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Camoufox's zip didn't unpack (tar exit ${code})${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/u).pop()}` : ""}`))));
    });
  }

  /**
   * Installs a downloaded, checked release zip as <root>/<version> and retires the others. The zip's
   * SHA-256 was already compared with GitHub's; `sha256` is recorded in version.json.
   */
  function install({ zip, version, sha256 }) {
    if (installing) return installing;
    if (!VERSION.test(String(version))) return Promise.reject(new Error(`"${version}" isn't a Camoufox version`));
    installing = (async () => {
      const staging = path.join(root, `.staging-${version}-${now()}`);
      const excludeFile = path.join(root, `.exclude-${version}-${now()}.txt`);
      try {
        await fs.promises.mkdir(root, { recursive: true });
        const entries = await zipEntries(zip).catch(() => null);
        const current = await installed();
        const reused = current?.version === version ? [] : await reusableFonts(entries, current);
        const reusedNames = new Set(reused.map((item) => item.name));
        const needed = entries ? entries.filter((entry) => !reusedNames.has(entry.name)).reduce((sum, entry) => sum + entry.size, 0) : 3 * (await fs.promises.stat(zip)).size;
        const available = await free(root);
        if (available !== null && available < needed + FREE_MARGIN_BYTES) {
          throw new Error(`Camoufox ${version} needs ${gigabytes(needed + FREE_MARGIN_BYTES)} free on ${path.parse(root).root}; ${gigabytes(available)} is free`);
        }
        await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
        if (reused.length) await fs.promises.writeFile(excludeFile, `${reused.map((item) => item.name).join("\n")}\n`);
        await unpack(zip, staging, reused.length ? excludeFile : null);
        for (const item of reused) {
          const target = path.join(staging, ...item.name.split("/"));
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.link(item.source, target);
        }
        if (!(await fs.promises.stat(path.join(staging, EXECUTABLE)).catch(() => null))?.isFile()) throw new Error(`Camoufox's zip has no ${EXECUTABLE}`);
        await fs.promises.writeFile(path.join(staging, MANIFEST), `${JSON.stringify({
          version, sha256, installedAt: new Date(now()).toISOString(), fontsReusedFrom: reused.length ? current.version : null,
        }, null, 2)}\n`);
        const home = path.join(root, version);
        if (await fs.promises.stat(home).catch(() => null)) await toTrash(home, `${version}-replaced-${now()}`);
        await fs.promises.rename(staging, home);
        // After the switch: a version still running can't move on Windows, so it stays until the next update.
        for (const old of await versionDirs()) {
          if (old === version) continue;
          await toTrash(path.join(root, old), `${old}-${now()}`).catch((error) => logger.warn?.("camoufox.retire_failed", { version: old, message: String(error?.message || error) }));
        }
        logger.info?.("camoufox.installed", { version, from: current?.version ?? null, fontsReused: reused.length });
        return status();
      } catch (error) {
        await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
        throw error;
      } finally {
        await fs.promises.rm(excludeFile, { force: true }).catch(() => {});
        installing = null;
      }
    })();
    return installing;
  }

  // Before the first install the folder doesn't exist yet: its drive is read from the parent.
  const rootFree = async () => (await free(root)) ?? free(path.dirname(root));
  return { root, status, installed, install, freeBytes: rootFree };
}

module.exports = { createCamoufox, zipEntries, releaseAssetName, FREE_MARGIN_BYTES };
