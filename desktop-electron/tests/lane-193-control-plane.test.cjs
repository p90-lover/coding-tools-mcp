"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { commandCodeAlternateEndpoint } = require("../electron/external-services.cjs");
const { attachLane193LongRun, WEEK_MS, shouldAbandonLongRun } = require("../electron/paseo-anneal-commandcode-long-run.cjs");
const { preparePaseoAnnealCommandCode } = require("../scripts/prepare-paseo-anneal-commandcode.cjs");

const desktopRoot = path.resolve(__dirname, "..");

test("Windows package:win does not run five-stack-runtime npm generate:validators", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["build:five-stack-runtime"], undefined);
  assert.doesNotMatch(pkg.scripts["package:win"], /five-stack-runtime/);
  assert.match(pkg.scripts["build:package-resources"], /prepare-bundled-runtimes/);
  assert.match(pkg.scripts["build:package-resources"], /prepare-paseo-anneal-commandcode/);
  const prepare = fs.readFileSync(path.join(desktopRoot, "scripts", "prepare-paseo-anneal-commandcode.cjs"), "utf8");
  assert.match(prepare, /npmLifecycleSkipped: true/);
  assert.doesNotMatch(prepare, /npm", \["ci"/);
  assert.doesNotMatch(prepare, /generate:validators/);
  assert.doesNotMatch(prepare, /build:server/);
});

test("CommandCode inspect alternates between 9090 and 3050", () => {
  assert.equal(commandCodeAlternateEndpoint("http://127.0.0.1:9090/"), "http://127.0.0.1:3050/");
  assert.equal(commandCodeAlternateEndpoint("http://127.0.0.1:3050/"), "http://127.0.0.1:9090/");
  assert.equal(commandCodeAlternateEndpoint("http://127.0.0.1:8080/"), null);
});

test("lane 193 long-run never abandons a 7-day session", () => {
  assert.equal(WEEK_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(shouldAbandonLongRun(), false);
  const calls = [];
  const inner = {
    start: async (id) => {
      calls.push(["start", id]);
      return { id, status: "ready" };
    },
    stop: async (id) => {
      calls.push(["stop", id]);
      return { id, status: "offline" };
    },
    restart: async (id) => {
      calls.push(["restart", id]);
      return { id, status: "ready" };
    },
    inspect: async (id) => ({ id, status: "ready" }),
    dispose() {},
  };
  const wrapped = attachLane193LongRun(inner, {
    statePath: path.join(os.tmpdir(), `lane193-longrun-${Date.now()}.json`),
    resumeOnCreate: false,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {},
  });
  return wrapped.start("commandcode-proxy").then((started) => {
    assert.equal(started.status, "ready");
    assert.deepEqual(calls, [["start", "commandcode-proxy"]]);
    const snapshot = wrapped.lane193LongRun();
    assert.equal(snapshot.tools["commandcode-proxy"].desiredRunning, true);
    assert.equal(snapshot.windowMs, WEEK_MS);
    wrapped.dispose();
  });
});

test("prepare-paseo-anneal-commandcode copies vendor CommandCode and skips npm", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane193-prepare-"));
  const outputRoot = path.join(root, "out");
  const cacheRoot = path.join(root, "cache");
  for (const id of ["paseo", "anneal"]) {
    const source = path.join(cacheRoot, id, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({ name: id, private: true })}\n`);
    fs.writeFileSync(path.join(source, ".env.example"), "TOKEN=example\n");
  }
  const spawned = [];
  const result = await preparePaseoAnnealCommandCode({
    outputRoot,
    cacheRoot,
    repositoryRoot: root,
    fetchImpl: async () => {
      throw new Error("prepare must not download when a cache is present");
    },
    spawnSyncProcess: (executable, args) => {
      spawned.push([executable, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(fs.existsSync(path.join(result.outputRoot, "commandcode-proxy", "proxy.mjs")), true);
  assert.equal(fs.existsSync(path.join(result.outputRoot, "commandcode-proxy", ".env.example")), false);
  assert.equal(fs.existsSync(path.join(result.outputRoot, "paseo", "source", "package.json")), true);
  assert.equal(fs.existsSync(path.join(result.outputRoot, "paseo", "source", ".env.example")), false);
  assert.equal(fs.existsSync(path.join(result.outputRoot, "anneal", "source", "package.json")), true);
  assert.equal(fs.existsSync(path.join(result.outputRoot, "anneal", "source", ".env.example")), false);
  assert.equal(spawned.some((entry) => entry.join(" ").includes("npm")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.outputRoot, "MANIFEST.json"), "utf8"));
  assert.equal(manifest.owner, "pr-193");
  assert.equal(manifest.npmLifecycleSkipped, true);
});
