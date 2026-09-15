import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// PR review validates this contract only; release matrices run on push or workflow_dispatch.
const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(
  root,
  '.github',
  'workflows',
  'electron-full-harness-ci.yml',
);
const workflow = fs.readFileSync(workflowPath, 'utf8');

test('full-harness CI emits the exact artifacts consumed by prerelease promotion', () => {
  for (const required of [
    'name: Electron Full Harness CI',
    'workflow_dispatch:',
    'feature/electron-full-codex-harness-0.6.0',
    'SOURCE_SHA: ${{ github.sha }}',
    'Coding.Tools_0.6.0-rc.1_windows_x64_setup.exe',
    'electron-windows-installer-${{ github.sha }}',
    'electron-full-harness-validation-${{ github.sha }}',
    "validation_workflow: '.github/workflows/electron-full-harness-ci.yml'",
    "live_account_acceptance: 'pending_manual'",
  ]) {
    assert.ok(workflow.includes(required), required);
  }
});

test('full-harness CI is cross-platform, exact-source, and fail-closed on missing producers', () => {
  for (const required of [
    'ubuntu-24.04',
    'windows-latest',
    'macos-15',
    'macos-14',
    'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
    'desktop-electron/scripts/verify-package.cjs',
    'desktop-electron/tests/package-contents.test.cjs',
    'docs/releases/v0.6.0-rc.1.md',
    'rust-core/coding-tools-core/Cargo.toml',
    'rust-core/coding-tools-headless/Cargo.toml',
    'bun install --frozen-lockfile',
    'cargo clippy',
    '-- -D warnings',
    '--source "$SOURCE_SHA"',
    '--json-out aiTemp/evidence/package-verification.json',
    'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
    'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  ]) {
    assert.ok(workflow.includes(required), required);
  }
  assert.match(
    workflow,
    /Require complete release producers[\s\S]*if: \$\{\{ github\.event_name != 'pull_request' \}\}/,
  );
});

test('full-harness CI preserves files and keeps temporary state under aiTemp', () => {
  for (const required of [
    'clean: false',
    'aiTemp/tmp',
    'aiTemp/Trash/full-harness-ci',
    'aiTemp/Trash/full-harness-runtime',
    'aiTemp/Trash/full-harness-package',
    'runtime-web/scripts/no-delete-preload.mjs',
    'git diff --diff-filter=D',
  ]) {
    assert.ok(workflow.includes(required), required);
  }
  for (const forbidden of [
    'git reset --hard',
    'git clean',
    'rm -rf',
    'Remove-Item -Recurse -Force',
    'git push --force',
    'git tag -d',
    'actions/checkout@v',
  ]) {
    assert.equal(workflow.includes(forbidden), false, forbidden);
  }
});
