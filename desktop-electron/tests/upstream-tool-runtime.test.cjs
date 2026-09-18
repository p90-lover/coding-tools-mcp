"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createUpstreamToolController,
  normalizeLoopbackEndpoint,
} = require("../electron/upstream-tools.cjs");

const DESKTOP_ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(DESKTOP_ROOT, relativePath), "utf8");
}

test("upstream controller exposes a bounded restart operation", () => {
  const controller = createUpstreamToolController({
    env: {},
    logger: { debug() {} },
  });

  assert.equal(typeof controller.restart, "function");
  assert.throws(
    () => normalizeLoopbackEndpoint("https://example.com/"),
    /restricted to 127\.0\.0\.1 or \[::1\]/,
  );
  assert.equal(
    normalizeLoopbackEndpoint("http://127.0.0.1:6768"),
    "http://127.0.0.1:6768/",
  );

  controller.dispose();
});

test("main, preload, and types retain diagnostic restart while the renderer delegates lifecycle to managed controls", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const types = read("src/types.ts");
  const app = read("src/App.tsx");
  const surface = read("src/features/UpstreamToolSurface.tsx");

  assert.match(main, /launcher:upstream-tool-restart/);
  assert.match(
    main,
    /handle\("launcher:upstream-tool-restart",[\s\S]*?assertFocusedMainWindow\(event, true\);[\s\S]*?upstreamToolController\.restart\(toolId\)/,
  );
  assert.match(main, /upstreamToolController\.openEmbeddedTool\(toolId, section\)/);
  assert.match(main, /upstreamToolController\.openExternalTool\(toolId, section\)/);
  assert.match(main, /upstreamToolController\?\.dispose\(\)/);
  assert.match(
    preload,
    /restartUpstreamTool:\s*\(toolId\)\s*=>\s*ipcRenderer\.invoke\("launcher:upstream-tool-restart", toolId\)/,
  );
  assert.match(types, /restartUpstreamTool\(toolId: UpstreamToolId\)/);
  assert.match(app, /<UpstreamToolSurface/);
  assert.match(surface, /nativeControl/);
  assert.match(surface, /Coding Tools managed connection controls/);
  assert.doesNotMatch(surface, /restartUpstreamTool/);
  assert.doesNotMatch(surface, /startUpstreamTool/);
  assert.doesNotMatch(surface, /stopUpstreamTool/);
});
