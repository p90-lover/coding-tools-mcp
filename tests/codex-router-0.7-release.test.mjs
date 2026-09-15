import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const sourceScopeUrl = pathToFileURL(
  path.join(root, 'scripts', 'release', 'verify-source-scope.mjs'),
).href;
const assetsUrl = pathToFileURL(
  path.join(root, 'scripts', 'release', 'verify-assets.mjs'),
).href;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runParameterizedIdentity() {
  const program = `
    const source = await import(${JSON.stringify(sourceScopeUrl)});
    const assets = await import(${JSON.stringify(assetsUrl)});
    const audit = source.auditSourceScope({
      tag: 'v0.7.0-rc.1',
      sourceSha: '7'.repeat(40),
      currentSha: '7'.repeat(40),
      packageManifest: {
        version: '0.7.0-rc.1',
        build: {
          appId: 'dev.codingtools.fullharness',
          productName: 'Coding Tools',
          nsis: { perMachine: false, allowElevation: false },
        },
      },
      upstreamManifest: {
        repository: 'miuuyy/codex-chatgpt-web',
        tag: 'v5.0.6',
        commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612',
      },
    });
    if (!audit.ok) throw new Error(JSON.stringify(audit.errors));
    process.stdout.write(JSON.stringify({
      releaseVersion: source.RELEASE_VERSION,
      releaseTag: source.RELEASE_TAG,
      installer: assets.WINDOWS_INSTALLER,
      validationWorkflow: assets.VALIDATION_WORKFLOW,
      auditVersion: audit.facts.version,
    }));
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_VERSION: '0.7.0-rc.1',
      RELEASE_TAG: 'v0.7.0-rc.1',
      VALIDATION_WORKFLOW: '.github/workflows/codex-router-multiprovider-release.yml',
    },
  });
}

test('release helpers bind a 0.7 promotion to its exact identity and validation workflow', () => {
  const result = runParameterizedIdentity();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    releaseVersion: '0.7.0-rc.1',
    releaseTag: 'v0.7.0-rc.1',
    installer: 'Coding.Tools_0.7.0-rc.1_windows_x64_setup.exe',
    validationWorkflow: '.github/workflows/codex-router-multiprovider-release.yml',
    auditVersion: '0.7.0-rc.1',
  });
});

test('0.7 release notes disclose exact-SHA assets and the manual live-account boundary', async () => {
  const notes = await fs.readFile(
    path.join(root, 'docs', 'releases', 'v0.7.0-rc.1.md'),
    'utf8',
  );
  for (const required of [
    'goal.internal_context',
    'SHA256SUMS.txt',
    'provenance.json',
    'validation-evidence.json',
    'pending_manual',
    'Trash/',
    'aiTemp/',
    '繁體中文',
  ]) {
    assert.match(notes, new RegExp(escapeRegex(required)));
  }
});

test('0.7 packaging publishes only the exact successful run after a stale-head guard', async () => {
  const workflow = await fs.readFile(
    path.join(root, '.github', 'workflows', 'codex-router-multiprovider-release.yml'),
    'utf8',
  );
  for (const required of [
    'publish-prerelease:',
    'needs: windows-package',
    'VALIDATION_WORKFLOW: .github/workflows/codex-router-multiprovider-release.yml',
    'remote_head="$(git ls-remote origin "refs/heads/$GITHUB_REF_NAME" | cut -f1)"',
    'test "$remote_head" = "$SOURCE_SHA"',
    '--name "coding-tools-0.7.0-rc.1-windows-x64-$SOURCE_SHA"',
    'Coding.Tools_0.7.0-rc.1_windows_x64_setup.exe',
    'SHA256SUMS.txt',
    'provenance.json',
    'validation-evidence.json',
    'live_account_acceptance: \'pending_manual\'',
    'scripts/release/verify-assets.mjs',
    'scripts/release/publish-v0.6.0-rc.1.mjs',
    'docs/releases/v0.7.0-rc.1.md',
  ]) {
    assert.match(workflow, new RegExp(escapeRegex(required)));
  }
  assert.doesNotMatch(workflow, /\brm\s+-rf\b|\bgit\s+clean\b/);
});

test('Windows packaging keeps electron-builder cache on the retained aiTemp volume', async () => {
  const workflow = await fs.readFile(
    path.join(root, '.github', 'workflows', 'codex-router-multiprovider-release.yml'),
    'utf8',
  );
  for (const required of [
    'ELECTRON_BUILDER_CACHE: ${{ github.workspace }}/aiTemp/cache/electron-builder',
    'aiTemp/cache/electron-builder',
    'test -d aiTemp/cache/electron-builder',
    'electron_builder_cache=%s',
  ]) {
    assert.match(workflow, new RegExp(escapeRegex(required)));
  }
  assert.doesNotMatch(workflow, /ELECTRON_BUILDER_CACHE:\s*["\']?[A-Za-z]:\\/);
});
