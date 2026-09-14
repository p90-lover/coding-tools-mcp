import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EXCLUDED = new Set(['.git', 'UPSTREAM_MANIFEST.json']);

function posix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function walk(root, current, rows) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = posix(path.relative(root, absolute));
    if (EXCLUDED.has(relative) || EXCLUDED.has(relative.split('/')[0])) continue;
    const metadata = await fs.lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`UPSTREAM_SYMLINK_REJECTED:${relative}`);
    if (metadata.isDirectory()) {
      await walk(root, absolute, rows);
    } else if (metadata.isFile()) {
      const bytes = await fs.readFile(absolute);
      rows.push({
        path: relative,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    } else {
      throw new Error(`UPSTREAM_NON_FILE_REJECTED:${relative}`);
    }
  }
}

export async function inventory(root) {
  const absolute = path.resolve(root);
  const metadata = await fs.stat(absolute);
  if (!metadata.isDirectory()) throw new Error('UPSTREAM_ROOT_NOT_DIRECTORY');
  const rows = [];
  await walk(absolute, absolute, rows);
  return rows.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export async function readManifest(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest?.schema !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('UPSTREAM_MANIFEST_SCHEMA_INVALID');
  }
  return manifest;
}

export async function writeManifest(root, manifestPath, pin) {
  const source = await fs.readFile(path.join(root, 'src', 'tunnel.ts'), 'utf8');
  const version = source.match(/TUNNEL_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  if (version !== pin.tunnelClientVersion) throw new Error('UPSTREAM_TUNNEL_VERSION_MISMATCH');
  const license = await fs.readFile(path.join(root, 'LICENSE'), 'utf8');
  if (!license.includes('MIT License') || !license.includes('codex-chatgpt-web contributors')) {
    throw new Error('UPSTREAM_LICENSE_MISMATCH');
  }
  const manifest = {
    schema: 1,
    repository: pin.repository,
    tag: pin.tag,
    commit: pin.commit,
    tunnelClientVersion: version,
    licenseSha256: crypto.createHash('sha256').update(license, 'utf8').digest('hex'),
    files: await inventory(root),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function verifyTree(root, manifestPath, pin) {
  const manifest = await readManifest(manifestPath);
  for (const field of ['repository', 'tag', 'commit', 'tunnelClientVersion']) {
    if (manifest[field] !== pin[field]) throw new Error(`UPSTREAM_MANIFEST_PIN_MISMATCH:${field}`);
  }
  const source = await fs.readFile(path.join(root, 'src', 'tunnel.ts'), 'utf8');
  const version = source.match(/TUNNEL_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  if (version !== pin.tunnelClientVersion) throw new Error('UPSTREAM_TUNNEL_VERSION_MISMATCH');
  const license = await fs.readFile(path.join(root, 'LICENSE'), 'utf8');
  const licenseHash = crypto.createHash('sha256').update(license, 'utf8').digest('hex');
  if (licenseHash !== manifest.licenseSha256) throw new Error('UPSTREAM_LICENSE_HASH_MISMATCH');
  const actual = await inventory(root);
  try {
    assert.deepStrictEqual(actual, manifest.files);
  } catch (error) {
    throw new Error(`UPSTREAM_MANIFEST_MISMATCH:${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    files: actual.length,
    bytes: actual.reduce((sum, entry) => sum + entry.size, 0),
    tunnelClientVersion: version,
    licenseSha256: licenseHash,
  };
}
