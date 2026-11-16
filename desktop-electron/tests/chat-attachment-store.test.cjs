"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAttachmentStore } = require("../electron/chat-attachment-store.cjs");

test("owned attachment checks reuse unchanged content but force rehash before delivery", t => {
  const parent = path.resolve(__dirname, "../../aiTemp/chat-input-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "blobs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createAttachmentStore(root);
  const saved = store.put({ name: "fixture.txt", bytes: Buffer.from("original") });
  store.verify(saved.blobId, saved.size);
  const read = fs.readSync;
  let reads = 0;
  t.mock.method(fs, "readSync", (...args) => { reads += 1; return read(...args); });
  store.verify(saved.blobId, saved.size);
  assert.equal(reads, 0);
  store.verify(saved.blobId, saved.size, { force: true });
  assert.ok(reads > 0);
  fs.writeFileSync(saved.path, "modified");
  assert.throws(() => store.verify(saved.blobId, saved.size, { force: true }), { code: "ATTACHMENT_CORRUPT" });
});
