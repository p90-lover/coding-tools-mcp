import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RELEASE_VERSION = String(process.env.RELEASE_VERSION ?? '0.6.0-rc.1').trim();
export const RELEASE_TAG = String(process.env.RELEASE_TAG ?? `v${RELEASE_VERSION}`).trim();
export const PRODUCT_NAME = 'Coding Tools';
export const APP_ID = 'dev.codingtools.fullharness';
export const UPSTREAM = Object.freeze({
  repository: 'miuuyy/codex-chatgpt-web',
  tag: 'v5.0.6',
  commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612',
});

function add(errors, code, message) {
  errors.push({ code, message });
}

export function auditSourceScope({
  tag,
  sourceSha,
  currentSha,
  packageManifest,
  upstreamManifest,
}) {
  const version = String(packageManifest?.version ?? '').trim();
  const build = packageManifest?.build ?? {};
  const appId = String(build.appId ?? '').trim();
  const productName = String(build.productName ?? '').trim();
  const nsis = build.nsis ?? {};
  const normalizedTag = String(tag ?? '').trim();
  const normalizedSource = String(sourceSha ?? '').trim().toLowerCase();
  const normalizedCurrent = String(currentSha ?? '').trim().toLowerCase();
  const errors = [];

  if (version !== RELEASE_VERSION) {
    add(errors, 'VERSION_MISMATCH', `desktop-electron version ${version || '<missing>'} must be ${RELEASE_VERSION}`);
  }
  if (normalizedTag !== `v${version}`) {
    add(errors, 'TAG_VERSION_MISMATCH', `release tag ${normalizedTag || '<missing>'} must equal v${version || '<missing>'}`);
  }
  if (appId !== APP_ID) {
    add(errors, 'APP_ID_MISMATCH', `Electron app id ${appId || '<missing>'} must be ${APP_ID}`);
  }
  if (productName !== PRODUCT_NAME) {
    add(errors, 'PRODUCT_NAME_MISMATCH', `Electron product name ${productName || '<missing>'} must be ${PRODUCT_NAME}`);
  }
  if (nsis.perMachine !== false) {
    add(errors, 'NSIS_SCOPE_MISMATCH', 'Windows installer must remain per-user (perMachine=false)');
  }
  if (nsis.allowElevation !== false) {
    add(errors, 'NSIS_ELEVATION_MISMATCH', 'Windows installer must not request elevation (allowElevation=false)');
  }
  if (!/^[0-9a-f]{40}$/.test(normalizedSource)) {
    add(errors, 'SOURCE_SHA_INVALID', 'source SHA must be a full 40-character Git commit');
  }
  if (normalizedCurrent !== normalizedSource) {
    add(errors, 'CHECKOUT_SHA_MISMATCH', `checked-out SHA ${normalizedCurrent || '<missing>'} does not match ${normalizedSource || '<missing>'}`);
  }
  if (upstreamManifest?.repository !== UPSTREAM.repository) {
    add(errors, 'UPSTREAM_REPOSITORY_MISMATCH', `upstream repository must be ${UPSTREAM.repository}`);
  }
  if (upstreamManifest?.tag !== UPSTREAM.tag) {
    add(errors, 'UPSTREAM_TAG_MISMATCH', `upstream tag must be ${UPSTREAM.tag}`);
  }
  if (upstreamManifest?.commit !== UPSTREAM.commit) {
    add(errors, 'UPSTREAM_COMMIT_MISMATCH', `upstream commit must be ${UPSTREAM.commit}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    facts: {
      tag: normalizedTag,
      sourceSha: normalizedSource,
      currentSha: normalizedCurrent,
      version,
      appId,
      productName,
      perMachine: nsis.perMachine,
      allowElevation: nsis.allowElevation,
      upstream: {
        repository: upstreamManifest?.repository ?? null,
        tag: upstreamManifest?.tag ?? null,
        commit: upstreamManifest?.commit ?? null,
      },
    },
  };
}

function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    tag: process.env.RELEASE_TAG ?? '',
    sourceSha: process.env.SOURCE_SHA ?? process.env.GITHUB_SHA ?? '',
    allowedRef: process.env.ALLOWED_RELEASE_REF ?? 'origin/feature/electron-full-codex-harness-0.6.0',
    jsonOut: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--root', '--tag', '--source', '--allowed-ref', '--json-out'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === '--root') options.root = value;
    if (argument === '--tag') options.tag = value;
    if (argument === '--source') options.sourceSha = value;
    if (argument === '--allowed-ref') options.allowedRef = value;
    if (argument === '--json-out') options.jsonOut = value;
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

export async function verifySourceScope({ root, tag, sourceSha, allowedRef }) {
  const repoRoot = path.resolve(root);
  const [packageManifest, upstreamManifest] = await Promise.all([
    readJson(path.join(repoRoot, 'desktop-electron', 'package.json')),
    readJson(path.join(repoRoot, 'vendor', 'codex-chatgpt-web-v5.0.6', 'UPSTREAM_MANIFEST.json')),
  ]);
  const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const result = auditSourceScope({ tag, sourceSha, currentSha, packageManifest, upstreamManifest });

  const ancestry = git(repoRoot, ['merge-base', '--is-ancestor', sourceSha, allowedRef], { allowFailure: true });
  if (ancestry.status !== 0) {
    add(result.errors, 'SOURCE_NOT_ON_RELEASE_BRANCH', `${sourceSha} is not reachable from ${allowedRef}`);
  }

  const tagResult = git(repoRoot, ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { allowFailure: true });
  if (tagResult.status === 0 && tagResult.stdout.trim().toLowerCase() !== String(sourceSha).toLowerCase()) {
    add(result.errors, 'EXISTING_TAG_SHA_MISMATCH', `${tag} already points to ${tagResult.stdout.trim()}`);
  }

  const trackedChanges = git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (trackedChanges.stdout.trim()) {
    add(result.errors, 'TRACKED_TREE_DIRTY', 'tracked files differ from the exact source commit');
  }

  result.ok = result.errors.length === 0;
  result.facts.allowedRef = allowedRef;
  result.facts.existingTagSha = tagResult.status === 0 ? tagResult.stdout.trim() : null;
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await verifySourceScope(options);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.jsonOut) {
    const output = path.resolve(options.root, options.jsonOut);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, serialized, 'utf8');
  }
  process.stdout.write(serialized);
  process.exitCode = result.ok ? 0 : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
