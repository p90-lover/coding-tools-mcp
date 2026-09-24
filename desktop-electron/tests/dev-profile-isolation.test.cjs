const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  resolveLauncherProfile,
  PRODUCTION_PROFILE,
  DEVELOPMENT_PROFILE,
} = require('../electron/profile.cjs');
const {
  CURRENT_CONNECTOR_NAME,
  DEV_CONNECTOR_NAME,
  LEGACY_CONNECTOR_NAMES,
  requireCurrentRuntimeConnectorName,
} = require('../electron/connector-identity.cjs');

const HOME = path.resolve('/fixture/home');
const APP_DATA = path.resolve('/fixture/app-data');

test('production profile uses the Coding Tools application home and browser partition', () => {
  const profile = resolveLauncherProfile({ argv: ['electron'], env: {}, homeDir: HOME, appData: APP_DATA });
  assert.equal(profile.kind, PRODUCTION_PROFILE);
  assert.equal(profile.displayName, 'Coding Tools');
  assert.equal(profile.coreHome, path.join(HOME, '.coding-tools'));
  assert.equal(profile.userData, path.join(APP_DATA, 'Coding Tools'));
  assert.equal(profile.browserPartition, 'persist:coding-tools-chatgpt');
});

test('DEV profile is fully disjoint and uses its own connector identity', () => {
  const production = resolveLauncherProfile({ argv: ['electron'], env: {}, homeDir: HOME, appData: APP_DATA });
  const development = resolveLauncherProfile({ argv: ['electron', '--dev-profile'], env: {}, homeDir: HOME, appData: APP_DATA });
  assert.equal(development.kind, DEVELOPMENT_PROFILE);
  assert.equal(development.displayName, 'Coding Tools DEV');
  assert.equal(development.coreHome, path.join(HOME, '.coding-tools-dev'));
  assert.equal(development.codexHome, path.join(HOME, '.coding-tools-dev', 'codex-home'));
  assert.equal(development.userData, path.join(HOME, '.coding-tools-dev', 'launcher'));
  assert.equal(development.browserPartition, 'persist:coding-tools-dev-chatgpt');
  for (const key of ['coreHome', 'codexHome', 'userData', 'browserPartition']) {
    assert.notEqual(development[key], production[key], key);
  }
  assert.equal(CURRENT_CONNECTOR_NAME, 'Coding Tools Native2');
  assert.equal(DEV_CONNECTOR_NAME, 'Coding Tools Native2 DEV');
});

test('legacy upstream environment and connector names cannot collapse the new profiles', () => {
  const development = resolveLauncherProfile({
    argv: ['electron', '--dev-profile'],
    env: {
      CODEX_CHATGPT_WEB_HOME: path.join(HOME, 'legacy-shared'),
      CODEX_WEB_GPT_DEV_HOME: path.join(HOME, 'legacy-shared'),
      CODING_TOOLS_HOME: path.join(HOME, 'coding-tools-production'),
      CODING_TOOLS_DEV_HOME: path.join(HOME, 'coding-tools-development'),
    },
    homeDir: HOME,
    appData: APP_DATA,
  });
  assert.equal(development.coreHome, path.join(HOME, 'coding-tools-development'));
  assert.ok(LEGACY_CONNECTOR_NAMES.includes('Codex Native'));
  assert.ok(LEGACY_CONNECTOR_NAMES.includes('Codex Native2'));
  assert.equal(LEGACY_CONNECTOR_NAMES.includes('Coding Tools Native2'), false);
  assert.equal(requireCurrentRuntimeConnectorName('Coding Tools Native2'), 'Coding Tools Native2');
  assert.throws(() => requireCurrentRuntimeConnectorName('Codex Native2'), /Coding Tools Native2/);
});
