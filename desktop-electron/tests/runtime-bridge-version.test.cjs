const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RuntimeHost } = require('../electron/runtime.cjs');
const { RuntimeSupervisor } = require('../electron/runtime-supervisor.cjs');

function fixture() {
  const scratch = path.resolve(__dirname, '../../aiTemp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'bridge-version-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({
    name: 'codex-chatgpt-web', version: '5.0.6',
  }));
  return {
    root,
    app: { isPackaged: true, getVersion: () => '0.7.0-rc.12', getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    config: { mode: 'browser-only', browserHost: 'launcher', releaseVersion: '5.0.6' },
  };
}

test('a current bridge is not reinstalled because the desktop version differs', async () => {
  const f = fixture();
  const host = new RuntimeHost({
    app: f.app, logger: f.logger, installedRuntimeRoot: f.root,
    supervisor: { readConfig: () => f.config, readSetupConfig: () => f.config },
  });
  host.runSetup = async () => { throw new Error('Unexpected runtime reinstall'); };
  assert.deepEqual(await host.upgradeManagedRuntime(), { updated: false });
});

test('startup validates the bridge version instead of the desktop version', async () => {
  const f = fixture();
  const supervisor = new RuntimeSupervisor({
    app: f.app, logger: f.logger, coreHome: f.root, installedRuntimeRoot: f.root,
  });
  supervisor.readConfig = () => f.config;
  supervisor.readState = () => null;
  supervisor.proxyHealth = async () => false;
  supervisor.writeState = () => {};
  let started = false;
  supervisor.startDaemon = async () => { started = true; };
  const result = await supervisor.startConfigured();
  assert.equal(result.status, 'ready');
  assert.equal(started, true);
});
