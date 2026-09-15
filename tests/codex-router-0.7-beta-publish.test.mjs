import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(
  root,
  '.github',
  'workflows',
  'codex-router-multiprovider-release.yml',
);

async function releaseWorkflow() {
  return fs.readFile(workflowPath, 'utf8');
}

test('0.7 beta publication is one-shot and cancels superseded package runs', async () => {
  const workflow = await releaseWorkflow();
  assert.match(workflow, /concurrency:\s*[\s\S]*?cancel-in-progress:\s*true/);
  assert.match(workflow, /\n  publish-beta:\n/);
  assert.match(workflow, /publish-beta:[\s\S]*?needs:\s*\[release-contract, windows-package\]/);
  assert.match(
    workflow,
    /publish-beta:[\s\S]*?if:\s*github\.event_name == 'push' && contains\(github\.event\.head_commit\.message, '\[publish-beta\]'\)/,
  );
  assert.match(workflow, /publish-beta:[\s\S]*?contents:\s*write[\s\S]*?actions:\s*read/);
});

test('0.7 beta publication consumes only exact-run installer and evidence artifacts', async () => {
  const workflow = await releaseWorkflow();
  assert.match(
    workflow,
    /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/,
  );
  assert.match(
    workflow,
    /coding-tools-0\.7\.0-rc\.1-windows-x64-\$\{\{ github\.sha \}\}/,
  );
  assert.match(
    workflow,
    /coding-tools-0\.7\.0-rc\.1-windows-evidence-\$\{\{ github\.sha \}\}/,
  );
  assert.match(workflow, /refs\/heads\/release\/codex-router-multiprovider-0\.7\.0-rc\.1/);
  assert.match(workflow, /windows-installer-source\.txt/);
  assert.match(workflow, /windows-installer\.sha256/);
});

test('0.7 beta publication verifies four immutable assets before and after publishing', async () => {
  const workflow = await releaseWorkflow();
  for (const asset of [
    'Coding.Tools_0.7.0-rc.1_windows_x64_setup.exe',
    'SHA256SUMS.txt',
    'provenance.json',
    'validation-evidence.json',
  ]) {
    assert.match(workflow, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(workflow, /scripts\/release\/verify-assets\.mjs/);
  assert.match(workflow, /scripts\/release\/publish-v0\.6\.0-rc\.1\.mjs/);
  assert.match(workflow, /docs\/releases\/v0\.7\.0-rc\.1\.md/);
  assert.match(workflow, /aiTemp\/publish\/publication-receipt\.json/);
  assert.match(workflow, /prerelease/);
  assert.match(workflow, /pending_manual/);
});
