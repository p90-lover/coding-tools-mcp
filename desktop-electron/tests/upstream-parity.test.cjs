const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'));
}

test('adapted launcher retains all pinned upstream verification entrypoints', () => {
  const product = readJson('package.json');
  const required = [
    'dev', 'audit', 'typecheck', 'build:renderer', 'build', 'build:runtime',
    'package', 'package:mac', 'package:win', 'package:linux', 'smoke:package', 'test', 'start',
  ];
  for (const script of required) assert.equal(typeof product.scripts?.[script], 'string', script);
  assert.equal(product.version, '0.6.0');
  assert.equal(product.build.appId, 'dev.codingtools.fullharness');
  assert.equal(product.build.productName, 'Coding Tools');
});

test('runtime retains Browser-only Full Zero Risk compaction and subagent verification commands', () => {
  const runtime = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../runtime-web/package.json'), 'utf8'));
  const required = [
    'start', 'setup', 'doctor', 'dev:launcher', 'dev:chat', 'test', 'audit',
    'typecheck', 'build', 'smoke', 'smoke:codex', 'smoke:cancel', 'smoke:interrupt',
    'smoke:subagents', 'launcher', 'app', 'app:package', 'app:smoke', 'verify',
  ];
  for (const script of required) assert.equal(typeof runtime.scripts?.[script], 'string', script);
  assert.equal(runtime.version, '5.0.6');
});

test('exact source pin remains available beside adapted workspaces', () => {
  const mapping = readJson('upstream/MATERIALIZATION.json');
  const vendorManifest = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../vendor/codex-chatgpt-web-v5.0.6/UPSTREAM_MANIFEST.json'),
    'utf8',
  ));
  assert.equal(mapping.upstream.commit, vendorManifest.commit);
  assert.equal(mapping.upstream.tunnelClientVersion, vendorManifest.tunnelClientVersion);
  assert.equal(mapping.deletedFiles, 0);
});
