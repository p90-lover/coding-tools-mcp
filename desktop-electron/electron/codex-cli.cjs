"use strict";

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");
const { compareVersions } = require("./update.cjs");

const exec = promisify(execFile);
const REGISTRY = "https://registry.npmjs.org";
const PACKAGE = "@openai/codex";
const VERSION = /^\d{1,7}\.\d{1,7}\.\d{1,7}$/u;
const TRIPLES = new Map([["x64", "x86_64-pc-windows-msvc"], ["arm64", "aarch64-pc-windows-msvc"]]);
const MAX_DOWNLOAD = 256 * 1024 * 1024;
const MAX_EXPANDED = 1024 * 1024 * 1024;
const VERSION_ENTRY = /^codex-cli (\d{1,7}\.\d{1,7}\.\d{1,7})$/u;
const isFile = (file) => fs.promises.lstat(file).then((entry) => entry.isFile(), () => false);

function validateArchive(names, details, executable) {
  const lines = (text) => text.split(/\r?\n/u).filter(Boolean);
  const entries = lines(names), types = lines(details);
  if (!entries.includes(`package/${executable}`) || entries.length !== types.length
    || types.some((entry) => !/^[-d]/u.test(entry))) {
    throw new Error("The Codex package is missing its binary or contains an unsupported archive entry");
  }
  const seen = new Set();
  for (const entry of entries) {
    const clean = entry.replace(/\/$/u, "");
    const segments = clean.split("/");
    const key = clean.toLowerCase();
    if (segments[0] !== "package" || seen.has(key) || segments.some((segment) => !/^[\w.-]+$/u.test(segment)
      || segment.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
      throw new Error("The Codex package contains an unsafe archive path");
    }
    seen.add(key);
  }
}

function createCodexCli({ toolsRoot, env = process.env, platform = process.platform, arch = process.arch,
  fetchImpl = fetch, run = exec } = {}) {
  if (!path.isAbsolute(toolsRoot || "")) throw new Error("Codex CLI needs an absolute tools folder");
  const root = path.join(toolsRoot, "codex-cli");
  const triple = platform === "win32" ? TRIPLES.get(arch) : null;
  const binary = `vendor/${triple}/bin/codex.exe`;
  const variant = `win32-${arch}`;
  const systemRoot = env.SystemRoot || "C:\\Windows";
  let managed = null;
  let installing = null;

  async function load() {
    if (!triple) return;
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    const versions = entries.filter((entry) => entry.isDirectory() && VERSION.test(entry.name))
      .map((entry) => entry.name).sort((a, b) => compareVersions(b, a));
    for (const version of versions) {
      const executable = path.join(root, version, binary);
      if (await isFile(executable)) {
        // `load` can finish during an installation; never replace a just-published newer path.
        if (!managed || compareVersions(version, managed.version) > 0) managed = { version, executable };
        return;
      }
    }
  }

  async function status() {
    const base = { supported: Boolean(triple), version: null, managed: false, installing: Boolean(installing) };
    if (managed) return { ...base, managed: true, version: managed.version };
    if (!triple || !env.APPDATA || !path.isAbsolute(env.APPDATA)) return base;
    const modules = path.join(env.APPDATA, "npm", "node_modules");
    const npmRoot = path.join(modules, "@openai", "codex");
    const native = path.join("@openai", `codex-${variant}`, binary);
    if (!await isFile(path.join(npmRoot, "node_modules", native)) && !await isFile(path.join(modules, native))) return base;
    try {
      const pkg = JSON.parse(await fs.promises.readFile(path.join(npmRoot, "package.json"), "utf8"));
      return pkg.name === PACKAGE && VERSION.test(pkg.version) ? { ...base, version: pkg.version } : base;
    } catch { return base; }
  }

  async function registry(url, timeout) {
    const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`The Codex npm registry returned HTTP ${response.status}`);
    return response;
  }

  async function latest() {
    const manifest = await (await registry(`${REGISTRY}/@openai%2Fcodex/latest`, 20_000)).json();
    const version = manifest?.version;
    if (manifest?.name !== PACKAGE || !VERSION.test(version)) throw new Error("npm did not return a stable Codex version");
    return { version, url: `https://github.com/openai/codex/releases/tag/rust-v${version}`,
      supported: Boolean(triple && manifest.optionalDependencies?.[`@openai/codex-${variant}`] === `npm:${PACKAGE}@${version}-${variant}`) };
  }

  async function stageAndPublish(version) {
    const exact = `${version}-${variant}`;
    const url = `${REGISTRY}/${PACKAGE}/-/codex-${exact}.tgz`;
    const metadata = await (await registry(`${REGISTRY}/@openai%2Fcodex/${exact}`, 20_000)).json();
    const { tarball, integrity, unpackedSize } = metadata?.dist || {};
    if (metadata?.name !== PACKAGE || metadata.version !== exact || metadata.os?.join() !== "win32" || metadata.cpu?.join() !== arch
      || tarball !== url || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)
      || !Number.isSafeInteger(unpackedSize) || unpackedSize <= 0 || unpackedSize > MAX_EXPANDED) {
      throw new Error("npm did not return an official, checksum-pinned Codex package for this Windows build");
    }
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const disk = await fs.promises.statfs(root);
    if (disk.bavail * disk.bsize < unpackedSize + MAX_DOWNLOAD) throw new Error("Not enough space to stage the Codex CLI update");
    const staging = await fs.promises.mkdtemp(path.join(root, ".stage-"));
    try {
      const archive = path.join(staging, "package.tgz");
      const response = await registry(url, 10 * 60_000);
      if (!response.body) throw new Error("The Codex package has no body");
      const hash = crypto.createHash("sha512");
      let size = 0;
      async function* checksum(source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > MAX_DOWNLOAD) throw new Error("The Codex package exceeds the download limit");
          hash.update(chunk);
          yield chunk;
        }
      }
      await pipeline(checksum(response.body), fs.createWriteStream(archive, { flags: "wx", mode: 0o600 }));
      if (`sha512-${hash.digest("base64")}` !== integrity) throw new Error("The Codex package checksum did not match npm");

      const options = { cwd: staging, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 90_000,
        env: { SystemRoot: systemRoot, TEMP: staging, TMP: staging, CODEX_HOME: path.join(staging, "probe-home") } };
      const tar = path.join(systemRoot, "System32", "tar.exe");
      const names = await run(tar, ["-tf", archive], options);
      const details = await run(tar, ["-tvf", archive], options);
      validateArchive(names.stdout, details.stdout, binary);
      await run(tar, ["-xf", archive, "-C", staging], options);
      const candidate = path.join(staging, "package", binary);
      if (!await isFile(candidate)) throw new Error("The verified Codex package did not unpack its executable");
      const actual = VERSION_ENTRY.exec((await run(candidate, ["--version"], { ...options, timeout: 10_000 })).stdout.trim())?.[1];
      if (actual !== version) throw new Error(`The checked Codex binary did not report version ${version}`);
      const destination = path.join(root, version);
      await fs.promises.rename(path.join(staging, "package"), destination);
      managed = { version, executable: path.join(destination, binary) };
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function install(release) {
    if (!triple || release?.supported !== true || !VERSION.test(release.version)) throw new Error("No supported stable Codex build to install");
    if (installing) throw new Error("A Codex update is already running");
    installing = (async () => {
      const { version } = await status();
      if (!version || compareVersions(release.version, version) > 0) await stageAndPublish(release.version);
    })();
    try { await installing; } finally { installing = null; }
    return status();
  }

  return { load, status, latest, install, executable: () => managed?.executable ?? null };
}

module.exports = { createCodexCli };
