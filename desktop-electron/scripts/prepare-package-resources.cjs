"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PRODUCT_VERSION = "0.6.0-rc.1";
const PRODUCT_NAME = "Coding Tools";
const APP_ID = "dev.codingtools.fullharness";
const SOURCE_REPOSITORY = "p90-lover/coding-tools-mcp";
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const UPSTREAM = Object.freeze({
  repository: "miuuyy/codex-chatgpt-web",
  version: "v5.0.6",
  commit: "e85e3693fdb4e3e033348c08df0298c20fcdb612",
});
const TUNNEL_VERSION = "0.0.12";
const STABLE_ROLLBACK = Object.freeze({
  schema: 1,
  stableVersion: "0.4.10",
  mode: "reference",
  releaseTag: "v0.4.10",
  assetName: "Coding.Tools.MCP_0.4.10_x64-setup.exe",
  size: 6461938,
  sha256: "3c3f60262672556ae113a8cccbc671e7b559bb7106392333cd4a0628471427d1",
});
const SUPPORTED_PLATFORMS = new Set(["win32", "linux", "darwin"]);
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeSegment(value, fallback = "item") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("PACKAGE_RESOURCE_TIME_INVALID", String(value));
  return date.toISOString().replace(/[:.]/g, "-");
}

function assertInside(root, candidate, label, { allowRoot = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if ((!allowRoot && relative === "")
      || relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    fail("PACKAGE_RESOURCE_PATH_OUTSIDE_ROOT", `${label}: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

function regularFile(filePath, label) {
  const resolved = path.resolve(filePath);
  let metadata;
  try {
    metadata = fs.lstatSync(resolved);
  } catch {
    fail("PACKAGE_RESOURCE_INPUT_MISSING", `${label}: ${resolved}`);
  }
  if (metadata.isSymbolicLink()) fail("PACKAGE_RESOURCE_SYMLINK_FORBIDDEN", `${label}: ${resolved}`);
  if (!metadata.isFile()) fail("PACKAGE_RESOURCE_INPUT_NOT_FILE", `${label}: ${resolved}`);
  return { path: resolved, metadata };
}

function regularDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath);
  let metadata;
  try {
    metadata = fs.lstatSync(resolved);
  } catch {
    fail("PACKAGE_RESOURCE_INPUT_MISSING", `${label}: ${resolved}`);
  }
  if (metadata.isSymbolicLink()) fail("PACKAGE_RESOURCE_SYMLINK_FORBIDDEN", `${label}: ${resolved}`);
  if (!metadata.isDirectory()) fail("PACKAGE_RESOURCE_INPUT_NOT_DIRECTORY", `${label}: ${resolved}`);
  return resolved;
}

function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(code, `${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function copyTree(sourcePath, destinationPath) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  const metadata = fs.lstatSync(source);
  if (metadata.isSymbolicLink()) fail("PACKAGE_RESOURCE_SYMLINK_FORBIDDEN", source);
  if (metadata.isDirectory()) {
    fs.mkdirSync(destination, { recursive: false, mode: metadata.mode & 0o777 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
      copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (!metadata.isFile()) fail("PACKAGE_RESOURCE_ENTRY_UNSUPPORTED", source);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, metadata.mode & 0o777);
}

function executableName(baseName, platform) {
  return platform === "win32" ? `${baseName}.exe` : baseName;
}

function binaryFormat(bytes, platform) {
  if (platform === "win32") return bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "MZ";
  if (platform === "linux") return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  if (platform === "darwin") {
    if (bytes.length < 4) return false;
    const magic = bytes.subarray(0, 4).toString("hex");
    return new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "cafebabf"]).has(magic);
  }
  return false;
}

function validateBinary(filePath, label, platform) {
  const input = regularFile(filePath, label);
  const bytes = fs.readFileSync(input.path);
  if (!binaryFormat(bytes, platform)) {
    fail("PACKAGE_RESOURCE_BINARY_FORMAT_MISMATCH", `${label}: ${platform}`);
  }
  return input.path;
}

function validatePlatform(platform, arch) {
  if (!SUPPORTED_PLATFORMS.has(platform)) fail("PACKAGE_RESOURCE_PLATFORM_UNSUPPORTED", platform);
  if (!SUPPORTED_ARCHES.has(arch)) fail("PACKAGE_RESOURCE_ARCH_UNSUPPORTED", arch);
}

function resolveSourceSha(repositoryRoot, explicit) {
  const requested = String(explicit || process.env.SOURCE_SHA || process.env.GITHUB_SHA || "").trim().toLowerCase();
  if (requested) {
    if (!SOURCE_SHA.test(requested)) fail("PACKAGE_RESOURCE_SOURCE_SHA_INVALID", requested);
    return requested;
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const discovered = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
  if (!SOURCE_SHA.test(discovered)) fail("PACKAGE_RESOURCE_SOURCE_SHA_INVALID", discovered || "missing");
  return discovered;
}

function firstExisting(candidates, label) {
  for (const candidate of candidates.filter(Boolean)) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return regularFile(resolved, label).path;
  }
  fail("PACKAGE_RESOURCE_INPUT_MISSING", `${label}: ${candidates.filter(Boolean).map((entry) => path.resolve(entry)).join(", ") || "no candidates"}`);
}

function defaultHeadlessCandidates(repositoryRoot, platform) {
  const name = executableName("coding-tools-headless", platform);
  return [
    process.env.CODING_TOOLS_HEADLESS_BINARY,
    process.env.CARGO_TARGET_DIR && path.join(process.env.CARGO_TARGET_DIR, "release", name),
    path.join(repositoryRoot, "rust-core", "coding-tools-headless", "target", "release", name),
    path.join(repositoryRoot, "rust-core", "target", "release", name),
    path.join(repositoryRoot, "target", "release", name),
    path.join(repositoryRoot, "aiTemp", "input", name),
  ];
}

function defaultTunnelCandidates(repositoryRoot, platform, arch) {
  const name = executableName("tunnel-client", platform);
  return [
    process.env.CODING_TOOLS_TUNNEL_CLIENT,
    path.join(repositoryRoot, "third_party", "tunnel-client", TUNNEL_VERSION, `${platform}-${arch}`, name),
    path.join(repositoryRoot, "third_party", "tunnel-client", TUNNEL_VERSION, name),
    path.join(repositoryRoot, "aiTemp", "input", "tunnel-client", TUNNEL_VERSION, `${platform}-${arch}`, name),
  ];
}

function validateRuntime(runtimeRoot, platform, arch) {
  const root = regularDirectory(runtimeRoot, "runtime");
  const manifestPath = regularFile(path.join(root, "manifest.json"), "runtime manifest").path;
  const manifest = readJson(manifestPath, "PACKAGE_RESOURCE_RUNTIME_MANIFEST_INVALID");
  if (manifest?.schemaVersion !== 2
      || manifest?.appVersion !== PRODUCT_VERSION
      || manifest?.platform !== platform
      || manifest?.arch !== arch) {
    fail("PACKAGE_RESOURCE_RUNTIME_IDENTITY_MISMATCH", JSON.stringify({
      schemaVersion: manifest?.schemaVersion,
      appVersion: manifest?.appVersion,
      platform: manifest?.platform,
      arch: manifest?.arch,
    }));
  }
  regularFile(path.join(root, "THIRD_PARTY_NOTICES.txt"), "runtime third-party notices");
  return { root, manifest };
}

function componentPaths(platform) {
  return Object.freeze({
    "migration-manifest": "migration/manifest.json",
    "rollback-manifest": "rollback/manifest.json",
    "runtime-manifest": "runtime/manifest.json",
    "rust-headless": `coding-tools/${executableName("coding-tools-headless", platform)}`,
    "third-party-notices": "coding-tools/THIRD_PARTY_NOTICES.md",
    "tunnel-client": `native/${executableName("tunnel-client", platform)}`,
  });
}

function componentVersions() {
  return Object.freeze({
    "migration-manifest": PRODUCT_VERSION,
    "rollback-manifest": "0.4.10",
    "runtime-manifest": PRODUCT_VERSION,
    "rust-headless": PRODUCT_VERSION,
    "third-party-notices": PRODUCT_VERSION,
    "tunnel-client": TUNNEL_VERSION,
  });
}

function combinedNotices(noticesPath, runtimeRoot) {
  const integrationNotices = fs.readFileSync(regularFile(noticesPath, "repository third-party notices").path, "utf8").trim();
  const runtimeNotices = fs.readFileSync(
    regularFile(path.join(runtimeRoot, "THIRD_PARTY_NOTICES.txt"), "runtime third-party notices").path,
    "utf8",
  ).trim();
  const combined = [
    "# Coding Tools combined third-party notices",
    "",
    "## Coding Tools integration notices",
    "",
    integrationNotices,
    "",
    "## Pinned codex-chatgpt-web runtime notices",
    "",
    runtimeNotices,
    "",
  ].join("\n");
  for (const marker of ["codex-chatgpt-web", "MIT", "Apache-2.0"]) {
    if (!combined.includes(marker)) fail("PACKAGE_RESOURCE_NOTICES_INCOMPLETE", marker);
  }
  return combined;
}

function createRetentionSession({ repositoryRoot, label, now = () => new Date(), nonce = () => crypto.randomBytes(6).toString("hex") }) {
  const root = path.resolve(repositoryRoot);
  const aiTempRoot = path.join(root, "aiTemp");
  const sessionId = `${timestamp(now())}-${process.pid}-${safeSegment(nonce(), "nonce")}-${safeSegment(label)}`;
  const workParent = path.join(aiTempRoot, "work", safeSegment(label));
  const trashRoot = path.join(aiTempRoot, "Trash", safeSegment(label), sessionId);
  fs.mkdirSync(workParent, { recursive: true, mode: 0o700 });
  const workRoot = fs.mkdtempSync(path.join(workParent, "session-"));
  assertInside(aiTempRoot, workRoot, "work root");

  function uniqueTrashPath(category, baseName) {
    const categoryRoot = path.join(trashRoot, safeSegment(category));
    fs.mkdirSync(categoryRoot, { recursive: true, mode: 0o700 });
    const parsed = path.parse(safeSegment(baseName));
    let candidate = path.join(categoryRoot, `${parsed.name}${parsed.ext}`);
    let suffix = 2;
    while (fs.existsSync(candidate)) {
      candidate = path.join(categoryRoot, `${parsed.name}-${suffix}${parsed.ext}`);
      suffix += 1;
    }
    return candidate;
  }

  function preservePath(sourcePath, category = "preserved") {
    const source = assertInside(root, sourcePath, "preserved path");
    if (!fs.existsSync(source)) return null;
    const destination = uniqueTrashPath(category, path.basename(source));
    fs.renameSync(source, destination);
    return destination;
  }

  function publishDirectory(preparedPath, targetPath, category = "prior-output") {
    const prepared = assertInside(aiTempRoot, preparedPath, "prepared directory");
    const target = assertInside(root, targetPath, "output directory");
    regularDirectory(prepared, "prepared package resources");
    let preservedPath = null;
    if (fs.existsSync(target)) preservedPath = preservePath(target, category);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(prepared, target);
    } catch (publicationError) {
      let restorationError = null;
      if (preservedPath && !fs.existsSync(target)) {
        try {
          fs.renameSync(preservedPath, target);
          preservedPath = null;
        } catch (error) {
          restorationError = error;
        }
      }
      const failure = new Error(`PACKAGE_RESOURCE_PUBLICATION_FAILED: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`);
      failure.cause = restorationError
        ? new AggregateError([publicationError, restorationError], "Publication and restoration both failed")
        : publicationError;
      throw failure;
    }
    return preservedPath;
  }

  return { aiTempRoot, workRoot, trashRoot, preservePath, publishDirectory };
}

function writeComponent(stagingRoot, relativePath, bytes) {
  const target = path.join(stagingRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  return target;
}

function preparePackageResources(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, "..", ".."));
  const desktopRoot = path.resolve(options.desktopRoot || path.join(repositoryRoot, "desktop-electron"));
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(desktopRoot, "build", "runtime"));
  const outputRoot = path.resolve(options.outputRoot || path.join(desktopRoot, "build", "package-resources"));
  const platform = String(options.platform || process.env.CODING_TOOLS_PACKAGE_PLATFORM || process.platform);
  const arch = String(options.arch || process.env.CODING_TOOLS_PACKAGE_ARCH || process.arch);
  validatePlatform(platform, arch);
  assertInside(repositoryRoot, desktopRoot, "desktop root", { allowRoot: true });
  assertInside(repositoryRoot, outputRoot, "package resource output");

  const sourceSha = resolveSourceSha(repositoryRoot, options.sourceSha);
  const runtime = validateRuntime(runtimeRoot, platform, arch);
  const headlessSource = validateBinary(
    options.headlessBinary || firstExisting(defaultHeadlessCandidates(repositoryRoot, platform), "coding-tools-headless"),
    "coding-tools-headless",
    platform,
  );
  const tunnelSource = validateBinary(
    options.tunnelBinary || firstExisting(defaultTunnelCandidates(repositoryRoot, platform, arch), "tunnel-client"),
    "tunnel-client",
    platform,
  );
  const noticesPath = path.resolve(
    options.noticesPath
      || process.env.CODING_TOOLS_THIRD_PARTY_NOTICES
      || path.join(repositoryRoot, "third_party", "THIRD_PARTY_NOTICES.md"),
  );
  const notices = combinedNotices(noticesPath, runtime.root);
  const paths = componentPaths(platform);
  const versions = componentVersions();
  const session = createRetentionSession({
    repositoryRoot,
    label: "package-resources",
    now: options.now,
    nonce: options.nonce,
  });
  const stagingRoot = path.join(session.workRoot, "payload");
  fs.mkdirSync(stagingRoot, { recursive: false, mode: 0o700 });

  try {
    copyTree(runtime.root, path.join(stagingRoot, "runtime"));
    fs.mkdirSync(path.dirname(path.join(stagingRoot, ...paths["rust-headless"].split("/"))), { recursive: true, mode: 0o700 });
    fs.copyFileSync(headlessSource, path.join(stagingRoot, ...paths["rust-headless"].split("/")), fs.constants.COPYFILE_EXCL);
    fs.mkdirSync(path.dirname(path.join(stagingRoot, ...paths["tunnel-client"].split("/"))), { recursive: true, mode: 0o700 });
    fs.copyFileSync(tunnelSource, path.join(stagingRoot, ...paths["tunnel-client"].split("/")), fs.constants.COPYFILE_EXCL);

    writeJson(path.join(stagingRoot, ...paths["migration-manifest"].split("/")), {
      schema: 1,
      sourceVersion: "0.4.10",
      targetVersion: PRODUCT_VERSION,
    });
    writeJson(path.join(stagingRoot, ...paths["rollback-manifest"].split("/")), STABLE_ROLLBACK);
    writeComponent(stagingRoot, paths["third-party-notices"], notices);

    const components = Object.keys(paths).sort(compareText).map((id) => {
      const componentPath = path.join(stagingRoot, ...paths[id].split("/"));
      const bytes = fs.readFileSync(regularFile(componentPath, id).path);
      return {
        id,
        path: paths[id],
        version: versions[id],
        size: bytes.length,
        sha256: sha256(bytes),
      };
    });
    writeJson(path.join(stagingRoot, "coding-tools", "package-manifest.json"), {
      schema: 1,
      product: {
        name: PRODUCT_NAME,
        version: PRODUCT_VERSION,
        app_id: APP_ID,
        platform,
        arch,
        installer: {
          kind: platform === "win32" ? "nsis" : platform === "darwin" ? "dmg" : "appimage",
          scope: "current-user",
          allow_elevation: false,
        },
      },
      source: {
        repository: SOURCE_REPOSITORY,
        sha: sourceSha,
      },
      upstream: UPSTREAM,
      components,
    });

    const preservedPath = session.publishDirectory(stagingRoot, outputRoot, "prior-package-resources");
    return {
      outputRoot,
      preservedPath,
      sourceSha,
      platform,
      arch,
      componentIds: components.map((component) => component.id),
      trashRoot: session.trashRoot,
    };
  } catch (error) {
    let retentionError = null;
    try {
      if (fs.existsSync(stagingRoot)) session.preservePath(stagingRoot, "failed-package-resources");
    } catch (failure) {
      retentionError = failure;
    }
    if (retentionError) {
      throw new AggregateError([error, retentionError], "Package resource preparation and evidence retention both failed");
    }
    throw error;
  }
}

if (require.main === module) {
  try {
    const result = preparePackageResources();
    process.stdout.write(`PACKAGE_RESOURCES_PREPARED ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PRODUCT_VERSION,
  STABLE_ROLLBACK,
  TUNNEL_VERSION,
  componentPaths,
  createRetentionSession,
  preparePackageResources,
};
