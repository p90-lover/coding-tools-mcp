import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/, '');
}

function releaseTarget({ buildsElectron, buildsTauri }) {
  if (buildsElectron && buildsTauri) return 'mixed';
  if (buildsElectron) return 'electron';
  if (buildsTauri) return 'tauri';
  return 'unknown';
}

export function auditOAuthReleaseContract({
  expectedVersion,
  expectedAppId,
  rootPackage,
  electronPackage,
  tauriConfig,
  releaseWorkflow,
}) {
  const workflow = String(releaseWorkflow ?? '');
  const electronVersion = normalizeVersion(electronPackage?.version);
  const rootVersion = normalizeVersion(rootPackage?.version);
  const tauriVersion = normalizeVersion(tauriConfig?.version);
  const electronAppId = String(electronPackage?.build?.appId ?? '').trim();
  const tauriAppId = String(tauriConfig?.identifier ?? '').trim();
  const expected = normalizeVersion(expectedVersion);
  const expectedId = String(expectedAppId ?? '').trim();

  const buildsElectron =
    /\belectron-builder\b/i.test(workflow)
    || /working-directory:\s*desktop-electron[\s\S]*?\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?package(?::(?:win|mac|linux))?\b/i.test(workflow)
    || /\b(?:bun|npm|pnpm|yarn)\b[^\n]*\bdesktop-electron\b[^\n]*\bpackage(?::(?:win|mac|linux))?\b/i.test(workflow);
  const buildsTauri = /\btauri\b[^\n]*\bbuild\b/i.test(workflow);
  const publishesElectron =
    /desktop-electron[\\/]+release/i.test(workflow)
    || /\bCoding\.Tools_\$\{?version\}?/i.test(workflow);
  const publishesTauri =
    /src-tauri[\\/]+target[\\/]+release[\\/]+bundle/i.test(workflow)
    || /cargo-target[\\/]+(?:[^/\s]+[\\/]+)?release[\\/]+bundle/i.test(workflow);
  const gatesElectronVersion = /desktop-electron[\\/]+package\.json/i.test(workflow);
  const gatesTauriVersion =
    /src-tauri[\\/]+tauri\.conf\.json/i.test(workflow)
    || /src-tauri[\\/]+Cargo\.toml/i.test(workflow);

  const target = releaseTarget({ buildsElectron, buildsTauri });
  const errors = [];

  if (electronVersion !== expected) {
    errors.push({
      code: 'ELECTRON_VERSION_MISMATCH',
      message: `Electron package version ${electronVersion || '<missing>'} does not match ${expected || '<missing>'}.`,
    });
  }

  if (expectedId && electronAppId !== expectedId) {
    errors.push({
      code: 'ELECTRON_APP_ID_MISMATCH',
      message: `Electron app id ${electronAppId || '<missing>'} does not match ${expectedId}.`,
    });
  }

  if (!gatesElectronVersion && gatesTauriVersion) {
    errors.push({
      code: 'RELEASE_VERSION_SOURCE_WRONG_PRODUCT',
      message: 'Release version validation is anchored to Tauri manifests instead of desktop-electron/package.json.',
    });
  }

  if (!buildsElectron && buildsTauri) {
    errors.push({
      code: 'RELEASE_BUILD_WRONG_PRODUCT',
      message: 'Release workflow builds Tauri but does not build the Electron OAuth product.',
    });
  }

  if (!publishesElectron && publishesTauri) {
    errors.push({
      code: 'RELEASE_ARTIFACT_WRONG_PRODUCT',
      message: 'Release workflow publishes Tauri bundle artifacts instead of desktop-electron/release artifacts.',
    });
  }

  const shippedAppId = target === 'tauri'
    ? tauriAppId
    : target === 'electron'
      ? electronAppId
      : '';

  if (target === 'tauri' && expectedId && shippedAppId !== expectedId) {
    errors.push({
      code: 'RELEASE_APP_ID_WRONG_PRODUCT',
      message: `Release ships app id ${shippedAppId || '<missing>'}, not ${expectedId}.`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    facts: {
      expectedVersion: expected,
      rootVersion,
      electronVersion,
      tauriVersion,
      expectedAppId: expectedId,
      electronAppId,
      tauriAppId,
      releaseTarget: target,
      shippedAppId,
      buildsElectron,
      buildsTauri,
      publishesElectron,
      publishesTauri,
      gatesElectronVersion,
      gatesTauriVersion,
    },
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function auditOAuthReleaseRepo({
  root,
  expectedVersion,
  expectedAppId,
}) {
  const repoRoot = path.resolve(root);
  const [
    rootPackage,
    electronPackage,
    tauriConfig,
    releaseWorkflow,
  ] = await Promise.all([
    readJson(path.join(repoRoot, 'package.json')),
    readJson(path.join(repoRoot, 'desktop-electron', 'package.json')),
    readJson(path.join(repoRoot, 'src-tauri', 'tauri.conf.json')),
    fs.readFile(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'),
  ]);

  return auditOAuthReleaseContract({
    expectedVersion,
    expectedAppId,
    rootPackage,
    electronPackage,
    tauriConfig,
    releaseWorkflow,
  });
}

function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    expectedVersion: process.env.RELEASE_VERSION ?? '',
    expectedAppId: 'dev.codingtools.fullharness',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--root' || argument === '--expected-version' || argument === '--expected-app-id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === '--root') options.root = value;
      if (argument === '--expected-version') options.expectedVersion = value;
      if (argument === '--expected-app-id') options.expectedAppId = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!normalizeVersion(options.expectedVersion)) {
    throw new Error('--expected-version or RELEASE_VERSION is required');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await auditOAuthReleaseRepo(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const error of result.errors) {
      process.stderr.write(`[${error.code}] ${error.message}\n`);
    }
    process.stdout.write(
      result.ok
        ? 'OAuth release contract verified.\n'
        : `OAuth release contract failed with ${result.errors.length} error(s).\n`,
    );
  }
  process.exitCode = result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
