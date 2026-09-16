"use strict";

const path = require("node:path");

function artifactNameFor({ template, version, os, arch, extension }) {
  if (typeof template !== "string" || template.length === 0) {
    throw new Error("Electron Builder artifactName is missing from package.json");
  }
  for (const [label, value] of [["version", version], ["os", os], ["arch", arch], ["extension", extension]]) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Artifact ${label} is required`);
  }
  const resolved = template
    .replaceAll("${version}", version)
    .replaceAll("${os}", os)
    .replaceAll("${arch}", arch)
    .replaceAll("${ext}", extension);
  if (/\$\{[^}]+\}/.test(resolved) || path.basename(resolved) !== resolved) {
    throw new Error(`Unsupported Electron Builder artifactName template: ${template}`);
  }
  return resolved;
}

function macBundlePaths({ stage, productName }) {
  if (typeof stage !== "string" || !stage) throw new Error("macOS smoke stage is required");
  if (typeof productName !== "string" || !productName) throw new Error("Electron productName is required");
  const appBundle = path.join(stage, `${productName}.app`);
  return {
    appBundle,
    executable: path.join(appBundle, "Contents", "MacOS", productName),
  };
}

module.exports = { artifactNameFor, macBundlePaths };
