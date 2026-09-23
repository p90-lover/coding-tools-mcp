const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RuntimeHost } = require('../electron/runtime.cjs');
const { RuntimeSupervisor } = require('../electron/runtime-supervisor.cjs');
const logger = { info() {}, warn() {}, error() {} };
const coreHome = path.resolve(__dirname, '../../aiTemp/mcp-handoff-test');
const config = { mode: 'browser-only', browserHost: 'launcher', releaseVersion: '5.0.6' };

test('MCP handoff waits for native requests without draining or cancelling them', async () => {
  const messages = [];
  const supervisor = new RuntimeSupervisor({
    app: {}, logger, coreHome, publishOperation: value => messages.push(value.message),
  });
  supervisor.daemon = { pid: 42 };
  supervisor.readConfig = () => config;
  const counts = [2, 1, 0];
  supervisor.proxyHealthPayload = async () => ({
    service: 'codex-chatgpt-web', status: 'ok', mode: 'browser-only', version: '5.0.6',
    pid: 42, accepting_turns: true, active_http_turns: counts.shift(), active_browser_turns: 0,
  });
  supervisor.control = async () => { throw new Error('Waiting must not drain/cancel active requests'); };
  await supervisor.waitForIdleForSetup('mcp-setup', 1000, 1);
  assert.equal(counts.length, 0);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /2 active HTTP/);
});

test('MCP handoff timeout leaves the running bridge untouched', async () => {
  const supervisor = new RuntimeSupervisor({ app: {}, logger, coreHome });
  supervisor.daemon = { pid: 42 };
  supervisor.readConfig = () => config;
  supervisor.proxyHealthPayload = async () => ({
    service: 'codex-chatgpt-web', status: 'ok', mode: 'browser-only', version: '5.0.6',
    pid: 42, accepting_turns: true, active_http_turns: 2, active_browser_turns: 0,
  });
  supervisor.control = async () => { throw new Error('Bridge must remain accepting'); };
  await assert.rejects(supervisor.waitForIdleForSetup('mcp-setup', 0, 1), /Still waiting for 2 active HTTP/);
});

test('setup does not stop the bridge or write configuration before its idle wait completes', async () => {
  const calls = [];
  let release;
  const idle = new Promise(resolve => { release = resolve; });
  const host = new RuntimeHost({
    app: { getPath: () => coreHome }, logger,
    supervisor: {
      readConfig: () => config, readSetupConfig: () => config,
      waitForIdleForSetup: async () => { calls.push('wait'); await idle; },
      stopForSetup: async () => { calls.push('stop'); },
      startIfConfigured: async () => { calls.push('start'); return { status: 'ready' }; },
    },
  });
  host.captureSetupCheckpoint = () => null;
  host.run = async (_name, args) => { calls.push(args.includes('--preflight-only') ? 'preflight' : 'setup'); return { code: 0 }; };
  const work = host.runSetup('mcp-setup', ['setup', '--full'], { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['preflight', 'wait']);
  release();
  await work;
  assert.deepEqual(calls, ['preflight', 'wait', 'stop', 'setup', 'start']);
});
