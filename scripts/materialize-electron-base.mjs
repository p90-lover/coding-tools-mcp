import fs from 'node:fs/promises';
import path from 'node:path';
import { inventory, verifyTree } from './lib/upstream-manifest.mjs';

const PIN = Object.freeze({
  repository: 'miuuyy/codex-chatgpt-web',
  tag: 'v5.0.6',
  commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612',
  tunnelClientVersion: '0.0.12',
});
const TARGET_VERSION = '0.6.0';

function safeTimestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function retain(target, root, label) {
  if (!(await exists(target))) return null;
  const destination = path.join(root, label);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(target, destination);
  return destination;
}

async function copyTree(source, destination) {
  const metadata = await fs.lstat(source);
  if (metadata.isSymbolicLink()) throw new Error(`MATERIALIZATION_SYMLINK_REJECTED:${source}`);
  if (metadata.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      await copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (!metadata.isFile()) throw new Error(`MATERIALIZATION_NON_FILE_REJECTED:${source}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}

async function updateJson(filePath, update) {
  const original = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const next = update(original);
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

async function main() {
  const root = process.cwd();
  const vendor = path.join(root, 'vendor', 'codex-chatgpt-web-v5.0.6');
  await verifyTree(vendor, path.join(vendor, 'UPSTREAM_MANIFEST.json'), PIN);

  const desktop = path.join(root, 'desktop-electron');
  const runtime = path.join(root, 'runtime-web');
  const testPath = path.join(desktop, 'tests', 'product-identity.test.cjs');
  const productTest = (await exists(testPath)) ? await fs.readFile(testPath) : null;
  const retainedRoot = path.join(root, 'Trash', 'electron-materialization', safeTimestamp());
  const retained = [];
  for (const [target, label] of [[desktop, 'desktop-electron'], [runtime, 'runtime-web']]) {
    const moved = await retain(target, retainedRoot, label);
    if (moved) retained.push(path.relative(root, moved).split(path.sep).join('/'));
  }

  await copyTree(path.join(vendor, 'launcher'), desktop);
  await copyTree(vendor, runtime);
  if (productTest) {
    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(testPath, productTest);
  }

  await updateJson(path.join(desktop, 'package.json'), pkg => ({
    ...pkg,
    name: 'coding-tools-full-harness-desktop',
    version: TARGET_VERSION,
    description: 'Coding Tools desktop with the pinned full Codex ChatGPT Web harness',
    author: 'Coding Tools MCP Contributors',
    build: {
      ...pkg.build,
      appId: 'dev.codingtools.fullharness',
      productName: 'Coding Tools',
      artifactName: 'Coding.Tools_${version}_${os}_${arch}.${ext}',
      directories: { ...pkg.build?.directories, output: 'release' },
      nsis: {
        ...pkg.build?.nsis,
        guid: '3cb2ea96-3319-55b8-95a5-7f180a5f3ed4',
        oneClick: false,
        perMachine: false,
        allowElevation: false,
      },
    },
  }));

  const lockPath = path.join(desktop, 'bun.lock');
  const lock = await fs.readFile(lockPath, 'utf8');
  const upstreamName = '"name": "codex-web-gpt-launcher"';
  if (lock.split(upstreamName).length !== 2) throw new Error('DESKTOP_LOCK_IDENTITY_UNEXPECTED');
  await fs.writeFile(lockPath, lock.replace(upstreamName, '"name": "coding-tools-full-harness-desktop"'), 'utf8');

  await fs.writeFile(path.join(desktop, 'electron', 'product.cjs'), `"use strict";\n\nexports.PRODUCT_IDENTITY = Object.freeze({\n  appId: "dev.codingtools.fullharness",\n  productName: "Coding Tools",\n  version: "${TARGET_VERSION}",\n  protocolVersion: 1,\n  connectorName: "Coding Tools Native2",\n  devConnectorName: "Coding Tools Native2 DEV",\n  modelNamespace: "chatgpt-web/",\n});\n`, 'utf8');

  const launcherFiles = await inventory(path.join(vendor, 'launcher'));
  const runtimeFiles = await inventory(vendor);
  await fs.mkdir(path.join(desktop, 'upstream'), { recursive: true });
  await fs.writeFile(path.join(desktop, 'upstream', 'MATERIALIZATION.json'), `${JSON.stringify({
    schema: 1,
    upstream: PIN,
    targetVersion: TARGET_VERSION,
    launcherFiles: launcherFiles.length,
    runtimeFiles: runtimeFiles.length,
    deletedFiles: 0,
    retained,
    strategy: 'adapted launcher root plus exact runtime-web source copy',
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(runtime, 'CODING_TOOLS_INTEGRATION.json'), `${JSON.stringify({
    schema: 1,
    upstream: PIN,
    targetVersion: TARGET_VERSION,
    product: 'Coding Tools',
    sourceUnmodifiedAtMaterialization: true,
  }, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({ desktop, runtime, retained, launcherFiles: launcherFiles.length, runtimeFiles: runtimeFiles.length }, null, 2));
}

await main();
