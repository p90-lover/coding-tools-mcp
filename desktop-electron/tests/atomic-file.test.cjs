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

test("a fresh temp name that Windows reports as existing is left alone and the write retries", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-atomic-eexist-"));
  const filePath = path.join(directory, "manifest.json");
  const original = fs.writeFileSync;
  const refused = [];
  t.after(() => { fs.writeFileSync = original; fs.rmSync(directory, { recursive: true, force: true }); });
  fs.writeFileSync = function (target, ...rest) {
    if (String(target).includes(".tmp-") && refused.length === 0) {
      original.call(fs, target, "someone else's file");
      refused.push(target);
      throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    }
    return original.call(fs, target, ...rest);
  };
  writePrivateFileAtomic(filePath, "{\"ok\":true}");
  fs.writeFileSync = original;
  assert.equal(fs.readFileSync(filePath, "utf8"), "{\"ok\":true}");
  assert.equal(fs.readFileSync(refused[0], "utf8"), "someone else's file", "a temp this write did not create is not removed");
});

test("a write that fails for another reason leaves no partial temp file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-atomic-enospc-"));
  const filePath = path.join(directory, "state.json");
  const original = fs.writeFileSync;
  t.after(() => { fs.writeFileSync = original; fs.rmSync(directory, { recursive: true, force: true }); });
  fs.writeFileSync = function (target, ...rest) {
    if (String(target).includes(".tmp-")) {
      original.call(fs, target, "partial");
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    return original.call(fs, target, ...rest);
  };
  assert.throws(() => writePrivateFileAtomic(filePath, "{}"), /ENOSPC/);
  fs.writeFileSync = original;
  assert.deepEqual(fs.readdirSync(directory), []);
});
