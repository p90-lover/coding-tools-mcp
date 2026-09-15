import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { RELEASE_TAG, RELEASE_VERSION } from './verify-source-scope.mjs';
import { verifyReleaseAssets } from './verify-assets.mjs';

const API_ROOT = 'https://api.github.com';
const RELEASE_NAME = `Coding Tools ${RELEASE_TAG}`;

function assertValue(condition, code, detail) {
  if (!condition) {
    const error = new Error(`${code}: ${detail}`);
    error.code = code;
    throw error;
  }
}

function headers(token, extra = {}) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'coding-tools-electron-release/0.6.0-rc.1',
    ...extra,
  };
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label}_HTTP_${response.status}: ${text.slice(0, 1000)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}_JSON_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requestJson(fetchImpl, token, url, options = {}, label = 'GITHUB_API') {
  const response = await fetchImpl(url, {
    ...options,
    headers: headers(token, options.headers ?? {}),
  });
  return readJsonResponse(response, label);
}

async function listReleases(fetchImpl, token, repository) {
  return requestJson(
    fetchImpl,
    token,
    `${API_ROOT}/repos/${repository}/releases?per_page=100`,
    {},
    'LIST_RELEASES',
  );
}

async function findRelease(fetchImpl, token, repository, tag) {
  const releases = await listReleases(fetchImpl, token, repository);
  const matches = releases.filter((release) => release?.tag_name === tag);
  assertValue(matches.length <= 1, 'DUPLICATE_RELEASE_TAG', `${tag} has ${matches.length} release records`);
  return matches[0] ?? null;
}

async function createDraftRelease(fetchImpl, token, repository, { tag, notes }) {
  return requestJson(
    fetchImpl,
    token,
    `${API_ROOT}/repos/${repository}/releases`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: RELEASE_NAME,
        body: notes,
        draft: true,
        prerelease: true,
        generate_release_notes: false,
        make_latest: 'false',
      }),
    },
    'CREATE_DRAFT_RELEASE',
  );
}

async function getRelease(fetchImpl, token, repository, releaseId) {
  return requestJson(
    fetchImpl,
    token,
    `${API_ROOT}/repos/${repository}/releases/${releaseId}`,
    {},
    'GET_RELEASE',
  );
}

async function downloadAsset(fetchImpl, token, repository, assetId) {
  const response = await fetchImpl(
    `${API_ROOT}/repos/${repository}/releases/assets/${assetId}`,
    { headers: headers(token, { accept: 'application/octet-stream' }) },
  );
  if (!response.ok) {
    throw new Error(`DOWNLOAD_ASSET_HTTP_${response.status}: ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function localAssets(directory) {
  const root = path.resolve(directory);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const assets = [];
  for (const entry of entries.filter((item) => item.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await fs.readFile(path.join(root, entry.name));
    assets.push({
      name: entry.name,
      bytes,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return assets;
}

function validateReleaseRecord(release, { tag, requireDraft = null }) {
  assertValue(release?.tag_name === tag, 'RELEASE_TAG_MISMATCH', String(release?.tag_name));
  assertValue(release?.name === RELEASE_NAME, 'RELEASE_NAME_MISMATCH', String(release?.name));
  assertValue(release?.prerelease === true, 'RELEASE_NOT_PRERELEASE', String(release?.prerelease));
  if (requireDraft !== null) {
    assertValue(release?.draft === requireDraft, 'RELEASE_DRAFT_STATE_MISMATCH', String(release?.draft));
  }
}

async function uploadMissingAssets(fetchImpl, token, release, assets) {
  const remote = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
  const expectedNames = new Set(assets.map((asset) => asset.name));
  for (const name of remote.keys()) {
    assertValue(expectedNames.has(name), 'UNEXPECTED_REMOTE_ASSET', name);
  }
  const uploadBase = String(release.upload_url ?? '').replace(/\{.*$/, '');
  assertValue(uploadBase.startsWith('https://'), 'RELEASE_UPLOAD_URL_INVALID', uploadBase);

  for (const asset of assets) {
    if (remote.has(asset.name)) continue;
    const separator = uploadBase.includes('?') ? '&' : '?';
    const uploaded = await requestJson(
      fetchImpl,
      token,
      `${uploadBase}${separator}name=${encodeURIComponent(asset.name)}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'content-type': 'application/octet-stream',
          'content-length': String(asset.size),
        },
        body: asset.bytes,
      },
      'UPLOAD_RELEASE_ASSET',
    );
    assertValue(uploaded?.name === asset.name, 'UPLOADED_ASSET_NAME_MISMATCH', String(uploaded?.name));
    assertValue(uploaded?.size === asset.size, 'UPLOADED_ASSET_SIZE_MISMATCH', `${uploaded?.size} vs ${asset.size}`);
  }
}

async function verifyRemoteAssets(fetchImpl, token, repository, release, assets) {
  const expected = new Map(assets.map((asset) => [asset.name, asset]));
  const actual = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
  assertValue(actual.size === expected.size, 'REMOTE_ASSET_INVENTORY_MISMATCH', `${actual.size} vs ${expected.size}`);
  for (const [name, local] of expected) {
    const remote = actual.get(name);
    assertValue(remote, 'REMOTE_ASSET_MISSING', name);
    assertValue(remote.size === local.size, 'REMOTE_ASSET_SIZE_MISMATCH', `${name}: ${remote.size} vs ${local.size}`);
    const bytes = await downloadAsset(fetchImpl, token, repository, remote.id);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    assertValue(bytes.length === local.size, 'REMOTE_ASSET_READBACK_SIZE_MISMATCH', name);
    assertValue(digest === local.sha256, 'REMOTE_ASSET_READBACK_HASH_MISMATCH', name);
  }
}

async function readTagRef(fetchImpl, token, repository, tag) {
  const response = await fetchImpl(
    `${API_ROOT}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    { headers: headers(token) },
  );
  if (response.status === 404) return null;
  return readJsonResponse(response, 'GET_TAG_REF');
}

async function ensureTag(fetchImpl, token, repository, tag, sourceSha) {
  const existing = await readTagRef(fetchImpl, token, repository, tag);
  if (existing) {
    assertValue(
      String(existing.object?.sha ?? '').toLowerCase() === sourceSha.toLowerCase(),
      'EXISTING_TAG_SHA_MISMATCH',
      String(existing.object?.sha),
    );
    return { created: false, sha: existing.object.sha };
  }
  const created = await requestJson(
    fetchImpl,
    token,
    `${API_ROOT}/repos/${repository}/git/refs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: sourceSha }),
    },
    'CREATE_TAG_REF',
  );
  assertValue(created?.ref === `refs/tags/${tag}`, 'CREATED_TAG_REF_MISMATCH', String(created?.ref));
  assertValue(String(created?.object?.sha ?? '').toLowerCase() === sourceSha.toLowerCase(), 'CREATED_TAG_SHA_MISMATCH', String(created?.object?.sha));
  return { created: true, sha: created.object.sha };
}

async function publishDraft(fetchImpl, token, repository, release, notes) {
  return requestJson(
    fetchImpl,
    token,
    `${API_ROOT}/repos/${repository}/releases/${release.id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: RELEASE_NAME,
        body: notes,
        draft: false,
        prerelease: true,
        make_latest: 'false',
      }),
    },
    'PUBLISH_PRERELEASE',
  );
}

export async function publishVerifiedPrerelease({
  fetchImpl = globalThis.fetch,
  token,
  repository,
  tag = RELEASE_TAG,
  sourceSha,
  assetDirectory,
  notes,
  minInstallerBytes = 100_000,
}) {
  assertValue(typeof fetchImpl === 'function', 'FETCH_UNAVAILABLE', 'fetch implementation is required');
  assertValue(typeof token === 'string' && token.length > 0, 'GITHUB_TOKEN_MISSING', 'token is required');
  assertValue(/^[^/]+\/[^/]+$/.test(repository ?? ''), 'REPOSITORY_INVALID', String(repository));
  assertValue(tag === RELEASE_TAG, 'RELEASE_TAG_UNEXPECTED', String(tag));
  assertValue(/^[0-9a-f]{40}$/i.test(sourceSha ?? ''), 'SOURCE_SHA_INVALID', String(sourceSha));
  assertValue(typeof notes === 'string' && notes.trim().length > 0, 'RELEASE_NOTES_EMPTY', 'release notes are required');

  await verifyReleaseAssets({
    directory: assetDirectory,
    tag,
    version: RELEASE_VERSION,
    sourceSha,
    minInstallerBytes,
  });
  const assets = await localAssets(assetDirectory);

  let release = await findRelease(fetchImpl, token, repository, tag);
  const reused = Boolean(release);
  const initialTagState = await ensureTag(fetchImpl, token, repository, tag, sourceSha);
  if (!release) {
    release = await createDraftRelease(fetchImpl, token, repository, { tag, notes });
  }
  validateReleaseRecord(release, { tag });

  if (release.draft === false) {
    await verifyRemoteAssets(fetchImpl, token, repository, release, assets);
    await ensureTag(fetchImpl, token, repository, tag, sourceSha);
    assertValue(Boolean(release.published_at), 'PUBLISHED_AT_MISSING', tag);
    return {
      published: true,
      reused: true,
      releaseId: release.id,
      tagCreated: initialTagState.created,
    };
  }

  await uploadMissingAssets(fetchImpl, token, release, assets);
  release = await getRelease(fetchImpl, token, repository, release.id);
  validateReleaseRecord(release, { tag, requireDraft: true });
  await verifyRemoteAssets(fetchImpl, token, repository, release, assets);

  await ensureTag(fetchImpl, token, repository, tag, sourceSha);
  const published = await publishDraft(fetchImpl, token, repository, release, notes);
  validateReleaseRecord(published, { tag, requireDraft: false });
  assertValue(Boolean(published.published_at), 'PUBLISHED_AT_MISSING', tag);

  const byTag = await requestJson(
    fetchImpl,
    token,
    `${API_ROOT}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {},
    'READBACK_RELEASE_BY_TAG',
  );
  validateReleaseRecord(byTag, { tag, requireDraft: false });
  await verifyRemoteAssets(fetchImpl, token, repository, byTag, assets);
  await ensureTag(fetchImpl, token, repository, tag, sourceSha);

  return {
    published: true,
    reused,
    releaseId: byTag.id,
    tagCreated: initialTagState.created,
    assetNames: assets.map((asset) => asset.name),
  };
}

function parseArguments(argv) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    token: process.env.GITHUB_TOKEN ?? '',
    tag: process.env.RELEASE_TAG ?? RELEASE_TAG,
    sourceSha: process.env.SOURCE_SHA ?? process.env.GITHUB_SHA ?? '',
    assetDirectory: '',
    notesFile: '',
    jsonOut: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--repository', '--tag', '--source', '--assets', '--notes', '--json-out'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === '--repository') options.repository = value;
    if (argument === '--tag') options.tag = value;
    if (argument === '--source') options.sourceSha = value;
    if (argument === '--assets') options.assetDirectory = value;
    if (argument === '--notes') options.notesFile = value;
    if (argument === '--json-out') options.jsonOut = value;
  }
  if (!options.assetDirectory) throw new Error('--assets is required');
  if (!options.notesFile) throw new Error('--notes is required');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const notes = await fs.readFile(path.resolve(options.notesFile), 'utf8');
  const result = await publishVerifiedPrerelease({ ...options, notes });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.jsonOut) {
    const output = path.resolve(options.jsonOut);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, serialized, 'utf8');
  }
  process.stdout.write(serialized);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
