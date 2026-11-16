"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { LIMITS, fail, identity } = require("./chat-input-schema.cjs");

function createAttachmentStore(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("INPUT_ROOT_REQUIRED", "Choose an absolute attachment data directory");
  const location = hash => {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw fail("INPUT_INVALID", "Attachment identity is invalid");
    return path.join(root, hash.slice(0, 2), hash);
  };
  function inspect(file) {
    const handle = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.size < 1 || stat.size > LIMITS.blob) throw fail("ATTACHMENT_INVALID", "Attachment must be a nonempty file of at most 20 MiB");
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0, count;
      while ((count = fs.readSync(handle, buffer, 0, buffer.length, null))) {
        size += count;
        if (size > LIMITS.blob) throw fail("ATTACHMENT_INVALID", "Attachment exceeds 20 MiB");
        hash.update(buffer.subarray(0, count));
      }
      return { hash: hash.digest("hex"), size };
    } finally { fs.closeSync(handle); }
  }
  function namedPath(hash, name) {
    const original = location(hash);
    let leaf = path.posix.basename(name.replaceAll("\\", "/")).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/, "") || "attachment";
    const extension = path.extname(leaf).slice(0, 16);
    leaf = leaf.slice(0, leaf.length - path.extname(leaf).length).slice(0, 64) + extension;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(leaf)) leaf = `file-${leaf}`;
    const folder = path.join(root, "named", hash.slice(0, 2), hash);
    const target = path.join(folder, leaf);
    const checkLink = () => {
      const a = fs.lstatSync(original, { bigint: true }), b = fs.lstatSync(target, { bigint: true });
      if (!b.isFile() || a.ino !== b.ino || a.dev !== b.dev) throw fail("ATTACHMENT_CORRUPT", "Saved attachment name no longer refers to its owned content");
    };
    try { checkLink(); return target; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    try { fs.linkSync(original, target); }
    catch (error) { if (error.code !== "EEXIST") throw error; checkLink(); }
    if (process.platform !== "win32") {
      const dir = fs.openSync(folder, "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    return target;
  }
  const verified = new Map();
  function verify(hash, expectedSize, { force = false, name } = {}) {
    const file = location(hash), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > LIMITS.blob || expectedSize !== undefined && stat.size !== expectedSize) throw fail("ATTACHMENT_CORRUPT", "Saved attachment failed its integrity check");
    const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    if (force || verified.get(hash) !== stamp) {
      const found = inspect(file);
      if (found.hash !== hash || found.size !== stat.size) throw fail("ATTACHMENT_CORRUPT", "Saved attachment failed its integrity check");
      verified.set(hash, stamp);
      if (verified.size > 2048) verified.delete(verified.keys().next().value);
    }
    return { blobId: hash, size: stat.size, path: name ? namedPath(hash, name) : file };
  }
  function put({ sourcePath, bytes, name, type = "application/octet-stream" }) {
    identity(name, "Attachment name", 1024); identity(type, "Attachment type", 200);
    if ((sourcePath === undefined) === (bytes === undefined)) throw fail("INPUT_INVALID", "Choose exactly one attachment source");
    if (sourcePath !== undefined && (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath))) throw fail("INPUT_INVALID", "Choose an absolute attachment path");
    if (bytes !== undefined && !(bytes instanceof Uint8Array)) throw fail("INPUT_INVALID", "Attachment bytes are invalid");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = path.join(root, `.pending-${randomUUID()}`);
    let source = null, target = null;
    try {
      let before;
      if (sourcePath !== undefined) {
        source = fs.openSync(sourcePath, "r");
        before = fs.fstatSync(source);
        if (!before.isFile() || !before.size || before.size > LIMITS.blob) throw fail("ATTACHMENT_INVALID", "Attachment must be a nonempty file of at most 20 MiB");
      } else if (!bytes.byteLength || bytes.byteLength > LIMITS.blob) throw fail("ATTACHMENT_INVALID", "Attachment must contain 1 byte to 20 MiB");
      target = fs.openSync(temporary, "wx", 0o600);
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      const append = chunk => {
        size += chunk.length;
        if (size > LIMITS.blob) throw fail("ATTACHMENT_INVALID", "Attachment exceeds 20 MiB");
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          const written = fs.writeSync(target, chunk, offset, chunk.length - offset);
          if (!written) throw fail("ATTACHMENT_WRITE_FAILED", "Attachment write made no progress");
          offset += written;
        }
      };
      if (source !== null) {
        let count;
        while ((count = fs.readSync(source, buffer, 0, buffer.length, null))) append(buffer.subarray(0, count));
        const after = fs.fstatSync(source);
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail("ATTACHMENT_CHANGED", "The attachment changed while being saved; attach it again");
      } else append(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      fs.fsyncSync(target);
      fs.closeSync(target); target = null;
      const blobId = hash.digest("hex"), file = location(blobId), folder = path.dirname(file);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      try { fs.linkSync(temporary, file); }
      catch (error) { if (error.code !== "EEXIST") throw error; verify(blobId, size); }
      if (process.platform !== "win32") {
        const dir = fs.openSync(folder, "r");
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
      return { blobId, path: namedPath(blobId, name), size, name, type };
    } finally {
      if (source !== null) fs.closeSync(source);
      if (target !== null) fs.closeSync(target);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return Object.freeze({ put, verify, location });
}

module.exports = { createAttachmentStore };
