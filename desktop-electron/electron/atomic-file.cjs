const fs = require("node:fs");
const path = require("node:path");

let sequence = 0;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 350, 500];

function waitSync(milliseconds) {
  Atomics.wait(waitCell, 0, 0, milliseconds);
}

function renameAtomicFile(
  source,
  destination,
  {
    platform = process.platform,
    rename = fs.renameSync,
    wait = waitSync,
  } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const transientWindowsError = platform === "win32"
        && ["EBUSY", "EPERM", "EACCES"].includes(error?.code);
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!transientWindowsError || delay === undefined) throw error;
      wait(delay);
    }
  }
}

function writePrivateFileAtomic(filePath, content, { mode = 0o600, protectDirectory = true } = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (protectDirectory) {
    try { fs.chmodSync(directory, 0o700); } catch {}
  }
  const payload = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content).replace(/^\uFEFF/, ""), "utf8");
  // Windows has reported EEXIST for a temp name that is unique to this process and moment (seen
  // while a freshly installed app's data folder was being scanned). That name is never ours, so
  // it is left alone and the write moves to a fresh one.
  let temporary = null;
  for (let attempt = 0; temporary === null; attempt += 1) {
    const candidate = `${filePath}.tmp-${process.pid}-${Date.now()}-${++sequence}`;
    try {
      fs.writeFileSync(candidate, payload, { flag: "wx", mode });
      temporary = candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        // A write that failed after creating the file (e.g. a full disk) leaves no partial temp.
        fs.rmSync(candidate, { force: true });
        throw error;
      }
      if (attempt >= 4) throw error;
    }
  }
  try {
    renameAtomicFile(temporary, filePath);
    try { fs.chmodSync(filePath, mode); } catch {}
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = {
  WINDOWS_RENAME_RETRY_DELAYS_MS,
  renameAtomicFile,
  writePrivateFileAtomic,
};
