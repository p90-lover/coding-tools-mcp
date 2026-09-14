// The workflow reruns this materialization after each verifier repair so only
// a dependency set that passes the complete pinned harness can be committed.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const retainedRoot = path.join(root, 'Trash', 'electron-security', runId);
const targets = [
  ['runtime-web/package.json', 'runtime-web/bun.lock'],
  ['runtime-web/launcher/package.json', 'runtime-web/launcher/bun.lock'],
  ['desktop-electron/package.json', 'desktop-electron/bun.lock'],
];

async function retain(relativePath) {
  const filePath = path.join(root, relativePath);
  const destination = path.join(retainedRoot, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.access(destination);
    throw new Error(`RETENTION_TARGET_EXISTS:${destination}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.copyFile(filePath, destination, fs.constants.COPYFILE_EXCL);
}

for (const [packagePath, lockPath] of targets) {
  await retain(packagePath);
  await retain(lockPath);
}

const runtimePath = path.join(root, 'runtime-web', 'package.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
if (runtime?.overrides?.hono !== '4.12.34') {
  throw new Error(`UNEXPECTED_HONO_OVERRIDE:${runtime?.overrides?.hono}`);
}
runtime.overrides.hono = '4.13.5';
await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');

for (const relativePath of ['runtime-web/launcher/package.json', 'desktop-electron/package.json']) {
  const packagePath = path.join(root, relativePath);
  const manifest = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  manifest.overrides ||= {};
  const current = manifest.overrides['js-yaml'];
  if (current !== undefined && current !== '4.3.1') {
    throw new Error(`UNEXPECTED_JS_YAML_OVERRIDE:${relativePath}:${current}`);
  }
  manifest.overrides['js-yaml'] = '4.3.2';
  await fs.writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
  hono: { from: '4.12.34', to: '4.13.5' },
  jsYaml: { from: 'transitive 4.3.1', to: '4.3.2' },
  retainedRoot,
}, null, 2));
