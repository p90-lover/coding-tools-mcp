const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const zlib = require("node:zlib");
const { guiAssetName, guiShellHash, parseGuiBundle } = require("../electron/gui-update.cjs");

const { values } = parseArgs({ options: {
  dist: { type: "string" }, revision: { type: "string" }, output: { type: "string" },
} });
const revision = Number(values.revision);
if (!/^[1-9]\d*$/.test(values.revision || "") || !Number.isSafeInteger(revision)
  || !values.dist || !values.output) {
  throw new Error("Usage: package-gui-update.cjs --dist DIRECTORY --revision INTEGER --output DIRECTORY");
}
const shellVersion = require("../package.json").version;
const shellHash = guiShellHash(path.join(__dirname, "..", "electron"));
const dist = path.resolve(values.dist);
const files = [];
for (const relative of fs.readdirSync(dist, { recursive: true }).sort()) {
  const absolute = path.join(dist, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isDirectory()) continue;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("GUI renderer files must be regular files");
  files.push({ path: relative.split(path.sep).join("/"), content: fs.readFileSync(absolute).toString("base64") });
}
const bundle = zlib.gzipSync(JSON.stringify({ schema: 1, shellVersion, shellHash, revision, files }));
parseGuiBundle(bundle, { shellVersion, shellHash, revision });
const assetName = guiAssetName(shellVersion, revision);
const output = path.resolve(values.output);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, assetName), bundle, { flag: "wx" });
const checksum = crypto.createHash("sha256").update(bundle).digest("hex");
fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), `${checksum}  ${assetName}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ assetName, shellVersion, revision, shellHash, files: files.length, bytes: bundle.length })}\n`);
