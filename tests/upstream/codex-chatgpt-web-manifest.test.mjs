import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifestPath = 'vendor/codex-chatgpt-web-v5.0.6/UPSTREAM_MANIFEST.json';
const licensePath = 'vendor/codex-chatgpt-web-v5.0.6/LICENSE';

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function indexedFiles(manifest) {
  return new Map(manifest.files.map((entry) => [entry.path, entry]));
}

test('pins the reviewed codex-chatgpt-web identity', () => {
  const manifest = readJson(manifestPath);
  const files = indexedFiles(manifest);

  assert.equal(manifest.schema, 1);
  assert.equal(manifest.repository, 'miuuyy/codex-chatgpt-web');
  assert.equal(manifest.tag, 'v5.0.6');
  assert.equal(manifest.commit, 'e85e3693fdb4e3e033348c08df0298c20fcdb612');
  assert.equal(manifest.tunnelClientVersion, '0.0.12');
  assert.equal(manifest.licenseSha256, 'd8b06e8d802722749b8f09e4ed1f2439fde0995a09b7e47c65dca3cc54d43d6e');
  assert.ok(manifest.files.length > 100);
  assert.equal(files.size, manifest.files.length, 'manifest paths must be unique');

  assert.deepEqual(files.get('bun.lock'), {
    path: 'bun.lock',
    size: 22288,
    sha256: '8330061dc8cb8a647cb7af6263a579beebbac6035036dfe8bf8a3fc16de32e60',
  });
  assert.deepEqual(files.get('docs/architecture.md'), {
    path: 'docs/architecture.md',
    size: 16654,
    sha256: '6b6e7a6b69c74bbc544f2f044a35f6b49e1b12b7662fd647d23e132f804aa3ad',
  });
  assert.deepEqual(files.get('launcher/package.json'), {
    path: 'launcher/package.json',
    size: 2792,
    sha256: '0855b0fae0dba65a954ad9e990acea6bcd90c9c450b1d410be5c1d2f3a7624d7',
  });
});

test('retains the upstream MIT license notice exactly', () => {
  const license = fs.readFileSync(licensePath, 'utf8');
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 codex-chatgpt-web contributors\n/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  assert.equal(license.endsWith('\n'), true);
});
