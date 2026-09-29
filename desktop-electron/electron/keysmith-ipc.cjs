"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createKeysmithManaged } = require("./keysmith-managed.cjs");

const MAX_MARKDOWN_BYTES = 128 * 1024;

function installKeysmithIpc({
  handle, assertFocusedMainWindow, dialog, mainWindow,
  scriptPath, pythonExecutable, codexDir, createManaged = createKeysmithManaged,
}) {
  let host;
  let selectedFile = null;
  let previewHash = null;
  let removalReady = false;
  let writing = false;
  const managed = () => host ??= createManaged({ scriptPath, pythonExecutable, codexDir });
  const currentWindow = () => typeof mainWindow === "function" ? mainWindow() : mainWindow;

  const confirm = async (message, detail, action) => {
    try {
      const { response } = await dialog.showMessageBox(currentWindow(), {
        type: "warning", title: "Coding Tools", message, detail,
        buttons: ["Cancel", action], defaultId: 0, cancelId: 0, noLink: true,
      });
      return response === 1;
    } catch {
      throw new Error("Keysmith confirmation could not be shown");
    }
  };
  const write = async (action) => {
    if (writing) throw new Error("Another Keysmith change is pending");
    writing = true;
    try { return await action(); }
    finally { writing = false; }
  };

  handle("launcher:keysmith-status", (event) => {
    assertFocusedMainWindow(event, false);
    return managed().status();
  });
  handle("launcher:keysmith-select-file", async (event) => {
    assertFocusedMainWindow(event, true);
    if (writing) throw new Error("Another Keysmith change is pending");
    const choice = await dialog.showOpenDialog(currentWindow(), {
      title: "Choose Codex instructions", properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (choice.canceled || !choice.filePaths?.[0]) return null;
    let file;
    let bytes;
    let content;
    try {
      const chosen = choice.filePaths[0];
      const stat = fs.lstatSync(chosen);
      if (!stat.isFile() || path.extname(chosen).toLowerCase() !== ".md"
        || stat.size === 0 || stat.size > MAX_MARKDOWN_BYTES) throw new Error("invalid");
      file = fs.realpathSync(chosen);
      bytes = fs.readFileSync(file);
      if (bytes.length === 0 || bytes.length > MAX_MARKDOWN_BYTES) throw new Error("invalid");
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Choose a nonempty UTF-8 Markdown file no larger than 128 KiB");
    }
    selectedFile = file;
    previewHash = null;
    removalReady = false;
    return { path: file, name: path.basename(file), content,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  });
  handle("launcher:keysmith-preview", async (event) => {
    assertFocusedMainWindow(event, false);
    if (writing) throw new Error("Another Keysmith change is pending");
    if (!selectedFile) throw new Error("Choose a Markdown file before previewing Keysmith");
    previewHash = null;
    const result = await managed().preview(selectedFile);
    if (result.ok) previewHash = result.fileSha256;
    removalReady = false;
    return result;
  });
  handle("launcher:keysmith-apply", (event) => {
    assertFocusedMainWindow(event, true);
    if (!selectedFile || !previewHash) throw new Error("Preview Keysmith changes before applying");
    return write(async () => {
      const approved = await confirm("Apply Codex Keysmith instructions?",
        `${path.basename(selectedFile)}\nCodex home: ${codexDir}\nChanges the global model_instructions_file setting. Existing hooks stay active. New chats use these instructions.`,
        "Apply instructions");
      if (!approved) return { ok: false, cancelled: true };
      const expectedFileSha256 = previewHash;
      previewHash = null;
      return managed().apply({ instructionFile: selectedFile, confirmed: true, expectedFileSha256 });
    });
  });
  handle("launcher:keysmith-preview-removal", async (event) => {
    assertFocusedMainWindow(event, false);
    if (writing) throw new Error("Another Keysmith change is pending");
    removalReady = false;
    const result = await managed().previewUninstall();
    if (result.ok) removalReady = true;
    previewHash = null;
    return result;
  });
  handle("launcher:keysmith-remove", (event) => {
    assertFocusedMainWindow(event, true);
    if (!removalReady) throw new Error("Preview Keysmith removal before continuing");
    return write(async () => {
      const approved = await confirm("Remove Coding Tools Keysmith instructions?",
        `Codex home: ${codexDir}\nKeysmith will restore its previous instruction setting from its managed backup.`,
        "Remove instructions");
      if (!approved) return { ok: false, cancelled: true };
      removalReady = false;
      return managed().uninstall({ confirmed: true });
    });
  });
}

module.exports = { installKeysmithIpc };
