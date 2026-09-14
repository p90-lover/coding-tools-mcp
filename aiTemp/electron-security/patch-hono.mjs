import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const packagePath = path.join(root, 'runtime-web', 'package.json');
const lockPath = path.join(root, 'runtime-web', 'bun.lock');
const retainedRoot = path.join(root, 'Trash', 'electron-security', runId, 'runtime-web');

async function retain(filePath) {
  const relative = path.relative(path.join(root, 'runtime-web'), filePath);
  const destination = path.join(retainedRoot, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.access(destination);
    throw new Error(`RETENTION_TARGET_EXISTS:${destination}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.copyFile(filePath, destination, fs.constants.COPYFILE_EXCL);
}

await retain(packagePath);
await retain(lockPath);
const manifest = JSON.parse(await fs.readFile(packagePath, 'utf8'));
if (manifest?.overrides?.hono !== '4.12.34') {
  throw new Error(`UNEXPECTED_HONO_OVERRIDE:${manifest?.overrides?.hono}`);
}
manifest.overrides.hono = '4.13.5';
await fs.writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ from: '4.12.34', to: '4.13.5', retainedRoot }, null, 2));
