const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  WINDOWS_RENAME_RETRY_DELAYS_MS,
  renameAtomicFile,
  writePrivateFileAtomic,
} = require("../electron/atomic-file.cjs");

test("atomic replacement retries bounded transient Windows file locks", () => {
  const waits = [];
  let attempts = 0;
  renameAtomicFile("source", "destination", {
    platform: "win32",
    rename() {
      attempts += 1;
      if (attempts < 4) {
        const error = new Error("temporarily locked");
        error.code = attempts === 1 ? "EPERM" : attempts === 2 ? "EACCES" : "EBUSY";
        throw error;
      }
    },
    wait(milliseconds) {
      waits.push(milliseconds);
    },
  });

  assert.equal(attempts, 4);
  assert.deepEqual(waits, WINDOWS_RENAME_RETRY_DELAYS_MS.slice(0, 3));
});

test("atomic replacement fails closed after its bounded Windows retry budget", () => {
  const waits = [];
  let attempts = 0;
  assert.throws(() => renameAtomicFile("source", "destination", {
    platform: "win32",
    rename() {
      attempts += 1;
      const error = new Error("still locked");
      error.code = "EPERM";
      throw error;
    },
    wait(milliseconds) {
      waits.push(milliseconds);
    },
  }), /still locked/);

  assert.equal(attempts, WINDOWS_RENAME_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(waits, WINDOWS_RENAME_RETRY_DELAYS_MS);
});

test("atomic replacement never retries a structural filesystem failure", () => {
  let attempts = 0;
  assert.throws(() => renameAtomicFile("source", "destination", {
    platform: "win32",
    rename() {
      attempts += 1;
      const error = new Error("missing parent");
      error.code = "ENOENT";
      throw error;
    },
    wait() {
      assert.fail("structural errors must not be retried");
    },
  }), /missing parent/);
  assert.equal(attempts, 1);
});

test("private JSON writes UTF-8 without a BOM", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-atomic-utf8-"));
  const filePath = path.join(directory, "provider-network.json");
  writePrivateFileAtomic(filePath, `${JSON.stringify({ ok: true }, null, 2)}\n`);
  const raw = fs.readFileSync(filePath);
  assert.notEqual(raw[0], 0xEF);
  assert.equal(raw.toString("utf8").startsWith("{"), true);
  fs.rmSync(directory, { recursive: true, force: true });
});
