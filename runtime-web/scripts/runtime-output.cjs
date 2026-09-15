"use strict";

const fs = require("node:fs");
const path = require("node:path");

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function existingOutputError(target, fsImpl) {
  let metadata;
  try {
    metadata = fsImpl.lstatSync(target);
  } catch (error) {
    fail(
      "RUNTIME_BUNDLE_OUTPUT_INSPECTION_FAILED",
      `${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (metadata.isSymbolicLink()) {
    fail("RUNTIME_BUNDLE_OUTPUT_SYMLINK_REJECTED", target);
  }
  fail("RUNTIME_BUNDLE_OUTPUT_ALREADY_EXISTS", target);
}

function prepareFreshRuntimeOutput(output, { fsImpl = fs, pathImpl = path } = {}) {
  if (typeof output !== "string" || !output.trim()) {
    fail("RUNTIME_BUNDLE_OUTPUT_INVALID", JSON.stringify(output));
  }
  const target = pathImpl.resolve(output);
  if (target === pathImpl.parse(target).root) {
    fail("RUNTIME_BUNDLE_OUTPUT_ROOT_REJECTED", target);
  }
  if (fsImpl.existsSync(target)) existingOutputError(target, fsImpl);

  fsImpl.mkdirSync(pathImpl.dirname(target), { recursive: true });
  try {
    fsImpl.mkdirSync(target);
  } catch (error) {
    if (fsImpl.existsSync(target)) existingOutputError(target, fsImpl);
    fail(
      "RUNTIME_BUNDLE_OUTPUT_CREATE_FAILED",
      `${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return target;
}

module.exports = { prepareFreshRuntimeOutput };
