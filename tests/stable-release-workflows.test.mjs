import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('verified release validates the exact tagged checkout with the shared checker', () => {
  const workflow = read('.github/workflows/release.yml');
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts.precheck, 'npm run check:version');
  assert.ok(workflow.includes('ref: ${{ needs.identity.outputs.source }}'));
  assert.ok(workflow.includes('TAG: ${{ needs.identity.outputs.tag }}'));
  assert.ok(workflow.includes('npm run check 2>&1 | tee'));
  assert.ok(
    workflow.indexOf('npm run check 2>&1 | tee') < workflow.indexOf('npm run tauri -- build'),
    'shared version and bilingual-note validation must happen before installer construction',
  );
});

test('legacy manual macOS publication is retired globally before stable tagging', () => {
  const legacy = read('.github/workflows/macos-release.yml');
  assert.doesNotMatch(legacy, /workflow_dispatch/);
  assert.doesNotMatch(legacy, /gh release upload/);

  const preparation = read('.github/workflows/prepare-stable-release.yml');
  const promotion = read('.github/workflows/promote-stable-release.yml');
  const list = 'actions/workflows?per_page=100';
  const disable = 'actions/workflows/$workflow_id/disable';
  const tag = 'git tag -a "$TAG"';
  for (const workflow of [preparation, promotion]) {
    assert.ok(workflow.includes('actions: write'));
    assert.ok(workflow.includes('--paginate'));
    assert.ok(workflow.includes(list));
    assert.ok(workflow.includes('.github/workflows/macos-release.yml'));
    assert.ok(workflow.includes('workflow_id'));
    assert.ok(workflow.includes(disable), 'workflow must disable the resolved numeric workflow ID');
    assert.ok(workflow.includes('disabled_manually'), 'workflow must verify global disabled state');
    assert.ok(
      workflow.indexOf(list) < workflow.indexOf(disable),
      'workflow ID resolution must happen before the disable request',
    );
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
