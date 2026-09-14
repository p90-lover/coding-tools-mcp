import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

async function load(relativePath) {
  return import(pathToFileURL(path.join(root, relativePath)).href);
}

test('source scope accepts only the planned 0.6.0-rc.1 Electron identity', async () => {
  const { auditSourceScope } = await load('scripts/release/verify-source-scope.mjs');
  const result = auditSourceScope({
    tag: 'v0.6.0-rc.1',
    sourceSha: 'a'.repeat(40),
    currentSha: 'a'.repeat(40),
    packageManifest: {
      version: '0.6.0-rc.1',
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
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.facts.version, '0.6.0-rc.1');
});

test('source scope rejects the retained Tauri identity as the Electron release product', async () => {
  const { auditSourceScope } = await load('scripts/release/verify-source-scope.mjs');
  const result = auditSourceScope({
    tag: 'v0.6.0-rc.1',
    sourceSha: 'b'.repeat(40),
    currentSha: 'b'.repeat(40),
    packageManifest: {
      version: '0.4.10',
      build: {
        appId: 'com.codingtools.mcp.desktop',
        productName: 'Coding Tools MCP',
        nsis: { perMachine: false, allowElevation: false },
      },
    },
    upstreamManifest: {
      repository: 'miuuyy/codex-chatgpt-web',
      tag: 'v5.0.6',
      commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612',
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((entry) => entry.code),
    ['VERSION_MISMATCH', 'TAG_VERSION_MISMATCH', 'APP_ID_MISMATCH', 'PRODUCT_NAME_MISMATCH'],
  );
});

test('asset verifier rejects a checksum mismatch before publication', async () => {
  const { verifyReleaseAssets } = await load('scripts/release/verify-assets.mjs');
  const fixture = path.join(root, 'aiTemp', 'asset-mismatch');
  await fs.mkdir(fixture, { recursive: true });
  const installer = 'Coding.Tools_0.6.0-rc.1_windows_x64_setup.exe';
  await fs.writeFile(path.join(fixture, installer), Buffer.from('fixture-installer'));
  await fs.writeFile(path.join(fixture, 'provenance.json'), JSON.stringify({
    schema: 1,
    release_tag: 'v0.6.0-rc.1',
    version: '0.6.0-rc.1',
    source_sha: 'c'.repeat(40),
    product: { name: 'Coding Tools', app_id: 'dev.codingtools.fullharness' },
    upstream: {
      repository: 'miuuyy/codex-chatgpt-web',
      version: 'v5.0.6',
      commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612',
    },
    assets: [],
  }));
  await fs.writeFile(path.join(fixture, 'validation-evidence.json'), JSON.stringify({
    automated_gates: 'passed',
    live_account_acceptance: 'pending_manual',
  }));
  await fs.writeFile(path.join(fixture, 'SHA256SUMS.txt'), `${'0'.repeat(64)}  ${installer}\n`);

  await assert.rejects(
    verifyReleaseAssets({
      directory: fixture,
      tag: 'v0.6.0-rc.1',
      version: '0.6.0-rc.1',
      sourceSha: 'c'.repeat(40),
      minInstallerBytes: 1,
    }),
    /ASSET_CHECKSUM_MISMATCH/,
  );
});

test('dedicated release workflow is exact-source, Windows-first, and opt-in publish', async () => {
  const workflow = await fs.readFile(
    path.join(root, '.github', 'workflows', 'electron-full-harness-release.yml'),
    'utf8',
  );
  for (const required of [
    'workflow_dispatch:',
    'source_sha:',
    'release_tag:',
    'publish_prerelease:',
    'scripts/release/verify-source-scope.mjs',
    'scripts/release/verify-assets.mjs',
    'scripts/release/publish-v0.6.0-rc.1.mjs',
    'desktop-electron',
    'package:win',
    'live_account_acceptance: pending_manual',
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/);
  assert.doesNotMatch(workflow, /npm run tauri -- build/);
});
