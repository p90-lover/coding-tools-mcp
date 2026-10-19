"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { saveChatAttachment } = require("../electron/chat-attachments.cjs");

test("a pasted screenshot is saved where the agent can open it, under a dated folder and a safe name", async () => {
  // Seen live: a pasted image was refused ("images need their file path, which isn't available here").
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-attach-"));
  try {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const file = await saveChatAttachment(root, { name: "../../image.png", type: "image/png", bytes: png }, new Date("2026-10-19T13:00:00Z"));
    assert.equal(path.dirname(file), path.join(root, "2026-10-19"), "inside the attachments folder, whatever the name says");
    assert.match(path.basename(file), /^image-[0-9a-f]{8}\.png$/);
    assert.deepEqual([...fs.readFileSync(file)], [...png]);
    const again = await saveChatAttachment(root, { name: "image.png", type: "image/png", bytes: png });
    assert.notEqual(again, file, "two pastes never overwrite each other");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("only kinds a model reads, with content, up to 20 MB, are saved", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-attach-"));
  try {
    await assert.rejects(saveChatAttachment(root, { name: "run.exe", type: "application/x-msdownload", bytes: Uint8Array.of(1) }), /cannot be attached/);
    await assert.rejects(saveChatAttachment(root, { name: "a.png", type: "image/png", bytes: new Uint8Array(0) }), /empty/);
    await assert.rejects(saveChatAttachment(root, { name: "a.png", type: "image/png", bytes: new Uint8Array(20 * 1024 * 1024 + 1) }), /20 MB/);
    const pdf = await saveChatAttachment(root, { name: "", type: "application/pdf", bytes: Uint8Array.of(37, 80) });
    assert.match(path.basename(pdf), /^pasted-[0-9a-f]{8}\.pdf$/, "a nameless clipboard file gets a name of the app's choosing");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
