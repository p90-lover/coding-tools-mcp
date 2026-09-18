import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const sourcePath = path.join(root, "aiTemp", "rc11-release", "materialize-release.mjs");
const runtimeRoot = path.join(root, "aiTemp", "runtime", "rc11-release");
const runtimePath = path.join(runtimeRoot, `materialize-${process.env.GITHUB_SHA || "local"}.mjs`);
const before = "    assert.match(apps, new RegExp(`id: [\"']${tab}[\"']`));";
const after = "    assert.match(apps, new RegExp(\\`id: [\"']\\${tab}[\"']\\`));";

let source = fs.readFileSync(sourcePath, "utf8");
if (!source.includes(before) && !source.includes(after)) {
  throw new Error("RC11_MATERIALIZER_NESTED_TEMPLATE_ANCHOR_MISSING");
}
source = source.replace(before, after);
fs.mkdirSync(runtimeRoot, { recursive: true });
fs.writeFileSync(runtimePath, source, { encoding: "utf8", flag: "wx" });
await import(pathToFileURL(runtimePath).href);
process.stdout.write(`RC11_MATERIALIZER_RUNTIME ${runtimePath}\n`);
