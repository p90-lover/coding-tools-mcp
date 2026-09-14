import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifestPath = 'vendor/codex-chatgpt-web-v5.0.6/UPSTREAM.json';
const licensePath = 'vendor/codex-chatgpt-web-v5.0.6/LICENSE';

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

test('pins the reviewed codex-chatgpt-web identity', () => {
  const manifest = readJson(manifestPath);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.repository, 'https://github.com/miuuyy/codex-chatgpt-web');
  assert.equal(manifest.version, '5.0.6');
  assert.equal(manifest.commit, 'e85e3693fdb4e3e033348c08df0298c20fcdb612');
  assert.equal(manifest.tree, '8fea03f91b92cd588d3c5584f048beba2667cdb6');
  assert.equal(manifest.packageManager, 'bun@1.4.0');
  assert.deepEqual(manifest.buildInputs, ['package.json', 'bun.lock', 'launcher/package.json', 'launcher/bun.lock']);

  assert.deepEqual(manifest.requiredFiles, {
    LICENSE: '99a9feb4d2246a1fe00eb0f27394a97497af32cf',
    'package.json': '8456912ea3ebe25e370b6328bbff983dabe5ffa2',
    'bun.lock': '899853cc5fdf88e5bef0809e465c4f3e7f6b2df9',
    'launcher/package.json': 'cf9d469debf42e2aa73614bc9825b48f9668ad3e',
    'launcher/bun.lock': 'e89aee1fe8f9108caa0139bdc714d239d4b62da3',
    'docs/architecture.md': '58f39ad9c2a97ab3d9b8c297597df59019412582',
    'docs/security-model.md': '9040d4cafb57502af650ab3a732937eb9b35dc74',
  });
});

test('retains the upstream MIT license notice exactly', () => {
  const license = fs.readFileSync(licensePath, 'utf8');
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 codex-chatgpt-web contributors\n/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  assert.equal(license.endsWith('\n'), true);
});
