import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  APP_ID,
  PRODUCT_NAME,
  RELEASE_TAG,
  RELEASE_VERSION,
  UPSTREAM,
} from './verify-source-scope-v0.6.0.mjs';

export const WINDOWS_INSTALLER = `Coding.Tools_${RELEASE_VERSION}_windows_x64_setup.exe`;

const SECRET_PATTERNS = Object.freeze([
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{70,255}\b/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,255}\b/g],
  ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/g],
  ['private-key-material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
]);

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

async function hashAndScan(filePath) {
  const hash = crypto.createHash('sha256');
  const findings = [];
  let size = 0;
  let carry = '';
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
    const sample = carry + chunk.toString('latin1');
    for (const [kind, pattern] of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(sample)) findings.push(kind);
    }
    carry = sample.slice(-512);
  }
  return { sha256: hash.digest('hex'), size, findings: [...new Set(findings)] };
}

function parseChecksums(source) {
  const entries = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) fail('SHA256SUMS_FORMAT_INVALID', line);
    if (entries.has(match[2])) fail('SHA256SUMS_DUPLICATE', match[2]);
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`${label}_INVALID`, error instanceof Error ? error.message : String(error));
  }
}

export async function verifyReleaseAssets({
  directory,
  tag = RELEASE_TAG,
  version = RELEASE_VERSION,
  sourceSha,
  minInstallerBytes = 100_000,
}) {
  const root = path.resolve(directory);
  const directoryEntries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of directoryEntries) {
    const entryPath = path.join(root, entry.name);
    const metadata = await fs.lstat(entryPath);
    if (metadata.isSymbolicLink()) fail('ASSET_SYMLINK_FORBIDDEN', entry.name);
    if (!metadata.isFile()) fail('ASSET_ENTRY_UNSUPPORTED', entry.name);
  }
  const names = directoryEntries.map((entry) => entry.name).sort();
  const required = [WINDOWS_INSTALLER, 'SHA256SUMS.txt', 'provenance.json', 'validation-evidence.json'];
  for (const name of required) {
    if (!names.includes(name)) fail('REQUIRED_ASSET_MISSING', name);
  }
  if (names.length !== required.length || names.some((name) => !required.includes(name))) {
    fail('ASSET_INVENTORY_MISMATCH', JSON.stringify({ expected: [...required].sort(), actual: names }));
  }
  if (names.some((name) => name.includes('/') || name.includes('\\'))) {
    fail('ASSET_NAME_INVALID', 'asset names must be flat');
  }

  const provenance = await readJson(path.join(root, 'provenance.json'), 'PROVENANCE');
  const validation = await readJson(path.join(root, 'validation-evidence.json'), 'VALIDATION_EVIDENCE');

  if (provenance.schema !== 1) fail('PROVENANCE_SCHEMA_MISMATCH', String(provenance.schema));
  if (provenance.release_tag !== tag) fail('PROVENANCE_TAG_MISMATCH', String(provenance.release_tag));
  if (provenance.version !== version) fail('PROVENANCE_VERSION_MISMATCH', String(provenance.version));
  if (provenance.source_sha !== sourceSha) fail('PROVENANCE_SOURCE_MISMATCH', String(provenance.source_sha));
  if (provenance.product?.name !== PRODUCT_NAME) fail('PROVENANCE_PRODUCT_MISMATCH', String(provenance.product?.name));
  if (provenance.product?.app_id !== APP_ID) fail('PROVENANCE_APP_ID_MISMATCH', String(provenance.product?.app_id));
  if (provenance.upstream?.repository !== UPSTREAM.repository
      || provenance.upstream?.version !== UPSTREAM.tag
      || provenance.upstream?.commit !== UPSTREAM.commit) {
    fail('PROVENANCE_UPSTREAM_MISMATCH', JSON.stringify(provenance.upstream ?? null));
  }
  if (validation.automated_gates !== 'passed') {
    fail('AUTOMATED_GATES_NOT_PASSED', String(validation.automated_gates));
  }
  if (validation.live_account_acceptance !== 'pending_manual') {
    fail('LIVE_ACCOUNT_GATE_DISCLOSURE_MISMATCH', String(validation.live_account_acceptance));
  }
  if (validation.source_sha !== sourceSha) {
    fail('VALIDATION_SOURCE_MISMATCH', String(validation.source_sha));
  }
  if (!Number.isSafeInteger(validation.validation_run_id) || validation.validation_run_id < 1) {
    fail('VALIDATION_RUN_ID_INVALID', String(validation.validation_run_id));
  }
  if (validation.validation_workflow !== '.github/workflows/electron-full-harness-ci.yml') {
    fail('VALIDATION_WORKFLOW_MISMATCH', String(validation.validation_workflow));
  }
  if (validation.validation_conclusion !== 'success') {
    fail('VALIDATION_CONCLUSION_MISMATCH', String(validation.validation_conclusion));
  }
  if (provenance.validation_run?.id !== validation.validation_run_id
      || provenance.validation_run?.workflow !== validation.validation_workflow) {
    fail('PROVENANCE_VALIDATION_RUN_MISMATCH', JSON.stringify(provenance.validation_run ?? null));
  }

  const expectedChecksums = parseChecksums(await fs.readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8'));
  const hashTargets = names.filter((name) => name !== 'SHA256SUMS.txt');
  if (expectedChecksums.size !== hashTargets.length
      || hashTargets.some((name) => !expectedChecksums.has(name))) {
    fail('SHA256SUMS_INVENTORY_MISMATCH', JSON.stringify({ listed: [...expectedChecksums.keys()], actual: hashTargets }));
  }

  const inspected = {};
  for (const name of hashTargets) {
    const details = await hashAndScan(path.join(root, name));
    inspected[name] = details;
    if (details.sha256 !== expectedChecksums.get(name)) {
      fail('ASSET_CHECKSUM_MISMATCH', `${name}: expected ${expectedChecksums.get(name)}, got ${details.sha256}`);
    }
    if (details.findings.length > 0) {
      fail('ASSET_SECRET_PATTERN_FOUND', `${name}: ${details.findings.join(', ')}`);
    }
  }

  if (inspected[WINDOWS_INSTALLER].size < minInstallerBytes) {
    fail('INSTALLER_TOO_SMALL', `${inspected[WINDOWS_INSTALLER].size} bytes`);
  }
  const assetRecord = Array.isArray(provenance.assets)
    ? provenance.assets.find((entry) => entry?.name === WINDOWS_INSTALLER)
    : null;
  if (!assetRecord) fail('PROVENANCE_INSTALLER_MISSING', WINDOWS_INSTALLER);
  if (assetRecord.sha256 !== inspected[WINDOWS_INSTALLER].sha256
      || assetRecord.size !== inspected[WINDOWS_INSTALLER].size) {
    fail('PROVENANCE_INSTALLER_MISMATCH', JSON.stringify(assetRecord));
  }

  return {
    ok: true,
    directory: root,
    tag,
    version,
    sourceSha,
    installer: {
      name: WINDOWS_INSTALLER,
      ...inspected[WINDOWS_INSTALLER],
    },
    assets: names.map((name) => ({ name, ...(inspected[name] ?? {}) })),
    validation,
  };
}

function parseArguments(argv) {
  const options = {
    directory: '',
    tag: process.env.RELEASE_TAG ?? RELEASE_TAG,
    version: process.env.RELEASE_VERSION ?? RELEASE_VERSION,
    sourceSha: process.env.SOURCE_SHA ?? process.env.GITHUB_SHA ?? '',
    jsonOut: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--directory', '--tag', '--version', '--source', '--json-out'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === '--directory') options.directory = value;
    if (argument === '--tag') options.tag = value;
    if (argument === '--version') options.version = value;
    if (argument === '--source') options.sourceSha = value;
    if (argument === '--json-out') options.jsonOut = value;
  }
  if (!options.directory) throw new Error('--directory is required');
  if (!/^[0-9a-f]{40}$/i.test(options.sourceSha)) throw new Error('--source must be a full commit SHA');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await verifyReleaseAssets(options);
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
