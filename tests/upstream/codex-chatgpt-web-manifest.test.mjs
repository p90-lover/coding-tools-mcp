import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifestPath = 'vendor/codex-chatgpt-web-v6.1.17/UPSTREAM_MANIFEST.json';
const licensePath = 'vendor/codex-chatgpt-web-v6.1.17/LICENSE';

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
  assert.equal(manifest.tag, 'v6.1.17');
  assert.equal(manifest.commit, '860fa576eb47d9e20d7d8289235bfea94392d2fd');
  assert.equal(manifest.tunnelClientVersion, '0.0.16');
  assert.equal(manifest.licenseSha256, 'd8b06e8d802722749b8f09e4ed1f2439fde0995a09b7e47c65dca3cc54d43d6e');
  assert.ok(manifest.files.length > 100);
  assert.equal(files.size, manifest.files.length, 'manifest paths must be unique');

  assert.deepEqual(files.get('bun.lock'), {
    path: 'bun.lock',
    size: 22080,
    sha256: 'd0f8e12a6f87de6e17defd19c97ece4ee38af131155131f3089148d9b0294ce9',
  });
  assert.deepEqual(files.get('docs/architecture.md'), {
    path: 'docs/architecture.md',
    size: 22434,
    sha256: '0e3804d3e75718cdc855f75b0a6e0e2e4df543d2b9e24d1be1ba59813c63c44a',
  });
  assert.deepEqual(files.get('launcher/package.json'), {
    path: 'launcher/package.json',
    size: 2924,
    sha256: '8895aba395385dc0c4d0c9c60d392ad5e90b608dd8f0addbf77c5ada25662de6',
  });
});

test('retains the upstream MIT license notice exactly', () => {
  const license = fs.readFileSync(licensePath, 'utf8');
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 codex-chatgpt-web contributors\n/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  assert.equal(license.endsWith('\n'), true);
});
