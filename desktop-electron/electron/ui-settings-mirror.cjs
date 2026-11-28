"use strict";

// A copy of the window's own localStorage settings (split view, chat pages, projects, sections,
// toolbar, terminal, last chat route, response style and the rest) in userData, so a reset store
// gives them back. On 2026-11-27 Bitdefender quarantined two files of Local Storage\leveldb;
// Chromium found the store damaged, started an empty one, and every setting was gone.
// The page (src/ui-settings-mirror.ts) sends the app's keys; this keeps them and hands them back.

const fs = require("node:fs");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

const MIRROR_FILE = "ui-settings-mirror.json";
const LOAD_CHANNEL = "launcher:ui-settings-load";
const SAVE_CHANNEL = "launcher:ui-settings-save";
const MAX_KEY_LENGTH = 512;
const MAX_VALUE_LENGTH = 256 * 1024;
const MAX_TOTAL_LENGTH = 2 * 1024 * 1024;

// The same rule as src/ui-settings-mirror.ts (a test keeps the two equal): the app's own keys, and
// never one whose name says it holds a secret.
const MIRRORED_PREFIXES = ["coding-tools:", "coding-tools-", "native-codex:", "email.read."];
const MIRRORED_KEYS = new Set(["cdx-image-toolbar-position"]);
const SECRET_WORDS = /secret|token|passw|credential|api[-_]?key|cookie|bearer|private[-_]?key/i;

function isMirroredUiKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH
    && (MIRRORED_KEYS.has(key) || MIRRORED_PREFIXES.some((prefix) => key.startsWith(prefix)))
    && !SECRET_WORDS.test(key);
}

/** The entries worth keeping, sorted by key; null when the copy is not an object or is too big. */
function cleanEntries(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const entries = {};
  let total = 0;
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (!isMirroredUiKey(key) || typeof value !== "string" || value.length > MAX_VALUE_LENGTH) continue;
    total += key.length + value.length;
    if (total > MAX_TOTAL_LENGTH) return null;
    entries[key] = value;
  }
  return entries;
}

/** The entries of a mirror file's text; null when it is not a mirror (damaged or another format). */
function parseMirror(text) {
  try {
    const saved = JSON.parse(String(text).replace(/^\uFEFF/, ""));
    if (!saved || saved.version !== 1) return null;
    return cleanEntries(saved.entries);
  } catch {
    return null;
  }
}

function createUiSettingsMirror({
  filePath,
  logger = null,
  writeFile = writePrivateFileAtomicAsync,
  readFileSync = fs.readFileSync,
  readFile = fs.promises.readFile,
  now = () => new Date(),
} = {}) {
  if (typeof filePath !== "string" || !filePath) throw new Error("The UI settings mirror needs a file path");
  // The entries on disk as JSON: undefined until known, null when there is no usable file.
  let written;
  let latest = null;
  let saving = null;
  let saveAgain = false;

  /**
   * The mirror for a page whose store came back empty. Called through sendSync, so it reads the
   * small file synchronously; the page asks only when its store has none of the app's keys.
   */
  function load() {
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        written = null;
        return { ok: true, entries: null };
      }
      // Busy or refused (an antivirus scan holding it): the page leaves the old copy alone.
      logger?.warn?.("launcher.ui_settings_mirror_read_failed", { code: error?.code ?? "unknown" });
      return { ok: false, reason: "unreadable" };
    }
    const entries = parseMirror(text);
    if (!entries) {
      // Not a copy at all, so nothing is lost by replacing it on the next change.
      logger?.warn?.("launcher.ui_settings_mirror_damaged", { bytes: text.length });
      written = null;
      return { ok: true, entries: null, damaged: true };
    }
    written = JSON.stringify(entries);
    logger?.info?.("launcher.ui_settings_mirror_loaded", { keys: Object.keys(entries).length });
    return { ok: true, entries };
  }

  async function known() {
    if (written !== undefined) return written;
    try {
      const entries = parseMirror(await readFile(filePath, "utf8"));
      written = entries ? JSON.stringify(entries) : null;
    } catch {
      written = null;
    }
    return written;
  }

  function persist() {
    if (saving) {
      saveAgain = true;
      return;
    }
    saving = (async () => {
      const text = latest;
      if (text === null || text === await known()) return;
      const file = { version: 1, savedAt: now().toISOString(), entries: JSON.parse(text) };
      await writeFile(filePath, `${JSON.stringify(file, null, 1)}\n`, { protectDirectory: false });
      written = text;
    })()
      .catch((error) => {
        logger?.warn?.("launcher.ui_settings_mirror_write_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        saving = null;
        if (saveAgain) {
          saveAgain = false;
          persist();
        }
      });
  }

  /** Keeps the page's app keys; the same entries as on disk are not written again. */
  function save(input) {
    const entries = cleanEntries(input);
    if (!entries) {
      logger?.warn?.("launcher.ui_settings_mirror_refused", { reason: "shape or size" });
      return false;
    }
    latest = JSON.stringify(entries);
    persist();
    return true;
  }

  /** Resolves once the writes asked for so far are on disk (tests, and anything that must wait). */
  async function saved() {
    while (saving) await saving;
  }

  return { load, save, saved };
}

/**
 * The two channels, registered with the minimal pre-renderer IPC so the page's synchronous load
 * always has a handler: a sendSync nobody answers leaves the window frozen. `isAppFrame` admits only
 * the main window's own top frame.
 */
function installUiSettingsMirrorIpc({ ipcMain, mirror, isAppFrame, logger = null }) {
  ipcMain.on(LOAD_CHANNEL, (event) => {
    let reply = { ok: false, reason: "refused" };
    try {
      if (isAppFrame(event)) reply = mirror().load();
    } catch (error) {
      reply = { ok: false, reason: "failed" };
      logger?.warn?.("launcher.ui_settings_mirror_load_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      event.returnValue = reply;
    }
  });
  ipcMain.on(SAVE_CHANNEL, (event, entries) => {
    try {
      if (isAppFrame(event)) mirror().save(entries);
    } catch (error) {
      logger?.warn?.("launcher.ui_settings_mirror_save_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return [LOAD_CHANNEL, SAVE_CHANNEL];
}

module.exports = {
  LOAD_CHANNEL,
  MAX_TOTAL_LENGTH,
  MAX_VALUE_LENGTH,
  MIRROR_FILE,
  SAVE_CHANNEL,
  cleanEntries,
  createUiSettingsMirror,
  installUiSettingsMirrorIpc,
  isMirroredUiKey,
};
