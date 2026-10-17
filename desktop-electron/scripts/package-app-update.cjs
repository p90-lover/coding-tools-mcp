// Builds a whole-app update (see electron/app-update.cjs) from an unpacked Windows build:
// a manifest of every file and the packs holding them, plus their SHA256SUMS.txt lines.
//   node scripts/package-app-update.cjs --app release/win-unpacked --output artifacts [--version V]
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { parseArgs } = require("node:util");
const {
  hashFile, manifestAssetName, packAssetName, parseManifest, platformTag, safeInstallPath,
} = require("../electron/app-update.cjs");

/** The pack a file belongs to: Electron's files, app.asar, then each resources folder two levels deep. */
function packFor(rel) {
  const parts = rel.split("/");
  if (parts[0] !== "resources") return "framework";
  if (parts.length === 2) return "app";
  const name = parts.length > 3 ? `${parts[1]}-${parts[2]}` : parts[1];
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "misc";
}

function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Builds must not contain links: ${full}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (!safeInstallPath(rel)) throw new Error(`Build path cannot be updated in place: ${rel}`);
        files.push(rel);
      }
    }
  };
  walk(root);
  return files;
}

async function* records(root, rels) {
  for (const rel of rels) {
    const full = path.join(root, ...rel.split("/"));
    const header = Buffer.from(JSON.stringify({ path: rel, size: fs.statSync(full).size }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    yield length;
    yield header;
    for await (const chunk of fs.createReadStream(full)) yield chunk;
  }
}

async function buildAppUpdate({ appRoot, output, version, electron, tag = platformTag("win32", "x64") }) {
  fs.mkdirSync(output, { recursive: true });
  const files = [];
  const byPack = new Map();
  for (const rel of listFiles(appRoot)) {
    const full = path.join(appRoot, ...rel.split("/"));
    const pack = packFor(rel);
    files.push({ path: rel, size: fs.statSync(full).size, sha256: await hashFile(full), pack });
    if (!byPack.has(pack)) byPack.set(pack, []);
    byPack.get(pack).push(rel);
  }
  const packs = [];
  const sums = [];
  for (const [name, rels] of byPack) {
    const assetName = packAssetName(version, tag, name);
    const target = path.join(output, assetName);
    await pipeline(Readable.from(records(appRoot, rels)), zlib.createGzip({ level: 6 }), fs.createWriteStream(target, { flags: "wx" }));
    const sha256 = await hashFile(target);
    packs.push({ name, size: fs.statSync(target).size, sha256 });
    sums.push(`${sha256}  ${assetName}`);
  }
  const manifest = { schema: 1, version, platform: tag, electron, builtAt: new Date().toISOString(), packs, files };
  const text = `${JSON.stringify(manifest)}\n`;
  parseManifest(text, { version, tag });
  const manifestName = manifestAssetName(version, tag);
  fs.writeFileSync(path.join(output, manifestName), text, { flag: "wx" });
  sums.unshift(`${crypto.createHash("sha256").update(text).digest("hex")}  ${manifestName}`);
  return { manifestName, packs, files: files.length, sums };
}

if (require.main === module) {
  const { values } = parseArgs({ options: {
    app: { type: "string" }, output: { type: "string" }, version: { type: "string" },
  } });
  if (!values.app || !values.output) {
    throw new Error("Usage: package-app-update.cjs --app UNPACKED_DIRECTORY --output DIRECTORY [--version VERSION]");
  }
  const launcher = require("../package.json");
  const version = values.version || launcher.version;
  const electron = String(launcher.devDependencies?.electron || launcher.dependencies?.electron || "").replace(/^[^\d]*/, "");
  if (!electron) throw new Error("package.json pins no Electron version");
  buildAppUpdate({ appRoot: path.resolve(values.app), output: path.resolve(values.output), version, electron })
    .then((result) => {
      fs.appendFileSync(path.join(path.resolve(values.output), "SHA256SUMS.txt"), `${result.sums.join("\n")}\n`);
      const bytes = result.packs.reduce((sum, pack) => sum + pack.size, 0);
      process.stdout.write(`${JSON.stringify({ manifest: result.manifestName, files: result.files, packs: result.packs.length, bytes })}\n`);
    })
    .catch((error) => { console.error(error); process.exit(1); });
}

module.exports = { buildAppUpdate, packFor };
