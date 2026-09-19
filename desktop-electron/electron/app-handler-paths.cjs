"use strict";

const fs = require("node:fs");
const path = require("node:path");

function resolveAppHandlerRoot() {
  const candidates = [
    path.join(__dirname, "..", "app-handler"),
    path.join(__dirname, "..", "..", "app-handler"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "host.cjs"))) return candidate;
  }
  throw new Error("Coding Tools app-handler root is missing");
}

function requireAppHandler(relativePath) {
  return require(path.join(resolveAppHandlerRoot(), relativePath));
}

module.exports = {
  resolveAppHandlerRoot,
  requireAppHandler,
};
