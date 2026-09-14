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
  const mismatchProvenance = Buffer.from(JSON.stringify({
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
  const mismatchValidation = Buffer.from(JSON.stringify({
    automated_gates: 'passed',
    live_account_acceptance: 'pending_manual',
  }));
  await fs.writeFile(path.join(fixture, 'provenance.json'), mismatchProvenance);
  await fs.writeFile(path.join(fixture, 'validation-evidence.json'), mismatchValidation);
  const mismatchCrypto = await import('node:crypto');
  await fs.writeFile(path.join(fixture, 'SHA256SUMS.txt'), [
    `${'0'.repeat(64)}  ${installer}`,
    `${mismatchCrypto.createHash('sha256').update(mismatchProvenance).digest('hex')}  provenance.json`,
    `${mismatchCrypto.createHash('sha256').update(mismatchValidation).digest('hex')}  validation-evidence.json`,
    '',
  ].join('\n'));

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
    'validation_run_id:',
    'release_tag:',
    'publish_prerelease:',
    'scripts/release/verify-source-scope.mjs',
    'scripts/release/verify-assets.mjs',
    'scripts/release/publish-v0.6.0-rc.1.mjs',
    'desktop-electron',
    'Coding.Tools_0.6.0-rc.1_windows_x64_setup.exe',
    "live_account_acceptance: 'pending_manual'",
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/);
  assert.doesNotMatch(workflow, /npm run tauri -- build/);
});

test('publisher uploads and reads back every asset before creating the non-forced tag', async () => {
  const { publishVerifiedPrerelease } = await load('scripts/release/publish-v0.6.0-rc.1.mjs');
  const crypto = await import('node:crypto');
  const fixture = path.join(root, 'aiTemp', 'publisher-assets');
  await fs.mkdir(fixture, { recursive: true });
  const tag = 'v0.6.0-rc.1';
  const sourceSha = 'd'.repeat(40);
  const installer = 'Coding.Tools_0.6.0-rc.1_windows_x64_setup.exe';
  const installerBytes = Buffer.from('publisher-fixture-installer');
  const installerHash = crypto.createHash('sha256').update(installerBytes).digest('hex');
  const provenance = {
    schema: 1,
    release_tag: tag,
    version: '0.6.0-rc.1',
    source_sha: sourceSha,
    product: { name: 'Coding Tools', app_id: 'dev.codingtools.fullharness' },
    upstream: {
      repository: 'miuuyy/codex-chatgpt-web',
      version: 'v5.0.6',
      commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612',
    },
    assets: [{ name: installer, sha256: installerHash, size: installerBytes.length }],
  };
  const validation = {
    automated_gates: 'passed',
    live_account_acceptance: 'pending_manual',
  };
  const files = new Map([
    [installer, installerBytes],
    ['provenance.json', Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`)],
    ['validation-evidence.json', Buffer.from(`${JSON.stringify(validation, null, 2)}\n`)],
  ]);
  const checksumText = [...files]
    .map(([name, bytes]) => `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`)
    .sort()
    .join('\n') + '\n';
  files.set('SHA256SUMS.txt', Buffer.from(checksumText));
  for (const [name, bytes] of files) await fs.writeFile(path.join(fixture, name), bytes);

  const calls = [];
  const remoteAssets = new Map();
  let release = null;
  let nextAssetId = 1;
  let tagCreated = false;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const pathname = new URL(url).pathname;
    if (method === 'GET' && pathname.endsWith('/releases')) {
      return json(release ? [release] : []);
    }
    if (method === 'GET' && pathname.endsWith(`/releases/tags/${tag}`)) {
      return release ? json(release) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'POST' && pathname.endsWith('/releases')) {
      release = {
        id: 77,
        tag_name: tag,
        name: `Coding Tools ${tag}`,
        draft: true,
        prerelease: true,
        target_commitish: sourceSha,
        upload_url: 'https://uploads.github.test/repos/p90-lover/coding-tools-mcp/releases/77/assets{?name,label}',
        assets: [],
      };
      return json(release, 201);
    }
    if (method === 'POST' && pathname.endsWith('/releases/77/assets')) {
      const name = new URL(url).searchParams.get('name');
      const bytes = Buffer.from(options.body);
      const asset = { id: nextAssetId++, name, size: bytes.length };
      remoteAssets.set(asset.id, bytes);
      release.assets.push(asset);
      return json(asset, 201);
    }
    if (method === 'GET' && pathname.endsWith('/releases/77')) return json(release);
    const assetMatch = pathname.match(/\/releases\/assets\/(\d+)$/);
    if (method === 'GET' && assetMatch) {
      return new Response(remoteAssets.get(Number(assetMatch[1])), { status: 200 });
    }
    if (method === 'GET' && pathname.endsWith(`/git/ref/tags/${tag}`)) {
      return tagCreated
        ? json({ object: { sha: sourceSha } })
        : json({ message: 'Not Found' }, 404);
    }
    if (method === 'POST' && pathname.endsWith('/git/refs')) {
      tagCreated = true;
      return json({ ref: `refs/tags/${tag}`, object: { sha: sourceSha } }, 201);
    }
    if (method === 'PATCH' && pathname.endsWith('/releases/77')) {
      release = { ...release, draft: false, published_at: '2026-09-14T00:00:00Z' };
      return json(release);
    }
    return json({ message: `Unhandled ${method} ${pathname}` }, 500);
  };

  const result = await publishVerifiedPrerelease({
    fetchImpl,
    token: 'test-token-not-a-real-secret',
    repository: 'p90-lover/coding-tools-mcp',
    tag,
    sourceSha,
    assetDirectory: fixture,
    notes: 'Fixture release notes',
    minInstallerBytes: 1,
  });
  assert.equal(result.published, true);
  assert.equal(result.reused, false);
  assert.equal(calls.some((entry) => entry.startsWith('DELETE ')), false);
  const tagIndex = calls.findIndex((entry) => entry.includes('POST https://api.github.com/repos/p90-lover/coding-tools-mcp/git/refs'));
  const publishIndex = calls.findIndex((entry) => entry.includes('PATCH https://api.github.com/repos/p90-lover/coding-tools-mcp/releases/77'));
  const preTagReadbacks = calls.slice(0, tagIndex).filter((entry) => entry.includes('/releases/assets/'));
  assert.equal(preTagReadbacks.length, files.size, calls);
  assert.ok(tagIndex < publishIndex, calls);
});
