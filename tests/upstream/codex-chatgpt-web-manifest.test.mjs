import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifestPath = 'vendor/codex-chatgpt-web-v6.1.12/UPSTREAM_MANIFEST.json';
const licensePath = 'vendor/codex-chatgpt-web-v6.1.12/LICENSE';

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
  assert.equal(manifest.tag, 'v6.1.12');
  assert.equal(manifest.commit, 'cdfceafd51df9ab6f19818c145eac5a99c593a3d');
  assert.equal(manifest.tunnelClientVersion, '0.0.16');
  assert.equal(manifest.licenseSha256, 'd8b06e8d802722749b8f09e4ed1f2439fde0995a09b7e47c65dca3cc54d43d6e');
  assert.ok(manifest.files.length > 100);
  assert.equal(files.size, manifest.files.length, 'manifest paths must be unique');

  assert.deepEqual(files.get('bun.lock'), {
    path: 'bun.lock',
    size: 22802,
    sha256: '298a89f9a9f050fbb7c4c839cc56966c1cb214c0369bc98221c6a262c6adb6a0',
  });
  assert.deepEqual(files.get('docs/architecture.md'), {
    path: 'docs/architecture.md',
    size: 21938,
    sha256: '8fb5bc610264f7324b1f02edf5a3bf07e81302e2f13bb3787f94a5a0df54638e',
  });
  assert.deepEqual(files.get('launcher/package.json'), {
    path: 'launcher/package.json',
    size: 2923,
    sha256: '81aa7b9c2882837be204ac0af951074d0bdead0b1adaff563ce089314414bab0',
  });
});

test('retains the upstream MIT license notice exactly', () => {
  const license = fs.readFileSync(licensePath, 'utf8');
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 codex-chatgpt-web contributors\n/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  assert.equal(license.endsWith('\n'), true);
});
