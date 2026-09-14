import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditOAuthReleaseContract } from '../scripts/verify-oauth-release-contract.mjs';

const currentElectronPackage = {
  version: '0.6.0-rc.1',
  build: {
    appId: 'dev.codingtools.fullharness',
    directories: { output: 'release' },
    artifactName: 'Coding.Tools_${version}_${os}_${arch}.${ext}',
  },
};

test('rejects a Tauri-only release path for the Electron OAuth product', () => {
  const result = auditOAuthReleaseContract({
    expectedVersion: '0.6.0',
    expectedAppId: 'dev.codingtools.fullharness',
    rootPackage: { version: '0.4.10' },
    electronPackage: currentElectronPackage,
    tauriConfig: {
      version: '0.4.10',
      identifier: 'com.codingtools.mcp.desktop',
    },
    releaseWorkflow: `
      versions = [json.loads((root/p).read_text())['version']
        for p in ['package.json','package-lock.json','src-tauri/tauri.conf.json']]
      npm run tauri -- build --bundles nsis
      path: aiTemp/cargo-target/release/bundle/nsis/*.exe
    `,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map(({ code }) => code),
    [
      'ELECTRON_VERSION_MISMATCH',
      'RELEASE_VERSION_SOURCE_WRONG_PRODUCT',
      'RELEASE_BUILD_WRONG_PRODUCT',
      'RELEASE_ARTIFACT_WRONG_PRODUCT',
      'RELEASE_APP_ID_WRONG_PRODUCT',
    ],
  );
  assert.equal(result.facts.releaseTarget, 'tauri');
  assert.equal(result.facts.shippedAppId, 'com.codingtools.mcp.desktop');
});

test('accepts the actual Electron artifacts directory through the CLI', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const fixture = path.join(
    path.dirname(testDir),
    'aiTemp',
    `oauth-release-contract-positive-${process.pid}`,
  );
  fs.mkdirSync(path.join(fixture, 'desktop-electron'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'src-tauri'), { recursive: true });
  fs.mkdirSync(path.join(fixture, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({ version: '0.4.10' }),
  );
  fs.writeFileSync(
    path.join(fixture, 'desktop-electron', 'package.json'),
    JSON.stringify({
      version: '0.6.0',
      build: {
        appId: 'dev.codingtools.fullharness',
        directories: { output: 'release' },
      },
    }),
  );
  fs.writeFileSync(
    path.join(fixture, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({
      version: '0.4.10',
      identifier: 'com.codingtools.mcp.desktop',
    }),
  );
  fs.writeFileSync(
    path.join(fixture, '.github', 'workflows', 'release.yml'),
    `
      - run: node -e "require('./desktop-electron/package.json')"
      - working-directory: desktop-electron
        run: bun run package:win
      - uses: actions/upload-artifact@v4
        with:
          path: desktop-electron/artifacts/*.exe
    `,
  );

  const command = spawnSync(
    process.execPath,
    [
      path.join(path.dirname(testDir), 'scripts', 'verify-oauth-release-contract.mjs'),
      '--root',
      fixture,
      '--expected-version',
      '0.6.0',
      '--expected-app-id',
      'dev.codingtools.fullharness',
      '--json',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(command.status, 0, command.stderr || command.stdout);
  assert.notEqual(command.stdout.trim(), '', 'CLI must emit the JSON audit');
  const result = JSON.parse(command.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.facts.releaseTarget, 'electron');
  assert.equal(result.facts.shippedAppId, 'dev.codingtools.fullharness');
  assert.equal(result.facts.publishesElectron, true);
});

test('rejects an Electron package with the wrong OAuth app identity', () => {
  const result = auditOAuthReleaseContract({
    expectedVersion: '0.6.0',
    expectedAppId: 'dev.codingtools.fullharness',
    rootPackage: { version: '0.4.10' },
    electronPackage: {
      version: '0.6.0',
      build: {
        appId: 'com.example.different-product',
        directories: { output: 'release' },
      },
    },
    tauriConfig: {
      version: '0.4.10',
      identifier: 'com.codingtools.mcp.desktop',
    },
    releaseWorkflow: `
      - run: node -e "require('./desktop-electron/package.json')"
      - working-directory: desktop-electron
        run: bun run package:win
      - uses: actions/upload-artifact@v4
        with:
          path: desktop-electron/artifacts/*.exe
    `,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map(({ code }) => code),
    ['ELECTRON_APP_ID_MISMATCH'],
  );
  assert.equal(result.facts.shippedAppId, 'com.example.different-product');
});
