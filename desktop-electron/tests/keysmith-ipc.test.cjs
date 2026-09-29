"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("only the focused main window can approve a previewed Keysmith change", async (t) => {
  const modulePath = path.join(__dirname, "../electron/keysmith-ipc.cjs");
  assert.ok(fs.existsSync(modulePath), "Keysmith IPC boundary is missing");
  const { installKeysmithIpc } = require(modulePath);
  const tmp = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/keysmith-setup/ipc-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const markdown = path.join(tmp, "reviewed.md");
  fs.writeFileSync(markdown, "# Reviewed instructions\nBe clear.\n");

  const handlers = new Map();
  const focusChecks = [];
  const calls = [];
  let confirmation = 0;
  const host = {
    status: async () => ({ ok: true, installed: false, managedByCodingTools: false }),
    preview: async (file) => {
      calls.push(["preview", file]);
      return { ok: true, stdout: "preview ready", fileSha256: "reviewed-hash" };
    },
    apply: async (args) => {
      calls.push(["apply", args]);
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    previewUninstall: async () => ({ ok: true, stdout: "removal plan" }),
    uninstall: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
  };
  installKeysmithIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    assertFocusedMainWindow: (_event, write) => focusChecks.push(write),
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [markdown] }),
      showMessageBox: async () => ({ response: confirmation }),
    },
    mainWindow: {},
    scriptPath: path.join(__dirname, "../assets/keysmith/codex-instruct-v0.6.0.py"),
    codexDir: tmp,
    pythonExecutable: "python",
    createManaged: () => host,
  });

  const event = { sender: "main-window" };
  assert.throws(() => handlers.get("launcher:keysmith-apply")(event), /preview/i);
  const selected = await handlers.get("launcher:keysmith-select-file")(event);
  assert.equal(selected.path, fs.realpathSync(markdown));
  assert.match(selected.content, /Reviewed instructions/);
  assert.equal((await handlers.get("launcher:keysmith-preview")(event)).ok, true);
  const cancelled = await handlers.get("launcher:keysmith-apply")(event);
  assert.equal(cancelled.cancelled, true);
  assert.equal(calls.filter(([name]) => name === "apply").length, 0);

  confirmation = 1;
  assert.equal((await handlers.get("launcher:keysmith-apply")(event)).ok, true);
  assert.equal(calls.filter(([name]) => name === "apply").length, 1);
  assert.deepEqual(calls.at(-1)[1], {
    instructionFile: fs.realpathSync(markdown),
    confirmed: true,
    expectedFileSha256: "reviewed-hash",
  });
  assert.deepEqual(focusChecks, [true, true, false, true, true]);
});

test("removal requires a fresh preview and a separate native confirmation", async () => {
  const modulePath = path.join(__dirname, "../electron/keysmith-ipc.cjs");
  assert.ok(fs.existsSync(modulePath), "Keysmith removal boundary is missing");
  const { installKeysmithIpc } = require(modulePath);
  const handlers = new Map();
  const calls = [];
  let confirmation = 0;
  installKeysmithIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    assertFocusedMainWindow() {},
    dialog: { showMessageBox: async () => ({ response: confirmation }) },
    mainWindow: {},
    scriptPath: path.join(__dirname, "../assets/keysmith/codex-instruct-v0.6.0.py"),
    codexDir: __dirname,
    pythonExecutable: "python",
    createManaged: () => ({
      previewUninstall: async () => { calls.push("preview"); return { ok: true, stdout: "removal plan" }; },
      uninstall: async (input) => { calls.push(input); return { ok: true }; },
    }),
  });

  const event = { sender: "main-window" };
  assert.throws(() => handlers.get("launcher:keysmith-remove")(event), /preview/i);
  assert.equal((await handlers.get("launcher:keysmith-preview-removal")(event)).ok, true);
  assert.equal((await handlers.get("launcher:keysmith-remove")(event)).cancelled, true);
  assert.deepEqual(calls, ["preview"]);
  confirmation = 1;
  assert.equal((await handlers.get("launcher:keysmith-remove")(event)).ok, true);
  assert.deepEqual(calls, ["preview", { confirmed: true }]);
  assert.throws(() => handlers.get("launcher:keysmith-remove")(event), /preview/i);
});
