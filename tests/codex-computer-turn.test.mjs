import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEngine, failureReply, METHODS } from '../src-tauri/src/tools/computer/codex-bridge.mjs';

const executable = 'G:\\Apps\\Fixture\\fixture.exe';
const window = { id: 17, app: 'process:' + executable, title: 'Turn fixture' };

async function runtime(t) {
  const scratch = process.env.CODEX_COMPUTER_TEST_SCRATCH || fileURLToPath(new URL('../aiTemp/codex-computer-bridge-tests/', import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'turn-'));
  const base = path.join(root, 'dist/project/cua/sky_js/src/targets/windows/internal');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@oai/sky', version: 'fixture', type: 'module' }));
  const helper = path.join(root, 'fixture.exe');
  fs.writeFileSync(helper, 'not executed');
  fs.writeFileSync(path.join(base, 'helper_transport.js'), `
    export let current;
    export class WindowsHelperTransport {
      constructor() { current = this; this.calls = []; this.held = false; }
      onExit(fn) { this.exit = fn; }
      async close() { this.closed = true; this.held = false; }
      async request(method, params, options) {
        this.calls.push({ method, params, options });
        if (method === 'end_turn') {
          if (this.cleanupError) throw this.cleanupError;
          this.held = false;
          return null;
        }
        this.held = true;
        if (this.defer) await this.defer;
        if (this.error) throw this.error;
        if (method === 'get_window') return ${JSON.stringify(window)};
        if (method === 'get_window_state') return { window: ${JSON.stringify(window)}, screenshots: [] };
        return null;
      }
    }
  `);
  fs.writeFileSync(path.join(base, 'computer_use_client.js'), `
    export class WindowsComputerUseClient {
      constructor({ transport }) {
        this.target = 'windows'; this.transport = transport;
        for (const method of ${JSON.stringify(METHODS)}) {
          this[method] = params => transport.request(method === 'click' ? 'click_element' : method, params, { codexTurnMetadata: { session_id: 'fixture-session', turn_id: 'fixture-turn' } });
        }
      }
      close() { return this.transport.close(); }
    }
  `);
  const { bridge } = await loadEngine({ sky_root: root, helper, window_id: 17, executable });
  const { current } = await import(pathToFileURL(path.join(base, 'helper_transport.js')));
  t.after(async () => {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { bridge, transport: current };
}

const calls = {
  get_window: { id: 17 },
  get_window_state: { include_text: true, include_screenshot: false },
  click: { element_index: 3 },
  press_key: { key: 'Tab' },
  type_text: { text: 'fixture' },
  scroll: { x: 1, y: 2, scrollX: 0, scrollY: 120 },
  set_value: { element_index: 2, value: 'fixture' },
  drag: { from_x: 1, from_y: 2, to_x: 3, to_y: 4 },
  perform_secondary_action: { element_index: 4, action: 'Expand' },
  activate_window: {},
};

test('each completed native operation releases its turn before returning without dropping the window cache', async t => {
  const { bridge, transport } = await runtime(t);
  for (const [method, params] of Object.entries(calls)) {
    await bridge.call(method, params);
    assert.equal(transport.held, false, method + ' must release interaction state');
    const release = transport.calls.at(-1);
    assert.equal(release.method, 'end_turn');
    assert.deepEqual(release.params, {});
    assert.deepEqual(release.options.codexTurnMetadata, { session_id: 'fixture-session', turn_id: 'fixture-turn' });
    assert.equal(release.options.skipTurnTransition, true);
    assert.equal(release.options.timeoutMs, 1000);
    assert.equal(release.options.createElicitation, undefined, 'cleanup never grants new authority');
  }
  assert.equal(transport.calls.filter(c => c.method === 'get_window').length, 1);
  assert.equal(transport.closed, undefined, 'the approved client stays reusable');
});

test('a recoverable native failure also releases interaction state and preserves the original failure', async t => {
  const { bridge, transport } = await runtime(t);
  await bridge.call('get_window', { id: 17 });
  const original = new Error('timeout');
  transport.error = original;
  await assert.rejects(bridge.call('get_window_state', { include_text: true }), error => error === original);
  assert.equal(transport.calls.at(-1).method, 'end_turn');
  assert.equal(transport.held, false);
  assert.equal(bridge.closed, false);
  transport.error = null;
  await bridge.call('get_window_state', { include_text: true });
});

test('a policy stop, physical Escape or dead helper never triggers another native request', async t => {
  for (const message of [
    'Computer Use has been stopped for this turn because the URL cannot be verified',
    'Computer Use was stopped by the user with the physical Escape key',
    'computer-use request timed out: click_element',
    'computer-use helper exited with exit code 1',
  ]) {
    const { bridge, transport } = await runtime(t);
    await bridge.call('get_window', { id: 17 });
    transport.calls.length = 0;
    transport.error = new Error(message);
    await assert.rejects(bridge.call('click', { element_index: 3 }), error => failureReply(error).fatal);
    assert.deepEqual(transport.calls.map(c => c.method), ['click_element']);
  }
});

test('failed turn cleanup closes the bridge and makes the input outcome non-replayable', async t => {
  const { bridge, transport } = await runtime(t);
  await bridge.call('get_window', { id: 17 });
  transport.calls.length = 0;
  transport.cleanupError = new Error('cleanup failed');
  await assert.rejects(bridge.call('click', { element_index: 3 }), error => {
    assert.deepEqual(failureReply(error), { ok: false, code: 'CODEX_ENGINE_CLOSED', fatal: true });
    return true;
  });
  assert.equal(bridge.closed, true);
  assert.equal(transport.closed, true);
  await assert.rejects(bridge.call('click', { element_index: 3 }), /CODEX_ENGINE_CLOSED/);
  assert.deepEqual(transport.calls.map(c => c.method), ['click_element', 'end_turn']);
});

test('closing a pending operation prevents cleanup from restarting its transport', async t => {
  const { bridge, transport } = await runtime(t);
  await bridge.call('get_window', { id: 17 });
  transport.calls.length = 0;
  let release;
  transport.defer = new Promise(resolve => { release = resolve; });
  const pending = bridge.call('click', { element_index: 3 });
  await new Promise(resolve => setImmediate(resolve));
  await bridge.close();
  release();
  await assert.rejects(pending, /CODEX_ENGINE_CLOSED/);
  assert.deepEqual(transport.calls.map(c => c.method), ['click_element']);
});
