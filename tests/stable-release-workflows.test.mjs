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

  const preparation = read('.github/workflows/prepare-stable-release.yml');
  const promotion = read('.github/workflows/promote-stable-release.yml');
  const disable = 'actions/workflows/macos-release.yml/disable';
  const tag = 'git tag -a "$TAG"';
  for (const workflow of [preparation, promotion]) {
    assert.ok(workflow.includes('actions: write'));
    assert.ok(workflow.includes(disable), 'workflow must disable the historical workflow ID');
    assert.ok(workflow.includes('disabled_manually'), 'workflow must verify global disabled state');
  }
  assert.ok(
    promotion.indexOf(disable) < promotion.indexOf(tag),
    'the legacy publisher must be disabled before a stable tag can be created',
  );
});

test('preparation validates its exact final head after any generated commit', () => {
  const preparation = read('.github/workflows/prepare-stable-release.yml');
  assert.match(preparation, /permissions:[\s\S]*actions:\s*write/);
  assert.ok(preparation.includes('id: commit'));
  assert.ok(preparation.includes('source="$(git rev-parse HEAD)"'));
  assert.ok(preparation.includes('gh workflow run ci.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME"'));
  assert.ok(preparation.includes('head_sha'));
  assert.ok(preparation.includes('gh run watch "$run_id" --repo "$GITHUB_REPOSITORY" --exit-status'));
  assert.ok(
    preparation.indexOf('git push origin "HEAD:$GITHUB_REF_NAME"') <
      preparation.indexOf('gh workflow run ci.yml'),
    'exact-source CI dispatch must happen after the generated commit is pushed',
  );
});
