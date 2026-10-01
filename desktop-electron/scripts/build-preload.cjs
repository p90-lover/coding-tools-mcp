"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildSync } = require("esbuild");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "build", "preload.cjs");
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [path.join(root, "electron", "preload.cjs")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  legalComments: "none",
  logLevel: "silent",
});
process.stdout.write(`PRELOAD_BUILT ${output}\n`);
