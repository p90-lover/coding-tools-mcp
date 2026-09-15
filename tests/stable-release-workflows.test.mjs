import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('verified release validates the exact tagged checkout with the shared checker', () => {
  const workflow = read('.github/workflows/release.yml');
  const checker = 'node scripts/check-version-alignment.mjs --tag "$TAG"';
  assert.ok(workflow.includes(checker), 'verified release must invoke the shared checker');
  assert.ok(
    workflow.indexOf(checker) < workflow.indexOf('npm run tauri -- build'),
    'version and bilingual-note validation must happen before installer construction',
  );
});

test('legacy manual macOS publication is retired globally before stable tagging', () => {
  const legacy = read('.github/workflows/macos-release.yml');
  assert.doesNotMatch(legacy, /workflow_dispatch/);
  assert.doesNotMatch(legacy, /gh release upload/);

  const promotion = read('.github/workflows/promote-stable-release.yml');
  const disable = 'actions/workflows/macos-release.yml/disable';
  const tag = 'git tag -a "$TAG"';
  assert.ok(promotion.includes('actions: write'));
  assert.ok(promotion.includes(disable), 'promotion must disable the historical workflow ID');
  assert.ok(promotion.includes('disabled_manually'), 'promotion must verify global disabled state');
  assert.ok(
    promotion.indexOf(disable) < promotion.indexOf(tag),
    'the legacy publisher must be disabled before a stable tag can be created',
  );
});

test('bot-generated preparation commits receive exact-source CI validation', () => {
  const preparation = read('.github/workflows/prepare-stable-release.yml');
  assert.match(preparation, /permissions:[\s\S]*actions:\s*write/);
  assert.ok(preparation.includes('id: commit'));
  assert.ok(preparation.includes('expected_sha="$SOURCE"'));
  assert.ok(preparation.includes('gh workflow run ci.yml'));

  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes('expected_sha:'));
  assert.ok(ci.includes('id: identity'));
  assert.ok(ci.includes("github.sha"));
  assert.ok(ci.includes('needs.identity.outputs.source'));
  assert.ok(
    ci.includes('Requested source does not match the workflow event source'),
    'dispatched CI must fail closed if the ref moved before the event was created',
  );
});
