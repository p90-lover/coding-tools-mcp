import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareStableVersions,
  parseCargoLockVersion,
  parseCargoTomlPackage,
  parseExpectedTag,
  validateBilingualReleaseNotes,
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

const bilingualNotes = `# v0.4.10

## English

English release details.

## 繁體中文

繁體中文發佈內容。
`;

test('compares stable versions without allowing lexical ordering errors', () => {
  assert.equal(compareStableVersions('0.4.11', '0.4.10'), 1);
  assert.equal(compareStableVersions('0.10.0', '0.9.99'), 1);
  assert.equal(compareStableVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareStableVersions('0.4.9', '0.4.10'), -1);
  assert.throws(
    () => compareStableVersions('0.4.11-rc.1', '0.4.10'),
    /requested version must be stable X\.Y\.Z/,
  );
});

test('requires one nonempty English and Traditional Chinese release-note section', () => {
  assert.deepEqual(validateBilingualReleaseNotes(bilingualNotes, 'v0.4.10'), {
    english: 'English release details.',
    traditionalChinese: '繁體中文發佈內容。',
  });
  assert.throws(
    () =>
      validateBilingualReleaseNotes(
        '# v0.4.10\n\n## English\n\nEnglish only.\n',
        'v0.4.10',
      ),
    /exactly one "## 繁體中文" section/,
  );
  assert.throws(
    () =>
      validateBilingualReleaseNotes(
        '# v0.4.10\n\n## English\n\n\n## 繁體中文\n\n內容。\n',
        'v0.4.10',
      ),
    /empty "## English" section/,
  );
});

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

test('accepts aligned stable versions, matching tag, and bilingual release notes', () => {
  assert.deepEqual(
    validateVersionAlignment({
      versions: alignedVersions,
      expectedTag: 'v0.4.10',
      releaseNotesExists: true,
      releaseNotesContent: bilingualNotes,
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
        releaseNotesContent: bilingualNotes,
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
        releaseNotesContent: bilingualNotes,
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
        releaseNotesContent: '',
      }),
    /Missing release notes: docs\/releases\/v0\.4\.10\.md/,
  );
});

test('parses an explicit tag without inheriting unrelated environment state', () => {
  assert.equal(parseExpectedTag(['--tag', 'v0.4.10'], {}), 'v0.4.10');
  assert.throws(() => parseExpectedTag(['--tag'], {}), /requires a value/);
  assert.throws(() => parseExpectedTag(['--unknown'], {}), /Unknown argument/);
});
