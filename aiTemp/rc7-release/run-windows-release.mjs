import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const releaseVersion = process.env.RELEASE_VERSION ?? '0.7.0-rc.7';
const releaseTag = process.env.RELEASE_TAG ?? `v${releaseVersion}`;
const sourceSha = process.env.GITHUB_SHA ?? runCapture('git', ['rev-parse', 'HEAD']);
const repository = process.env.GITHUB_REPOSITORY;
const branch = process.env.GITHUB_REF_NAME;
const installerName = `Coding.Tools_${releaseVersion}_windows_x64_setup.exe`;
const aiTemp = path.join(root, 'aiTemp');
const temp = path.join(aiTemp, 'tmp', `release-${releaseVersion}`);
const evidence = path.join(aiTemp, 'evidence');
const trash = path.join(aiTemp, 'Trash', `release-${releaseVersion}-windows`);
const assets = path.join(aiTemp, 'release-assets');
const verificationRenderer = path.join(aiTemp, 'rc7-release', 'renderer-dist', sourceSha);
const preload = pathToFileURL(path.join(root, 'runtime-web', 'scripts', 'no-delete-preload.mjs')).href;
const commandLog = [];

for (const directory of [
  temp,
  evidence,
  trash,
  assets,
  verificationRenderer,
  path.join(aiTemp, 'cache', 'electron-builder'),
]) {
  fs.mkdirSync(directory, { recursive: true });
}

const childEnv = {
  ...process.env,
  SOURCE_SHA: sourceSha,
  RELEASE_VERSION: releaseVersion,
  RELEASE_TAG: releaseTag,
  WINDOWS_INSTALLER: installerName,
  CODING_TOOLS_RETENTION_ROOT: trash,
  ELECTRON_BUILDER_CACHE: path.join(aiTemp, 'cache', 'electron-builder'),
  BUN_INSTALL_CACHE_DIR: path.join(aiTemp, 'cache', 'bun-release-rc7'),
  TMPDIR: temp,
  TMP: temp,
  TEMP: temp,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' '),
};

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return String(result.stdout ?? '').trim();
}

function run(command, args, options = {}) {
  const label = options.label ?? `${command} ${args.join(' ')}`;
  commandLog.push(label);
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? childEnv,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeExclusive(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
}

async function downloadTunnelClient() {
  const archiveName = 'tunnel-client-v0.0.12-windows-amd64.zip';
  const expected = '2a2804933924e38a502d62b61f0266cb80d56d65744f4c29876b2bf9c1544356';
  const input = path.join(aiTemp, 'input', 'tunnel-client', 'v0.0.12', 'windows-amd64');
  const archive = path.join(input, archiveName);
  const partial = `${archive}.partial`;
  fs.mkdirSync(input, { recursive: true });
  assert(!fs.existsSync(archive) && !fs.existsSync(partial), 'TUNNEL_ARCHIVE_PATH_NOT_CLEAN');
  const response = await fetch(`https://github.com/openai/tunnel-client/releases/download/v0.0.12/${archiveName}`, { redirect: 'follow' });
  assert(response.ok, `TUNNEL_DOWNLOAD_FAILED:${response.status}`);
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
  assert(sha256(partial) === expected, 'TUNNEL_ARCHIVE_SHA256_MISMATCH');
  fs.renameSync(partial, archive);
  assert(sha256(archive) === expected, 'TUNNEL_ARCHIVE_FINAL_SHA256_MISMATCH');
  childEnv.CODING_TOOLS_TUNNEL_CLIENT_ARCHIVE = archive;
  writeExclusive(path.join(evidence, 'tunnel-client.json'), `${JSON.stringify({ archive, sha256: expected }, null, 2)}\n`);
}

function findInstaller() {
  const roots = ['artifacts', 'release']
    .map((name) => path.join(root, 'desktop-electron', name))
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
  assert(roots.length === 1, `PACKAGE_ROOT_COUNT:${roots.length}`);
  const candidates = fs.readdirSync(roots[0], { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => path.join(roots[0], entry.name));
  assert(candidates.length === 1, `INSTALLER_COUNT:${candidates.length}`);
  return { packageRoot: roots[0], installer: candidates[0] };
}

function requireCleanTrackedSource() {
  run('git', ['diff', '--check'], { env: process.env, label: 'git diff --check' });
  const deleted = runCapture('git', ['diff', '--diff-filter=D', '--name-only']);
  const tracked = runCapture('git', ['status', '--porcelain', '--untracked-files=no']);
  assert(deleted === '', `TRACKED_DELETION_DETECTED:${deleted}`);
  assert(tracked === '', `TRACKED_SOURCE_CHANGED:${tracked}`);
}

async function main() {
  assert(process.platform === 'win32', `WINDOWS_RUNNER_REQUIRED:${process.platform}`);
  assert(releaseVersion === '0.7.0-rc.7', `RELEASE_VERSION_MISMATCH:${releaseVersion}`);
  assert(releaseTag === 'v0.7.0-rc.7', `RELEASE_TAG_MISMATCH:${releaseTag}`);
  assert(repository, 'GITHUB_REPOSITORY_MISSING');
  assert(branch === 'release/codex-router-multiprovider-0.7.0-rc.7', `RELEASE_BRANCH_MISMATCH:${branch}`);
  assert(runCapture('git', ['rev-parse', 'HEAD']) === sourceSha, 'CHECKOUT_SOURCE_SHA_MISMATCH');

  run('bun', ['install', '--frozen-lockfile'], { cwd: path.join(root, 'runtime-web'), label: 'install runtime-web' });
  run('bun', ['install', '--frozen-lockfile'], { cwd: path.join(root, 'runtime-web', 'launcher'), label: 'install launcher' });
  run('bun', ['install', '--frozen-lockfile'], { cwd: path.join(root, 'desktop-electron'), label: 'install desktop' });

  run('bun', ['test', 'tests/runtime-bundle-version.test.ts'], { cwd: path.join(root, 'runtime-web'), label: 'runtime bundle identity test' });
  run('bun', ['run', 'typecheck'], { cwd: path.join(root, 'runtime-web'), label: 'runtime typecheck' });
  run('node', ['--test',
    'desktop-electron/tests/product-identity.test.cjs',
    'desktop-electron/tests/installer-upgrade-migration.test.cjs',
    'desktop-electron/tests/legacy-msi-upgrade-contract.test.cjs',
    'desktop-electron/tests/provider-center-account-wiring.test.cjs',
    'desktop-electron/tests/provider-multiaccount-global-proxy.test.cjs',
    'desktop-electron/tests/commandcode-provider-session.test.cjs',
    'desktop-electron/tests/rc7-full-integration-contract.test.cjs',
    'desktop-electron/tests/rc2-paseo-anneal-network-surfaces.test.cjs',
    'desktop-electron/tests/upstream-tools.test.cjs',
    'desktop-electron/tests/orchestration-localization-layout.test.cjs',
    'desktop-electron/tests/rc6-ui-parity-contract.test.cjs',
  ], { label: 'focused Provider Center, Paseo, Anneal, proxy, and localization contracts' });

  for (const file of [
    'desktop-electron/electron/main.cjs',
    'desktop-electron/electron/main-with-provider.cjs',
    'desktop-electron/electron/provider-execution-router.cjs',
    'desktop-electron/electron/provider-network.cjs',
    'desktop-electron/electron/upstream-tools.cjs',
    'desktop-electron/electron/preload.cjs',
  ]) run('node', ['--check', file], { label: `syntax ${file}` });

  run('bun', ['run', 'typecheck'], { cwd: path.join(root, 'desktop-electron'), label: 'desktop typecheck' });
  run('bun', ['x', 'vite', 'build', '--outDir', verificationRenderer, '--emptyOutDir', 'false'], {
    cwd: path.join(root, 'desktop-electron'),
    label: 'isolated renderer verification build',
  });
  run('node', ['--test', 'desktop-electron/tests/renderer-provider-bundle.test.cjs'], {
    env: {
      ...childEnv,
      CODING_TOOLS_RENDERER_DIST: verificationRenderer,
    },
    label: 'isolated renderer Provider Center bundle contract',
  });

  await downloadTunnelClient();
  run('cargo', ['build', '--release', '--locked', '--manifest-path', 'rust-core/coding-tools-headless/Cargo.toml'], { label: 'Rust headless release build' });
  run('bun', ['run', 'package:win'], { cwd: path.join(root, 'desktop-electron'), label: 'Windows package build' });

  const { packageRoot, installer } = findInstaller();
  run('node', ['desktop-electron/scripts/verify-package.cjs', packageRoot, '--source', sourceSha, '--json-out', path.join(evidence, 'package-verification.json')], { label: 'verify packaged resources and identity' });
  run('node', ['--test', 'desktop-electron/tests/package-contents.test.cjs'], { label: 'package contents contract' });
  run('bun', ['run', 'smoke:package'], { cwd: path.join(root, 'desktop-electron'), label: 'packaged launcher smoke' });

  const releaseInstaller = path.join(assets, installerName);
  assert(!fs.existsSync(releaseInstaller), 'RELEASE_INSTALLER_ALREADY_EXISTS');
  fs.copyFileSync(installer, releaseInstaller, fs.constants.COPYFILE_EXCL);
  assert(fs.statSync(releaseInstaller).size > 0, 'RELEASE_INSTALLER_EMPTY');

  run('pwsh', ['-NoLogo', '-NoProfile', '-File', 'aiTemp/rc7-release/verify-windows-migration.ps1',
    '-InstallerPath', releaseInstaller,
    '-TrashRoot', trash,
    '-EvidenceRoot', evidence,
  ], { env: childEnv, label: 'retained NSIS and MSI migration acceptance' });

  requireCleanTrackedSource();
  const remoteHead = runCapture('git', ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s+/)[0];
  assert(remoteHead === sourceSha, `REMOTE_HEAD_MOVED:${remoteHead}`);
  run('git', ['fetch', '--no-tags', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`], { env: process.env, label: 'fetch exact release ref' });
  run('node', ['scripts/release/verify-source-scope.mjs', '--tag', releaseTag, '--source', sourceSha, '--allowed-ref', `origin/${branch}`, '--json-out', path.join(evidence, 'source-scope.json')], { label: 'verify release source scope' });

  const installerBytes = fs.readFileSync(releaseInstaller);
  const installerSha = crypto.createHash('sha256').update(installerBytes).digest('hex');
  const validationRunId = Number(process.env.GITHUB_RUN_ID);
  const validationRunUrl = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const provenance = {
    schema: 1,
    release_tag: releaseTag,
    version: releaseVersion,
    source_sha: sourceSha,
    product: { name: 'Coding Tools', app_id: 'dev.codingtools.fullharness' },
    upstream: { repository: 'miuuyy/codex-chatgpt-web', version: 'v5.0.6', commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612' },
    validation_run: { id: validationRunId, url: validationRunUrl, workflow: '.github/workflows/codex-router-multiprovider-release-rc7.yml' },
    assets: [{ name: installerName, sha256: installerSha, size: installerBytes.length }],
  };
  const validation = {
    automated_gates: 'passed',
    provider_center_contracts: 'passed',
    paseo_anneal_contracts: 'passed',
    traditional_chinese_contracts: 'passed',
    installer_upgrade_migration: 'passed',
    legacy_nsis_fixture_compiler: 'csc.exe',
    legacy_msi_production_macro: 'passed',
    live_account_acceptance: 'pending_manual',
    source_sha: sourceSha,
    validation_run_id: validationRunId,
    validation_workflow: '.github/workflows/codex-router-multiprovider-release-rc7.yml',
    validation_conclusion: 'success',
  };
  writeExclusive(path.join(assets, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  writeExclusive(path.join(assets, 'validation-evidence.json'), `${JSON.stringify(validation, null, 2)}\n`);
  const checksumNames = fs.readdirSync(assets).filter((name) => name !== 'SHA256SUMS.txt').sort();
  writeExclusive(path.join(assets, 'SHA256SUMS.txt'), `${checksumNames.map((name) => `${sha256(path.join(assets, name))}  ${name}`).join('\n')}\n`);

  run('node', ['scripts/release/verify-assets.mjs', '--directory', assets, '--tag', releaseTag, '--version', releaseVersion, '--source', sourceSha, '--json-out', path.join(evidence, 'asset-verification.json')], { label: 'verify release assets' });
  run('node', ['scripts/release/publish-v0.6.0-rc.1.mjs', '--repository', repository, '--tag', releaseTag, '--source', sourceSha, '--assets', assets, '--notes', 'docs/releases/v0.7.0-rc.7.md', '--json-out', path.join(evidence, 'publication.json')], { label: 'publish and read back rc.7 prerelease' });

  writeExclusive(path.join(evidence, 'windows-release-summary.json'), `${JSON.stringify({ releaseVersion, releaseTag, sourceSha, installerName, installerSha, commands: commandLog }, null, 2)}\n`);
  process.stdout.write(`\nRC7_WINDOWS_RELEASE_PUBLISHED ${releaseTag} ${sourceSha} ${installerSha}\n`);
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
