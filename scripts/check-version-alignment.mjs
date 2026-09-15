import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

function requiredMatch(value, expression, label) {
  const match = value.match(expression);
  if (!match) {
    throw new Error(`Unable to read ${label}`);
  }
  return match[1];
}

export function compareStableVersions(left, right) {
  for (const [label, value] of [
    ['requested version', left],
    ['current version', right],
  ]) {
    if (!STABLE_VERSION.test(value)) {
      throw new Error(`${label} must be stable X.Y.Z; received ${JSON.stringify(value)}`);
    }
  }

  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function validateBilingualReleaseNotes(text, tag) {
  if (typeof text !== 'string') {
    throw new Error(`Release notes for ${tag} must be UTF-8 text`);
  }

  const section = (heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...text.matchAll(new RegExp(`^## ${escaped}\\s*$`, 'gm'))];
    if (matches.length !== 1) {
      throw new Error(
        `Release notes for ${tag} must contain exactly one "## ${heading}" section`,
      );
    }
    const start = matches[0].index + matches[0][0].length;
    const remainder = text.slice(start);
    const nextHeading = /^##\s+/m.exec(remainder);
    const end = nextHeading ? start + nextHeading.index : text.length;
    const body = text.slice(start, end).trim();
    if (!body) {
      throw new Error(`Release notes for ${tag} have an empty "## ${heading}" section`);
    }
    return { index: matches[0].index, body };
  };

  const english = section('English');
  const traditionalChinese = section('繁體中文');
  if (english.index > traditionalChinese.index) {
    throw new Error(`Release notes for ${tag} must list English before 繁體中文`);
  }
  return { english: english.body, traditionalChinese: traditionalChinese.body };
}

export function parseCargoTomlPackage(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '[package]');
  if (start < 0) {
    throw new Error('Unable to read the [package] section from src-tauri/Cargo.toml');
  }
  const endOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const packageSection = lines.slice(start + 1, end).join('\n');
  return {
    name: requiredMatch(packageSection, /^name\s*=\s*"([^"]+)"\s*$/m, 'the Cargo package name'),
    version: requiredMatch(
      packageSection,
      /^version\s*=\s*"([^"]+)"\s*$/m,
      'the Cargo package version',
    ),
  };
}

export function parseCargoLockVersion(text, packageName) {
  const blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const name = block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (name === packageName) {
      return requiredMatch(
        block,
        /^version\s*=\s*"([^"]+)"\s*$/m,
        `the ${packageName} version from src-tauri/Cargo.lock`,
      );
    }
  }
  throw new Error(`Unable to find ${packageName} in src-tauri/Cargo.lock`);
}

export function validateVersionAlignment({
  versions,
  expectedTag,
  releaseNotesExists,
  releaseNotesContent,
}) {
  const entries = Object.entries(versions);
  if (entries.length === 0) {
    throw new Error('No version observations were supplied');
  }

  const canonical = versions['package.json'];
  if (!canonical || !STABLE_VERSION.test(canonical)) {
    throw new Error(
      `package.json version must be a stable X.Y.Z release version; received ${JSON.stringify(canonical)}`,
    );
  }

  const mismatches = entries.filter(([, version]) => version !== canonical);
  if (mismatches.length > 0) {
    const details = mismatches.map(([source, version]) => `${source}=${version}`).join(', ');
    throw new Error(`Version mismatch: package.json=${canonical}; ${details}`);
  }

  const canonicalTag = `v${canonical}`;
  if (expectedTag && expectedTag !== canonicalTag) {
    throw new Error(`Tag mismatch: expected ${canonicalTag}, received ${expectedTag}`);
  }
  if (expectedTag && !/^v\d+\.\d+\.\d+$/.test(expectedTag)) {
    throw new Error(`Release tag must be stable vX.Y.Z; received ${expectedTag}`);
  }
  if (!releaseNotesExists) {
    throw new Error(`Missing release notes: docs/releases/${canonicalTag}.md`);
  }
  validateBilingualReleaseNotes(releaseNotesContent, canonicalTag);

  return { version: canonical, tag: canonicalTag };
}

export function collectVersionObservations(root = process.cwd()) {
  const readText = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
  const packageJson = JSON.parse(readText('package.json'));
  const packageLock = JSON.parse(readText('package-lock.json'));
  const tauriConfig = JSON.parse(readText('src-tauri/tauri.conf.json'));
  const cargoPackage = parseCargoTomlPackage(readText('src-tauri/Cargo.toml'));
  const cargoLockVersion = parseCargoLockVersion(
    readText('src-tauri/Cargo.lock'),
    cargoPackage.name,
  );
  const releaseNotesPath = path.join(
    root,
    'docs',
    'releases',
    `v${packageJson.version}.md`,
  );
  const releaseNotesExists = fs.existsSync(releaseNotesPath);

  return {
    versions: {
      'package.json': packageJson.version,
      'package-lock.json': packageLock.version,
      'package-lock.json packages[""]': packageLock.packages?.['']?.version,
      'src-tauri/tauri.conf.json': tauriConfig.version,
      'src-tauri/Cargo.toml': cargoPackage.version,
      'src-tauri/Cargo.lock': cargoLockVersion,
    },
    releaseNotesExists,
    releaseNotesContent: releaseNotesExists ? fs.readFileSync(releaseNotesPath, 'utf8') : '',
  };
}

export function parseExpectedTag(argv = process.argv.slice(2), env = process.env) {
  let expectedTag = env.RELEASE_TAG || env.TAG || '';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--tag') {
      if (!argv[index + 1]) {
        throw new Error('--tag requires a value');
      }
      expectedTag = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return expectedTag;
}

export function runVersionAlignmentCheck({ root = process.cwd(), expectedTag = '' } = {}) {
  const observations = collectVersionObservations(root);
  return validateVersionAlignment({ ...observations, expectedTag });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    const expectedTag = parseExpectedTag();
    const result = runVersionAlignmentCheck({ expectedTag });
    console.log(
      `Version alignment OK: ${result.version}${expectedTag ? ` (${result.tag})` : ''}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
