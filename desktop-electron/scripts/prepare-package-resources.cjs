"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { TextDecoder } = require("node:util");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");

const PRODUCT_VERSION = "0.7.0-rc.13";
const PRODUCT_NAME = "Coding Tools";
const APP_ID = "dev.codingtools.fullharness";
const SOURCE_REPOSITORY = "p90-lover/coding-tools-mcp";
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UPSTREAM = Object.freeze({
  repository: "miuuyy/codex-chatgpt-web",
  version: "v5.0.6",
  commit: "e85e3693fdb4e3e033348c08df0298c20fcdb612",
});
const TUNNEL_VERSION = "0.0.12";
const TUNNEL_REPOSITORY = "openai/tunnel-client";
const CLOUDFLARED_VERSION = "2026.7.2";
const CLOUDFLARED_RELEASE_COMMIT = "8679787525edc8575b2948a7c4a50b6292c6d426";
const MAX_TUNNEL_ARCHIVE_BYTES = 80 * 1024 * 1024;
const MAX_TUNNEL_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_TUNNEL_MEMBERS = 16;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
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
const OFFICIAL_TUNNEL_RELEASES = Object.freeze({
  "darwin/arm64": Object.freeze({
    repository: TUNNEL_REPOSITORY,
    version: `v${TUNNEL_VERSION}`,
    platform: "darwin",
    arch: "arm64",
    archiveName: "tunnel-client-v0.0.12-darwin-arm64.zip",
    archiveSha256: "42fb3138dc9c081d5777cb7e8bd1e041cc48b67c4978dbab3c5167ca1aabca02",
    binaryName: "tunnel-client",
    licenseName: "tunnel-client-v0.0.12-darwin-arm64-licenses.txt",
    licenseSha256: "961dd697f068eeba060699ebcda2318779fe952831c45e2743b773a776d697a3",
    spdxName: "tunnel-client-v0.0.12-darwin-arm64.spdx.json",
    spdxSha256: "b3cf00f998d7137335969c2f78811561afaca6094686b9824808ad5286f3df4d",
  }),
  "darwin/x64": Object.freeze({
    repository: TUNNEL_REPOSITORY,
    version: `v${TUNNEL_VERSION}`,
    platform: "darwin",
    arch: "amd64",
    archiveName: "tunnel-client-v0.0.12-darwin-amd64.zip",
    archiveSha256: "33de53aec680faafedc795f8f8268d6861577bddb871cb2d49529c91f88c2009",
    binaryName: "tunnel-client",
    licenseName: "tunnel-client-v0.0.12-darwin-amd64-licenses.txt",
    licenseSha256: "661df2b81de81ec60df1820e2f152f120ad9fd14455c116c159b3bc9041d0ba2",
    spdxName: "tunnel-client-v0.0.12-darwin-amd64.spdx.json",
    spdxSha256: "cbed744781fd63f2def30322a2ae41feb3bd16f15c03c127a006ce734bb7001c",
  }),
  "linux/arm64": Object.freeze({
    repository: TUNNEL_REPOSITORY,
    version: `v${TUNNEL_VERSION}`,
    platform: "linux",
    arch: "arm64",
    archiveName: "tunnel-client-v0.0.12-linux-arm64.zip",
    archiveSha256: "6813878a3edb82ebebb32fe5a859bc6327a81cce5bc7b635a2313174d26365d6",
    binaryName: "tunnel-client",
    licenseName: "tunnel-client-v0.0.12-linux-arm64-licenses.txt",
    licenseSha256: "2504135d0ddc2965429044fe06ea93d72582c3694f83b02eebe6cbc515dc9aaa",
    spdxName: "tunnel-client-v0.0.12-linux-arm64.spdx.json",
    spdxSha256: "0c8c84a40e9b96d5c87d35ab650d6cb33671176d1cbb81846a1f52ed401bbed6",
  }),
  "linux/x64": Object.freeze({
    repository: TUNNEL_REPOSITORY,
    version: `v${TUNNEL_VERSION}`,
    platform: "linux",
    arch: "amd64",
    archiveName: "tunnel-client-v0.0.12-linux-amd64.zip",
    archiveSha256: "2bb693bd7b5cd28da7ce09cd9e309529dbb33b7cc9dc0058e62a064688f92c81",
    binaryName: "tunnel-client",
    licenseName: "tunnel-client-v0.0.12-linux-amd64-licenses.txt",
    licenseSha256: "fbe3d5c7d3a6a14317915d4c058f97342c9a533654f533adcba3261acc821a33",
    spdxName: "tunnel-client-v0.0.12-linux-amd64.spdx.json",
    spdxSha256: "f2c5548c7bff0aff2a3fbd00cf936cf96071d88110ec078837370f468c6b313d",
  }),
  "win32/arm64": Object.freeze({
    repository: TUNNEL_REPOSITORY,
    version: `v${TUNNEL_VERSION}`,
    platform: "windows",
    arch: "arm64",
    archiveName: "tunnel-client-v0.0.12-windows-arm64.zip",
    archiveSha256: "65ab54221554481bb1c23b6015b99abe0b7f79b08593f4fb17a9e2e25532281d",
    binaryName: "tunnel-client.exe",
    licenseName: "tunnel-client-v0.0.12-windows-arm64-licenses.txt",
    licenseSha256: "d2cd87a75bc8121e1579e67cf8f011d55d91d358436be101c0992f3cfb0f1e95",
    spdxName: "tunnel-client-v0.0.12-windows-arm64.spdx.json",
    spdxSha256: "d125eeec8b308cf20550d1e74658285f0211e909143942f6c5743f801219c01c",
  }),
  "win32/x64": Object.freeze({
    repository: TUNNEL_REPOSITORY,
    version: `v${TUNNEL_VERSION}`,
    platform: "windows",
    arch: "amd64",
    archiveName: "tunnel-client-v0.0.12-windows-amd64.zip",
    archiveSha256: "2a2804933924e38a502d62b61f0266cb80d56d65744f4c29876b2bf9c1544356",
    binaryName: "tunnel-client.exe",
    licenseName: "tunnel-client-v0.0.12-windows-amd64-licenses.txt",
    licenseSha256: "7d85227df86c38a689fca913d6f4a0b49ad030d6e056155a6832312cf7fb4bad",
    spdxName: "tunnel-client-v0.0.12-windows-amd64.spdx.json",
    spdxSha256: "4c6b46a645b71853d55f50cfb4b2c51324422a57f007984ba113d3edcfeb4f2c",
  }),
});

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

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
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

function cloudflaredName(platform) {
  return executableName("cloudflared", platform);
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

function validateBinaryBytes(bytes, label, platform) {
  if (!binaryFormat(bytes, platform)) {
    fail("PACKAGE_RESOURCE_BINARY_FORMAT_MISMATCH", `${label}: ${platform}`);
  }
  return bytes;
}

function validateBinary(filePath, label, platform) {
  const input = regularFile(filePath, label);
  validateBinaryBytes(fs.readFileSync(input.path), label, platform);
  return input;
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

function expectedReleaseIdentity(platform, arch) {
  const mappedPlatform = platform === "win32" ? "windows" : platform;
  const mappedArch = arch === "x64" ? "amd64" : arch;
  return { mappedPlatform, mappedArch };
}

function validateTunnelRelease(release, platform, arch) {
  const { mappedPlatform, mappedArch } = expectedReleaseIdentity(platform, arch);
  if (!release || typeof release !== "object"
      || release.repository !== TUNNEL_REPOSITORY
      || release.version !== `v${TUNNEL_VERSION}`
      || release.platform !== mappedPlatform
      || release.arch !== mappedArch
      || release.binaryName !== executableName("tunnel-client", platform)
      || !SHA256.test(release.archiveSha256)
      || typeof release.archiveName !== "string"
      || typeof release.licenseName !== "string"
      || typeof release.spdxName !== "string") {
    fail("PACKAGE_RESOURCE_TUNNEL_RELEASE_INVALID", JSON.stringify(release ?? null));
  }
  const prefix = `tunnel-client-v${TUNNEL_VERSION}-${mappedPlatform}-${mappedArch}`;
  if (release.archiveName !== `${prefix}.zip`
      || release.licenseName !== `${prefix}-licenses.txt`
      || release.spdxName !== `${prefix}.spdx.json`) {
    fail("PACKAGE_RESOURCE_TUNNEL_RELEASE_ASSET_MISMATCH", JSON.stringify(release));
  }
  for (const field of ["licenseSha256", "spdxSha256"]) {
    if (release[field] !== undefined && !SHA256.test(release[field])) {
      fail("PACKAGE_RESOURCE_TUNNEL_RELEASE_INVALID", `${field}: ${release[field]}`);
    }
  }
  return Object.freeze({ ...release });
}

function resolveTunnelRelease(platform, arch, override) {
  return validateTunnelRelease(override || OFFICIAL_TUNNEL_RELEASES[`${platform}/${arch}`], platform, arch);
}

function defaultTunnelArchiveCandidates(repositoryRoot, release) {
  const platformArch = `${release.platform}-${release.arch}`;
  return [
    process.env.CODING_TOOLS_TUNNEL_CLIENT_ARCHIVE,
    path.join(repositoryRoot, "third_party", "tunnel-client", release.version, platformArch, release.archiveName),
    path.join(repositoryRoot, "third_party", "tunnel-client", release.version, release.archiveName),
    path.join(repositoryRoot, "aiTemp", "input", "tunnel-client", release.version, platformArch, release.archiveName),
    path.join(repositoryRoot, "aiTemp", "input", release.archiveName),
  ];
}

function ensureRange(bytes, offset, length, code) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0 || offset + length > bytes.length) {
    fail(code, JSON.stringify({ offset, length, total: bytes.length }));
  }
}

function findZipEnd(bytes) {
  if (bytes.length < 22) fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID", "archive is shorter than an end record");
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    ensureRange(bytes, offset, 22, "PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID");
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== bytes.length) continue;
    const disk = bytes.readUInt16LE(offset + 4);
    const centralDisk = bytes.readUInt16LE(offset + 6);
    const diskEntries = bytes.readUInt16LE(offset + 8);
    const totalEntries = bytes.readUInt16LE(offset + 10);
    const centralSize = bytes.readUInt32LE(offset + 12);
    const centralOffset = bytes.readUInt32LE(offset + 16);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
        || totalEntries < 1 || totalEntries > MAX_TUNNEL_MEMBERS
        || centralOffset + centralSize !== offset) {
      fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID", "unsupported multi-disk, ZIP64, or central-directory layout");
    }
    ensureRange(bytes, centralOffset, centralSize, "PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID");
    return { offset, totalEntries, centralOffset, centralSize };
  }
  fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID", "end-of-central-directory record is missing");
}

function decodeZipName(bytes, label) {
  try {
    const name = UTF8.decode(bytes);
    if (!name || name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") {
      fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_PATH_UNSAFE", `${label}: ${JSON.stringify(name)}`);
    }
    return name;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PACKAGE_RESOURCE_")) throw error;
    fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_NAME_INVALID", label);
  }
}

function readTunnelZip(bytes, expectedNames) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_TUNNEL_ARCHIVE_BYTES) {
    fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_SIZE_INVALID", String(bytes?.length ?? "not-buffer"));
  }
  const end = findZipEnd(bytes);
  const members = new Map();
  let cursor = end.centralOffset;
  for (let index = 0; index < end.totalEntries; index += 1) {
    ensureRange(bytes, cursor, 46, "PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID");
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) {
      fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID", `central record ${index} has the wrong signature`);
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    ensureRange(bytes, cursor, recordLength, "PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID");
    if ((flags & 0x0001) !== 0 || ![0, 8].includes(method) || diskStart !== 0
        || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || localOffset === 0xffffffff || uncompressedSize > MAX_TUNNEL_MEMBER_BYTES
        || compressedSize > MAX_TUNNEL_MEMBER_BYTES) {
      fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID", `unsupported central record for member ${index}`);
    }
    const name = decodeZipName(bytes.subarray(cursor + 46, cursor + 46 + nameLength), `central member ${index}`);
    if (members.has(name)) fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_DUPLICATE_MEMBER", name);

    ensureRange(bytes, localOffset, 30, "PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID");
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID", `${name} has no matching local record`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    ensureRange(bytes, localOffset + 30, localNameLength + localExtraLength, "PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID");
    const localName = decodeZipName(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      `local member ${index}`,
    );
    if (localName !== name || localMethod !== method || (localFlags & 0x0001) !== 0) {
      fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID", `${name} central/local metadata mismatch`);
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    ensureRange(bytes, dataOffset, compressedSize, "PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID");
    if (dataOffset + compressedSize > end.centralOffset) {
      fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID", `${name} overlaps the central directory`);
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let output;
    try {
      output = method === 0
        ? Buffer.from(compressed)
        : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_TUNNEL_MEMBER_BYTES });
    } catch (error) {
      fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_DECOMPRESSION_FAILED", `${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (output.length !== uncompressedSize || crc32(output) !== checksum) {
      fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_MEMBER_MISMATCH", name);
    }
    members.set(name, output);
    cursor += recordLength;
  }
  if (cursor !== end.centralOffset + end.centralSize) {
    fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVALID", "central directory size mismatch");
  }
  const actualNames = [...members.keys()].sort(compareText);
  const wantedNames = [...expectedNames].sort(compareText);
  if (JSON.stringify(actualNames) !== JSON.stringify(wantedNames)) {
    fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVENTORY_MISMATCH", JSON.stringify({ wantedNames, actualNames }));
  }
  return members;
}

function validateTunnelArchive(archivePath, release, platform) {
  const archive = regularFile(archivePath, "tunnel-client archive");
  if (path.basename(archive.path) !== release.archiveName) {
    fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_NAME_MISMATCH", path.basename(archive.path));
  }
  const bytes = fs.readFileSync(archive.path);
  const archiveDigest = sha256(bytes);
  if (archiveDigest !== release.archiveSha256) {
    fail("PACKAGE_RESOURCE_TUNNEL_ARCHIVE_DIGEST_MISMATCH", `${release.archiveName}: ${archiveDigest}`);
  }
  const members = readTunnelZip(bytes, [
    release.binaryName,
    cloudflaredName(platform),
    "cloudflared-manifest.json",
    "LICENSE",
    "NOTICE",
    release.licenseName,
    release.spdxName,
  ]);
  validateBinaryBytes(members.get(release.binaryName), "tunnel-client", platform);
  validateBinaryBytes(members.get(cloudflaredName(platform)), "cloudflared", platform);
  const licenseDigest = sha256(members.get(release.licenseName));
  const spdxDigest = sha256(members.get(release.spdxName));
  if (release.licenseSha256 !== undefined && licenseDigest !== release.licenseSha256) {
    fail("PACKAGE_RESOURCE_TUNNEL_LICENSE_DIGEST_MISMATCH", `${release.licenseName}: ${licenseDigest}`);
  }
  if (release.spdxSha256 !== undefined && spdxDigest !== release.spdxSha256) {
    fail("PACKAGE_RESOURCE_TUNNEL_SPDX_DIGEST_MISMATCH", `${release.spdxName}: ${spdxDigest}`);
  }
  let spdx;
  try {
    spdx = JSON.parse(UTF8.decode(members.get(release.spdxName)));
  } catch (error) {
    fail("PACKAGE_RESOURCE_TUNNEL_SPDX_INVALID", error instanceof Error ? error.message : String(error));
  }
  if (spdx?.spdxVersion !== "SPDX-2.3") {
    fail("PACKAGE_RESOURCE_TUNNEL_SPDX_INVALID", String(spdx?.spdxVersion));
  }
  let cloudflaredManifest;
  const cloudflaredManifestBytes = members.get("cloudflared-manifest.json");
  try {
    cloudflaredManifest = JSON.parse(UTF8.decode(cloudflaredManifestBytes));
  } catch (error) {
    fail("PACKAGE_RESOURCE_CLOUDFLARED_MANIFEST_INVALID", error instanceof Error ? error.message : String(error));
  }
  const requiredPlatform = `${release.platform}/${release.arch}`;
  if (cloudflaredManifest?.version !== CLOUDFLARED_VERSION
      || cloudflaredManifest?.release_commit !== CLOUDFLARED_RELEASE_COMMIT
      || !Array.isArray(cloudflaredManifest?.platforms)
      || !cloudflaredManifest.platforms.includes(requiredPlatform)) {
    fail("PACKAGE_RESOURCE_CLOUDFLARED_IDENTITY_MISMATCH", JSON.stringify({
      version: cloudflaredManifest?.version,
      release_commit: cloudflaredManifest?.release_commit,
      requiredPlatform,
      platforms: cloudflaredManifest?.platforms,
    }));
  }
  return {
    archivePath: archive.path,
    archiveDigest,
    archiveMembers: [...members.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, memberBytes]) => ({
        name,
        size: memberBytes.length,
        sha256: sha256(memberBytes),
      })),
    members,
    licenseDigest,
    spdxDigest,
    cloudflared: {
      binaryName: cloudflaredName(platform),
      binarySha256: sha256(members.get(cloudflaredName(platform))),
      manifestSha256: sha256(cloudflaredManifestBytes),
      version: cloudflaredManifest.version,
      releaseCommit: cloudflaredManifest.release_commit,
    },
    release,
  };
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
  try {
    validateRuntimeBundle(root, {
      version: PRODUCT_VERSION,
      platform,
      arch,
    });
  } catch (error) {
    fail(
      "PACKAGE_RESOURCE_RUNTIME_INTEGRITY_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  for (const required of ["THIRD_PARTY_NOTICES.txt", "LICENSE", "LICENSES"]) {
    const target = path.join(root, required);
    if (required === "LICENSES") regularDirectory(target, "runtime license inventory");
    else regularFile(target, `runtime ${required}`);
  }
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

function memberText(tunnel, name) {
  try {
    return UTF8.decode(tunnel.members.get(name)).trim();
  } catch (error) {
    fail("PACKAGE_RESOURCE_TUNNEL_NOTICE_INVALID", `${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function combinedNotices(noticesPath, runtimeRoot, tunnel) {
  const integrationNotices = fs.readFileSync(regularFile(noticesPath, "repository third-party notices").path, "utf8").trim();
  const runtimeNotices = fs.readFileSync(
    regularFile(path.join(runtimeRoot, "THIRD_PARTY_NOTICES.txt"), "runtime third-party notices").path,
    "utf8",
  ).trim();
  const tunnelLicense = memberText(tunnel, "LICENSE");
  const tunnelNotice = memberText(tunnel, "NOTICE");
  const tunnelLicenseReport = memberText(tunnel, tunnel.release.licenseName);
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
    `## OpenAI tunnel-client ${tunnel.release.version}`,
    "",
    `Release archive: ${tunnel.release.archiveName}`,
    `Release archive SHA-256: ${tunnel.archiveDigest}`,
    `SPDX document: ${tunnel.release.spdxName}`,
    `SPDX SHA-256: ${tunnel.spdxDigest}`,
    "",
    tunnelNotice,
    "",
    tunnelLicense,
    "",
    `### ${tunnel.release.licenseName}`,
    "",
    tunnelLicenseReport,
    "",
  ].join("\n");
  for (const marker of ["codex-chatgpt-web", "MIT", "Apache-2.0", "OpenAI tunnel-client"]) {
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

function writeComponent(stagingRoot, relativePath, bytes, mode = 0o600) {
  const target = path.join(stagingRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { flag: "wx", mode });
  fs.chmodSync(target, mode);
  return target;
}

function isMissingFsEntry(error) {
  return Boolean(error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP"));
}

function recoverWorkspacePackage(fromPath) {
  const candidates = [];
  try {
    const raw = fs.readlinkSync(fromPath);
    candidates.push(path.resolve(path.dirname(fromPath), raw));
    const normalized = String(raw).replace(/\\/g, "/");
    const marker = "/packages/";
    const index = normalized.toLowerCase().lastIndexOf(marker);
    if (index !== -1) {
      const suffixParts = normalized.slice(index + 1).split("/").filter(Boolean);
      let cursor = path.dirname(fromPath);
      while (true) {
        candidates.push(path.join(cursor, ...suffixParts));
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }
  } catch {
    // Windows junctions whose target was renamed away can fail readlink/lstat.
  }
  const name = path.basename(fromPath);
  let dir = path.dirname(fromPath);
  if (path.basename(dir).startsWith("@")) dir = path.dirname(dir);
  if (path.basename(dir) === "node_modules") {
    candidates.push(path.join(path.dirname(dir), "packages", name));
  }
  for (const candidate of candidates) {
    try {
      const metadata = fs.statSync(candidate);
      if (metadata.isFile() || metadata.isDirectory()) return candidate;
    } catch {
      // try the next mapping
    }
  }
  return null;
}

function posixParts(relative) {
  return String(relative || "").replaceAll("\\", "/").split("/").filter(Boolean);
}

function joinRelative(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

const SKIP_FIVE_STACK_DIR_NAMES = new Set([
  ".git",
  "fastlane",
  "test",
  "tests",
  "__tests__",
  "e2e",
  "docs",
  "examples",
  "coverage",
  ".turbo",
  ".cache",
  ".nyc_output",
]);
const SKIP_PASEO_WORKSPACES = new Set(["app", "website", "desktop"]);
const SKIP_HEAVY_NODE_MODULES = new Set([
  "expo",
  "expo-router",
  "react-native",
  "react-native-web",
  "metro",
  "metro-config",
  "metro-core",
  "metro-runtime",
  "metro-source-map",
  "workerd",
  "wrangler",
  "miniflare",
  "eas-cli",
  "typescript",
  "eslint",
  "prettier",
  "webpack",
  "webpack-cli",
  "vite",
  "rollup",
  "playwright",
  "puppeteer",
  "cypress",
  "next",
  "storybook",
]);
const SKIP_HEAVY_NODE_MODULE_SCOPES = new Set([
  "@expo",
  "@react-native",
  "@react-native-community",
  "@react-navigation",
  "@cloudflare",
  "@types",
  "@eslint",
  "@storybook",
  "@playwright",
  "@vitejs",
]);

function skipHeavyNodeModule(parts) {
  const index = parts.lastIndexOf("node_modules");
  if (index < 0 || index + 1 >= parts.length) return false;
  const pkg = parts[index + 1];
  return SKIP_HEAVY_NODE_MODULES.has(pkg) || SKIP_HEAVY_NODE_MODULE_SCOPES.has(pkg);
}

function skipFiveStackRelative(relativePosix) {
  const parts = posixParts(relativePosix);
  for (let index = 0; index < parts.length; index += 1) {
    if (SKIP_FIVE_STACK_DIR_NAMES.has(parts[index])) return true;
    if (parts[index] === "packages" && SKIP_PASEO_WORKSPACES.has(parts[index + 1])) return true;
  }
  return skipHeavyNodeModule(parts);
}

function skipFiveStackResolvedPath(resolvedPath) {
  const posix = String(resolvedPath || "").replaceAll("\\", "/");
  if (/(?:^|\/)packages\/(?:app|website|desktop)(?:\/|$)/.test(posix)) return true;
  return skipHeavyNodeModule(posix.split("/").filter(Boolean));
}

function isUnsafeWindowsPackagedName(name) {
  const base = String(name || "");
  if (!base || /[. ]$/.test(base)) return true;
  if (/[<>:"/\\|?*]/.test(base)) return true;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base);
}

function looksLikePackagedFileName(name) {
  return /\.(?:md|png|jpe?g|gif|webp|json|txt|ya?ml|js|mjs|cjs|ts|tsx|css|html|svg|lock|map|xml)$/i.test(String(name || ""));
}

function skipFiveStackPackageEntry(name, metadata, relativePosix = "") {
  if (SKIP_FIVE_STACK_DIR_NAMES.has(name)) return true;
  if (isUnsafeWindowsPackagedName(name)) return true;
  if (relativePosix && skipFiveStackRelative(relativePosix)) return true;
  return Boolean(metadata && metadata.isDirectory() && looksLikePackagedFileName(name));
}

function copyFiveStackResolved(from, to, seen, relative = "") {
  if (skipFiveStackRelative(relative) || skipFiveStackResolvedPath(from)) return;
  const metadata = fs.statSync(from);
  if (metadata.isDirectory()) {
    copyFiveStackTree(from, to, seen, relative);
    return;
  }
  if (!metadata.isFile()) fail("PACKAGE_RESOURCE_FIVE_STACK_ENTRY_UNSUPPORTED", from);
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, metadata.mode & 0o777 || 0o600);
}

function copyFiveStackTree(sourceRoot, destinationRoot, seen = new Set(), relativePrefix = "") {
  if (skipFiveStackRelative(relativePrefix) || skipFiveStackResolvedPath(sourceRoot)) return;
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  let real;
  try {
    real = fs.realpathSync(source);
  } catch {
    real = source;
  }
  if (seen.has(real)) return;
  const nextSeen = new Set(seen);
  nextSeen.add(real);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  let entries;
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch (error) {
    if (isMissingFsEntry(error)) {
      const recovered = recoverWorkspacePackage(source);
      if (
        recovered
        && path.resolve(recovered) !== path.resolve(source)
        && !skipFiveStackResolvedPath(recovered)
      ) {
        copyFiveStackTree(recovered, destination, seen, relativePrefix);
      }
      return;
    }
    fail("PACKAGE_RESOURCE_FIVE_STACK_ENTRY_UNREADABLE", `${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const entry of entries) {
    const relative = joinRelative(relativePrefix, entry.name);
    if (skipFiveStackPackageEntry(entry.name, null, relative)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    let linkStat;
    try {
      linkStat = fs.lstatSync(from);
    } catch (error) {
      if (isMissingFsEntry(error)) {
        const recovered = recoverWorkspacePackage(from);
        if (recovered) copyFiveStackResolved(recovered, to, nextSeen, relative);
        continue;
      }
      fail("PACKAGE_RESOURCE_FIVE_STACK_ENTRY_UNREADABLE", `${from}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let resolvedFrom = from;
    let metadata = linkStat;
    if (linkStat.isSymbolicLink()) {
      try {
        metadata = fs.statSync(from);
      } catch {
        const recovered = recoverWorkspacePackage(from);
        if (!recovered) continue;
        resolvedFrom = recovered;
        try {
          metadata = fs.statSync(recovered);
        } catch (error) {
          fail("PACKAGE_RESOURCE_FIVE_STACK_ENTRY_UNREADABLE", `${from}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (skipFiveStackPackageEntry(entry.name, metadata, relative) || skipFiveStackResolvedPath(resolvedFrom)) continue;
    if (metadata.isDirectory()) {
      if (looksLikePackagedFileName(entry.name)) continue;
      copyFiveStackTree(resolvedFrom, to, nextSeen, relative);
      continue;
    }
    if (!metadata.isFile()) fail("PACKAGE_RESOURCE_FIVE_STACK_ENTRY_UNSUPPORTED", from);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(resolvedFrom, to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, metadata.mode & 0o777 || 0o600);
  }
}

function resolveFiveStackRuntimeRoot({ desktopRoot, explicit, required }) {
  const candidates = [
    explicit,
    process.env.CODING_TOOLS_FIVE_STACK_RUNTIME,
    path.join(desktopRoot, "build", "five-stack-runtime"),
    path.join(desktopRoot, "vendor", "five-stack-runtime"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const manifest = path.join(resolved, "MANIFEST.json");
    if (fs.existsSync(manifest) && fs.statSync(manifest).isFile() && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  }
  if (required) {
    fail(
      "PACKAGE_RESOURCE_FIVE_STACK_RUNTIME_MISSING",
      candidates.map((entry) => path.resolve(entry)).join(", ") || "no candidates",
    );
  }
  return null;
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
  const tunnelRelease = resolveTunnelRelease(platform, arch, options.tunnelRelease);
  const tunnelArchive = options.tunnelArchive
    || firstExisting(defaultTunnelArchiveCandidates(repositoryRoot, tunnelRelease), "tunnel-client archive");
  const tunnel = validateTunnelArchive(tunnelArchive, tunnelRelease, platform);
  const noticesPath = path.resolve(
    options.noticesPath
      || process.env.CODING_TOOLS_THIRD_PARTY_NOTICES
      || path.join(repositoryRoot, "third_party", "THIRD_PARTY_NOTICES.md"),
  );
  const notices = combinedNotices(noticesPath, runtime.root, tunnel);
  const fiveStackRuntimeRoot = resolveFiveStackRuntimeRoot({
    desktopRoot,
    explicit: options.fiveStackRuntimeRoot,
    required: options.requireFiveStackRuntime === true
      || (options.requireFiveStackRuntime !== false && Boolean(options.requireMain)),
  });
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
    const headlessTarget = path.join(stagingRoot, ...paths["rust-headless"].split("/"));
    fs.mkdirSync(path.dirname(headlessTarget), { recursive: true, mode: 0o700 });
    fs.copyFileSync(headlessSource.path, headlessTarget, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(headlessTarget, platform === "win32" ? 0o600 : (headlessSource.metadata.mode & 0o777) || 0o755);
    for (const [name, memberBytes] of [...tunnel.members.entries()].sort(([left], [right]) => compareText(left, right))) {
      const executable = name === tunnel.release.binaryName || name === cloudflaredName(platform);
      writeComponent(
        stagingRoot,
        `native/${name}`,
        memberBytes,
        executable && platform !== "win32" ? 0o755 : 0o600,
      );
    }

    writeJson(path.join(stagingRoot, ...paths["migration-manifest"].split("/")), {
      schema: 1,
      sourceVersion: "0.4.10",
      targetVersion: PRODUCT_VERSION,
    });
    writeJson(path.join(stagingRoot, ...paths["rollback-manifest"].split("/")), STABLE_ROLLBACK);
    writeComponent(stagingRoot, paths["third-party-notices"], notices);
    if (fiveStackRuntimeRoot) {
      copyFiveStackTree(fiveStackRuntimeRoot, path.join(stagingRoot, "five-stack-runtime"));
    }

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
    const { materializeBundledComponents } = require("./vendor-upstream-bundles.cjs");
    if (fs.existsSync(path.join(desktopRoot, "vendor", "managed-components"))) {
      materializeBundledComponents({
        desktopRoot,
        destinationRoot: path.join(stagingRoot, "bundled-components"),
        fetchMissing: options.fetchBundles === true,
      });
    }

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
      supply_chain: {
        tunnel_client: {
          repository: tunnel.release.repository,
          version: tunnel.release.version,
          archive: {
            name: tunnel.release.archiveName,
            sha256: tunnel.archiveDigest,
            members: tunnel.archiveMembers,
          },
          cloudflared: tunnel.cloudflared,
          license_report: {
            name: tunnel.release.licenseName,
            sha256: tunnel.licenseDigest,
          },
          spdx: {
            name: tunnel.release.spdxName,
            sha256: tunnel.spdxDigest,
          },
        },
      },
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
      tunnelArchive: tunnel.release.archiveName,
      tunnelArchiveSha256: tunnel.archiveDigest,
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
    const result = preparePackageResources({
      requireMain: true,
      fetchBundles: process.env.CODING_TOOLS_SKIP_BUNDLE_FETCH !== "1",
    });
    process.stdout.write(`PACKAGE_RESOURCES_PREPARED ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  OFFICIAL_TUNNEL_RELEASES,
  PRODUCT_VERSION,
  STABLE_ROLLBACK,
  TUNNEL_VERSION,
  componentPaths,
  copyFiveStackTree,
  skipFiveStackPackageEntry,
  createRetentionSession,
  preparePackageResources,
  readTunnelZip,
  validateTunnelArchive,
};
