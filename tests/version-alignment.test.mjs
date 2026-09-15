import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCargoLockVersion,
  parseCargoTomlPackage,
  parseExpectedTag,
  validateVersionAlignment,
} from '../scripts/check-version-alignment.mjs';

const alignedVersions = {
  'package.json': '0.4.10',
  'package-lock.json': '0.4.10',
  'package-lock.json packages[""]': '0.4.10',
  'src-tauri/tauri.conf.json': '0.4.10',
  'src-tauri/Cargo.toml': '0.4.10',
  'src-tauri/Cargo.lock': '0.4.10',
};

test('parses the root Cargo package instead of dependency versions', () => {
  const manifest = `
[package]
name = "coding-tools-mcp-desktop"
version = "0.4.10"

[dependencies]
semver = "1"
`;
  assert.deepEqual(parseCargoTomlPackage(manifest), {
    name: 'coding-tools-mcp-desktop',
    version: '0.4.10',
  });
});

test('finds the matching root package version in Cargo.lock', () => {
  const lock = `
[[package]]
name = "dependency"
version = "9.9.9"

[[package]]
name = "coding-tools-mcp-desktop"
version = "0.4.10"
dependencies = ["dependency"]
`;
  assert.equal(parseCargoLockVersion(lock, 'coding-tools-mcp-desktop'), '0.4.10');
});

test('accepts aligned stable versions, matching tag, and release notes', () => {
  assert.deepEqual(
    validateVersionAlignment({
      versions: alignedVersions,
      expectedTag: 'v0.4.10',
      releaseNotesExists: true,
    }),
    { version: '0.4.10', tag: 'v0.4.10' },
  );
});

test('reports every mismatched version source before release', () => {
  assert.throws(
    () =>
      validateVersionAlignment({
        versions: { ...alignedVersions, 'src-tauri/Cargo.lock': '0.4.9' },
        expectedTag: '',
        releaseNotesExists: true,
      }),
    /Version mismatch:.*src-tauri\/Cargo\.lock=0\.4\.9/,
  );
});

test('rejects a tag that does not exactly match the synchronized version', () => {
  assert.throws(
    () =>
      validateVersionAlignment({
        versions: alignedVersions,
        expectedTag: 'v0.4.11',
        releaseNotesExists: true,
      }),
    /Tag mismatch: expected v0\.4\.10, received v0\.4\.11/,
  );
});

test('requires release notes for the synchronized version', () => {
  assert.throws(
    () =>
      validateVersionAlignment({
        versions: alignedVersions,
        expectedTag: '',
        releaseNotesExists: false,
      }),
    /Missing release notes: docs\/releases\/v0\.4\.10\.md/,
  );
});

test('parses an explicit tag without inheriting unrelated environment state', () => {
  assert.equal(parseExpectedTag(['--tag', 'v0.4.10'], {}), 'v0.4.10');
  assert.throws(() => parseExpectedTag(['--tag'], {}), /requires a value/);
  assert.throws(() => parseExpectedTag(['--unknown'], {}), /Unknown argument/);
});
