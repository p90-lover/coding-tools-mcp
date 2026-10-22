"use strict";

// Every folder a test file makes in the system temp directory is removed when that file's process
// ends, passed or failed. Left behind, each run added folders to %TEMP% (on the SSD): by 2026-10-22
// there were 317 ct-exe-digest-*, 295 cpa-plugin-models-*, 215 persistent-bridge-* and more, from
// 154 mkdtempSync calls in 43 test files. Required once at the top of a test file; its own calls are
// unchanged. A folder still held by a process the test started is left (Windows refuses to delete
// it); the rest go.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!fs.mkdtempSync.__tempDirsTracked) {
  const made = new Set();
  const temp = path.resolve(os.tmpdir()).toLowerCase();
  const original = fs.mkdtempSync;
  const tracked = function mkdtempSync(prefix, options) {
    const dir = original.call(fs, prefix, options);
    if (typeof dir === "string" && path.resolve(dir).toLowerCase().startsWith(temp + path.sep)) made.add(dir);
    return dir;
  };
  tracked.__tempDirsTracked = true;
  fs.mkdtempSync = tracked;
  process.on("exit", () => {
    for (const dir of made) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); } catch { /* still in use */ }
    }
  });
}
