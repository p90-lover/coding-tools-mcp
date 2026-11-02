import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyTree, writeManifest } from '../scripts/lib/upstream-manifest.mjs';

const PIN = Object.freeze({
  repository: 'miuuyy/codex-chatgpt-web',
  tag: 'v6.1.17',
  commit: '860fa576eb47d9e20d7d8289235bfea94392d2fd',
  tunnelClientVersion: '0.0.16',
});

test('rejects a changed pinned upstream byte', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-tools-upstream-'));
  const source = path.join(root, 'source');
  const manifest = path.join(source, 'UPSTREAM_MANIFEST.json');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, 'LICENSE'),
    'MIT License\n\nCopyright (c) 2026 codex-chatgpt-web contributors\n',
    'utf8',
  );
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'tunnel.ts'), 'export const TUNNEL_VERSION = "0.0.16";\n', 'utf8');
  await fs.writeFile(path.join(source, 'README.md'), 'before\n', 'utf8');
  await writeManifest(source, manifest, PIN);
  await fs.writeFile(path.join(source, 'README.md'), 'after\n', 'utf8');
  await assert.rejects(() => verifyTree(source, manifest, PIN), /UPSTREAM_MANIFEST_MISMATCH/);
});

test('accepts the exact v6.1.17 inventory and MIT notice', async () => {
  const result = await verifyTree(
    'vendor/codex-chatgpt-web-v6.1.17',
    'vendor/codex-chatgpt-web-v6.1.17/UPSTREAM_MANIFEST.json',
    PIN,
  );
  assert.ok(result.files > 100, result);
  assert.ok(result.bytes > 1_000_000, result);
  assert.equal(result.tunnelClientVersion, '0.0.16');
});
