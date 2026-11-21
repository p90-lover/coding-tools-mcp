"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { createCodexCli } = require("../electron/codex-cli.cjs");

const binary = "vendor/x86_64-pc-windows-msvc/bin/codex.exe";
const registry = "https://registry.npmjs.org";
const installerUrl = (version) => `${registry}/@openai/codex/-/codex-${version}-win32-x64.tgz`;
const archive = Buffer.from("synthetic Codex package");

async function setup(t, { version = "0.171.0", digestBytes = archive, unsafe = null, report = version, target = installerUrl(version) } = {}) {
  const scratch = path.resolve(__dirname, "../../aiTemp");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "codex-cli-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const toolsRoot = path.join(root, "tools");
  const appData = path.join(root, "app-data");
  const legacy = path.join(appData, "npm", "node_modules", "@openai", "codex");
  const legacyBin = path.join(legacy, "node_modules", "@openai", "codex-win32-x64", binary);
  await fs.mkdir(path.dirname(legacyBin), { recursive: true });
  await fs.writeFile(legacyBin, "legacy");
  await fs.writeFile(path.join(legacy, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.164.0" }));
  const calls = [], commands = [];
  const options = {
    toolsRoot, platform: "win32", arch: "x64", env: { APPDATA: appData, CODEX_HOME: "do-not-touch" },
    fetchImpl: async (url, request) => {
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers, undefined);
      calls.push(url);
      if (url === `${registry}/@openai%2Fcodex/latest`) return Response.json({ name: "@openai/codex", version,
        optionalDependencies: { "@openai/codex-win32-x64": `npm:@openai/codex@${version}-win32-x64` } });
      if (url === `${registry}/@openai%2Fcodex/${version}-win32-x64`) return Response.json({ name: "@openai/codex",
        version: `${version}-win32-x64`, os: ["win32"], cpu: ["x64"],
        dist: { tarball: target, unpackedSize: archive.length, integrity: `sha512-${crypto.createHash("sha512").update(digestBytes).digest("base64")}` } });
      assert.equal(url, installerUrl(version));
      return new Response(archive);
    },
    run: async (file, args, opts) => {
      commands.push(args[0]);
      assert.equal(opts.env.APPDATA, undefined);
      const entries = [`package/${binary}`, ...(unsafe ? [unsafe] : [])];
      if (args[0] === "-tf") return { stdout: entries.join("\n") };
      if (args[0] === "-tvf") return { stdout: entries.map(() => "-rw-r--r-- 0 root root 42").join("\n") };
      if (args[0] === "-xf") {
        const candidate = path.join(opts.cwd, "package", binary);
        await fs.mkdir(path.dirname(candidate), { recursive: true });
        await fs.writeFile(candidate, "verified");
        return { stdout: "" };
      }
      assert.deepEqual(args, ["--version"]);
      assert.equal(file, path.join(opts.cwd, "package", binary));
      assert.equal(opts.env.CODEX_HOME, path.join(opts.cwd, "probe-home"));
      return { stdout: `codex-cli ${report}\n` };
    },
  };
  return { cli: createCodexCli(options), options, toolsRoot, legacyBin, calls, commands };
}

test("Codex CLI publishes and reloads a verified version without replacing the existing executable", async (t) => {
  const { cli, options, toolsRoot, legacyBin, commands } = await setup(t);
  assert.equal((await cli.status()).version, "0.164.0");
  assert.equal(cli.executable(), null);
  assert.deepEqual(await cli.install(await cli.latest()), { version: "0.171.0", supported: true, managed: true, installing: false });
  assert.deepEqual(commands, ["-tf", "-tvf", "-xf", "--version"]);
  const expected = path.join(toolsRoot, "codex-cli", "0.171.0", binary);
  assert.equal(cli.executable(), expected);
  assert.equal(await fs.readFile(legacyBin, "utf8"), "legacy");
  assert.deepEqual(await fs.readdir(path.join(toolsRoot, "codex-cli")), ["0.171.0"]);
  const loaded = createCodexCli(options);
  await loaded.load();
  assert.equal(loaded.executable(), expected);
});

test("Codex CLI refuses unexpected registry origins, tampering, unsafe entries and failed version checks", async (t) => {
  for (const [fixture, expect, commandCount] of [
    [{ target: "https://example.invalid/codex.tgz" }, /official, checksum-pinned/, 0],
    [{ digestBytes: Buffer.from("other content") }, /checksum did not match/, 0],
    [{ unsafe: "package/../untrusted" }, /unsafe archive path/, 2],
    [{ report: "0.170.0" }, /did not report version/, 4],
  ]) {
    const { cli, commands, toolsRoot, legacyBin } = await setup(t, fixture);
    await assert.rejects(cli.install(await cli.latest()), expect);
    assert.equal(cli.executable(), null);
    assert.equal(commands.length, commandCount);
    assert.equal(await fs.readFile(legacyBin, "utf8"), "legacy");
    assert.deepEqual(await fs.readdir(path.join(toolsRoot, "codex-cli")).catch(() => []), []);
  }
});

test("Codex CLI ignores a prerelease latest tag and refuses an unsupported platform package", async (t) => {
  const { cli, options } = await setup(t, { version: "0.171.0-alpha.1" });
  await assert.rejects(cli.latest(), /stable Codex version/);
  const unsupported = createCodexCli({ ...options, platform: "linux" });
  assert.equal((await unsupported.status()).supported, false);
  await assert.rejects(unsupported.install({ version: "0.171.0", supported: true }), /No supported stable/);
});
