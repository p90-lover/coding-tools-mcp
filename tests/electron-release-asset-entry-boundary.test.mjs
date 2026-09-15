import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { verifyReleaseAssets } from '../scripts/release/verify-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tag = 'v0.6.0-rc.1';
const version = '0.6.0-rc.1';
const installer = `Coding.Tools_${version}_windows_x64_setup.exe`;

async function writeValidFixture(name) {
  const sourceSha = crypto.createHash('sha1').update(`${name}-${Date.now()}-${Math.random()}`).digest('hex');
  const fixture = path.join(
    root,
    'aiTemp',
    `release-asset-entry-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await fs.mkdir(fixture, { recursive: true });

  const installerBytes = Buffer.from(`fixture-installer-${name}`);
  const installerHash = crypto.createHash('sha256').update(installerBytes).digest('hex');
  const provenance = {
    schema: 1,
    release_tag: tag,
    version,
    source_sha: sourceSha,
    product: { name: 'Coding Tools', app_id: 'dev.codingtools.fullharness' },
    upstream: {
      repository: 'miuuyy/codex-chatgpt-web',
      version: 'v5.0.6',
      commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612',
    },
    validation_run: {
      id: 987654,
      url: 'https://github.com/p90-lover/coding-tools-mcp/actions/runs/987654',
      workflow: '.github/workflows/electron-full-harness-ci.yml',
    },
    assets: [{ name: installer, sha256: installerHash, size: installerBytes.length }],
  };
  const validation = {
    automated_gates: 'passed',
    live_account_acceptance: 'pending_manual',
    source_sha: sourceSha,
    validation_run_id: 987654,
    validation_workflow: '.github/workflows/electron-full-harness-ci.yml',
    validation_conclusion: 'success',
  };

  const files = new Map([
    [installer, installerBytes],
    ['provenance.json', Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`)],
    ['validation-evidence.json', Buffer.from(`${JSON.stringify(validation, null, 2)}\n`)],
  ]);
  const checksumText = [...files]
    .map(([fileName, bytes]) => `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${fileName}`)
    .sort()
    .join('\n') + '\n';
  files.set('SHA256SUMS.txt', Buffer.from(checksumText));

  for (const [fileName, bytes] of files) {
    await fs.writeFile(path.join(fixture, fileName), bytes);
  }

  return { fixture, sourceSha };
}

function verificationOptions(fixture, sourceSha) {
  return {
    directory: fixture,
    tag,
    version,
    sourceSha,
    minInstallerBytes: 1,
  };
}

test('asset verifier rejects an unexpected directory in the release inventory', async () => {
  const { fixture, sourceSha } = await writeValidFixture('directory');
  await fs.mkdir(path.join(fixture, 'unexpected-directory'));

  await assert.rejects(
    verifyReleaseAssets(verificationOptions(fixture, sourceSha)),
    (error) => error?.code === 'ASSET_ENTRY_UNSUPPORTED'
      && /unexpected-directory/.test(error.message),
  );
});

test('asset verifier rejects a symlink without following it when symlinks are supported', async (t) => {
  const { fixture, sourceSha } = await writeValidFixture('symlink');
  const linkPath = path.join(fixture, 'outside-link');

  try {
    await fs.symlink(path.join(fixture, 'provenance.json'), linkPath, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`symlinks are unavailable on this runner: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    verifyReleaseAssets(verificationOptions(fixture, sourceSha)),
    (error) => error?.code === 'ASSET_SYMLINK_FORBIDDEN'
      && /outside-link/.test(error.message),
  );
});
