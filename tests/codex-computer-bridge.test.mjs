import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, loadEngine, validateCall, sameExecutable, failureReply, METHODS } from '../src-tauri/src/tools/computer/codex-bridge.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const executable = 'G:\\Apps\\Fixture\\fixture.exe';
const window = { id: 17, app: 'process:' + executable, title: 'Owned fixture' };
const png = 'data:image/png;base64,aGVsbG8=';
function fixture(overrides = {}) {
  const calls = [];
  const client = {
    async get_window(params) { calls.push(['get_window', params]); return window; },
    async close() { calls.push(['close']); },
    ...Object.fromEntries(METHODS.filter(name => name !== 'get_window').map(name => [name, async params => {
      calls.push([name, params]);
      return name === 'get_window_state' ? { window, accessibility: { tree: '0 Button' }, screenshots: [{ id: 'native-1', url: png, width: 640, height: 480, zIndex: 0 }] } : undefined;
    }])),
    ...overrides,
  };
  return { calls, bridge: createBridge({ client, windowId: window.id, executable }) };
}

test('a refused call keeps the worker; a closed engine, Escape or a changed window ends it', async () => {
  const coded = code => Object.assign(new Error(code), { code });
  // A stale element index, as the real engine refused it on 2026-11-09, must not end control.
  assert.deepEqual(failureReply(new Error('element index 99999 is out of range')), { ok: false, code: 'CODEX_ENGINE_FAILED', fatal: false });
  assert.deepEqual(failureReply(coded('INVALID_CODEX_PARAMS')), { ok: false, code: 'INVALID_CODEX_PARAMS', fatal: false });
  // The engine lists no ChatGPT or Codex window: seen live as "window id 525084 was not found. Current windows: []".
  assert.deepEqual(failureReply(new Error('window id 525084 was not found. Current windows: []')), { ok: false, code: 'CODEX_WINDOW_HIDDEN', fatal: false });
  assert.deepEqual(failureReply(new Error('Computer use was stopped by the user')), { ok: false, code: 'CODEX_ENGINE_INTERRUPTED', fatal: true });
  assert.deepEqual(failureReply(coded('CONTROL_SCOPE_MISMATCH')), { ok: false, code: 'CONTROL_SCOPE_MISMATCH', fatal: true });
  assert.deepEqual(failureReply(coded('CODEX_ENGINE_CLOSED')), { ok: false, code: 'CODEX_ENGINE_CLOSED', fatal: true });
  assert.equal(failureReply(coded('INVALID_ELEMENT'), true).fatal, true, 'anything after the engine closed is fatal');
  // Native text never becomes a code.
  assert.equal(failureReply(coded('C:\\secret path')).code, 'CODEX_ENGINE_FAILED');
  const { bridge } = fixture({ async click() { throw new Error('element index 4 is stale'); } });
  await assert.rejects(bridge.call('click', { element_index: 4 }), /stale/);
  assert.equal(bridge.closed, false, 'the bridge itself stays open after a refused call');
  assert.ok((await bridge.call('get_window_state', { include_screenshot: true })).screenshots.length);
});

test('the documented window2 methods reach the actual client with the approved native Window', async () => {
  const f = fixture();
  const examples = {
    get_window_state: { include_screenshot: true, include_text: true },
    click: { x: 1, y: 2, screenshotId: 'native-1', mouse_button: 'middle', click_count: 2 },
    press_key: { key: 'Control_L+a' }, type_text: { text: 'Fixture\ntext' },
    scroll: { x: 10, y: 20, scrollX: 5, scrollY: -80 },
    set_value: { element_index: 3, value: 'replacement' },
    drag: { from_x: 1, from_y: 2, to_x: 20, to_y: 30 },
    perform_secondary_action: { element_index: 4, action: 'Expand' },
    activate_window: {},
  };
  for (const [method, params] of Object.entries(examples)) {
    const result = await f.bridge.call(method, params);
    assert.deepEqual(f.calls.at(-1), [method, { ...params, window }]);
    if (method === 'get_window_state') assert.equal(result.screenshots[0].url, png);
    else assert.equal(result, null);
  }
  assert.deepEqual(await f.bridge.call('get_window', { id: 17 }), window);
  await f.bridge.close();
  assert.deepEqual(f.calls.at(-1), ['close']);
});

test('callers cannot substitute a different native window, application or process', async () => {
  for (const supplied of [{ ...window, id: 99 }, { ...window, app: 'process:G:\\Other.exe' }, null, []]) {
    const f = fixture();
    await assert.rejects(f.bridge.call('type_text', { window: supplied, text: 'must not type' }), /CONTROL_SCOPE_MISMATCH/);
    assert.equal(f.calls.length, 1);
  }
  for (const actual of [{ ...window, id: 99 }, { ...window, app: 'process:G:\\Other.exe' }]) {
    const f = fixture({ get_window: async () => actual });
    await assert.rejects(f.bridge.call('activate_window', {}), /CONTROL_SCOPE_MISMATCH/);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  await assert.rejects(f.bridge.call('get_window', { id: 99 }), /CONTROL_SCOPE_MISMATCH/);
});

test('the local executable grant authorizes only that app, never audio or persistent new authority', async () => {
  const f = fixture();
  const request = { meta: { connector_id: 'computer-use', tool_params: { app: window.app } } };
  assert.deepEqual(f.bridge.approve(request), { action: 'accept', _meta: { persist: 'session' } });
  for (const app of ['computer-audio', 'process:G:\\Other.exe', 'process:G:\\Apps\\Fixture\\fixture.exe.attacker', '', null]) {
    assert.equal(f.bridge.approve({ meta: { connector_id: 'computer-use', tool_params: { app } } }).action, 'decline');
  }
  assert.equal(f.bridge.approve({ meta: { ...request.meta, connector_id: 'another-tool' } }).action, 'decline');
  await f.bridge.close();
  assert.equal(f.bridge.approve(request).action, 'decline');
});

test('executable comparisons normalize Windows path spelling without accepting a path prefix', () => {
  assert.equal(sameExecutable('process:g:/apps/fixture/FIXTURE.exe', executable), true);
  assert.equal(sameExecutable('process:\\\\?\\G:\\Apps\\Fixture\\fixture.exe', executable), true);
  assert.equal(sameExecutable('process:' + executable + '.other', executable), false);
  assert.equal(sameExecutable('fixture.exe', executable), false);
});

test('unknown methods and invalid parameter shapes fail before calling the engine', async () => {
  const f = fixture();
  for (const method of ['launch_app', 'start_audio_recording', 'eval', '__proto__', 'constructor', 'list_apps']) {
    await assert.rejects(f.bridge.call(method, {}), /INVALID_CODEX_METHOD/);
  }
  for (const [method, params] of [
    ['type_text', { text: 'no', path: 'destination.png' }], ['type_text', {}],
    ['click', {}], ['click', { x: Infinity, y: 1 }], ['click', { x: 1, y: 2, element_index: 0 }],
    ['click', { element_index: -1 }], ['click', { x: 1, y: 2, click_count: 10000 }],
    ['drag', { from_x: 0, from_y: 1, to_x: 2 }], ['scroll', { x: 1, y: 2, scrollY: 3 }],
    ['get_window_state', { include_screenshot: false }], ['get_window_state', { include_text: 'true' }],
    ['set_value', { element_index: 2, value: 'x'.repeat(16385) }],
  ]) await assert.rejects(f.bridge.call(method, params));
  assert.deepEqual(f.calls, []);
});

test('only bounded in-memory native screenshot responses are forwarded', async () => {
  for (const screenshots of [[{ id: '1', url: 'file:///private.png' }], [{ id: '1', url: 'https://external.invalid/image.png' }], [{ id: '1', url: 'data:text/html;base64,SGVsbG8=' }], null]) {
    const f = fixture({ get_window_state: async () => ({ window, screenshots }) });
    await assert.rejects(f.bridge.call('get_window_state', {}), /INVALID_CODEX_RESPONSE/);
  }
  const f = fixture({ get_window_state: async () => ({ window, screenshots: [], accessibility: { tree: 'x'.repeat(16 * 1024 * 1024) } }) });
  await assert.rejects(f.bridge.call('get_window_state', {}), /CODEX_RESPONSE_TOO_LARGE/);
});

test('closing during an operation fences late results and every subsequent action', async () => {
  let finish;
  const f = fixture({ type_text: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.bridge.call('type_text', { text: 'fixture' });
  await new Promise(resolve => setImmediate(resolve));
  await f.bridge.close(); finish();
  await assert.rejects(pending, /CODEX_ENGINE_CLOSED/);
  await assert.rejects(f.bridge.call('activate_window', {}), /CODEX_ENGINE_CLOSED/);
});

test('an observed native Window stays cached between actions so screenshots and indexes remain valid', async () => {
  const f = fixture();
  await f.bridge.call('get_window_state', { include_text: true });
  await f.bridge.call('click', { element_index: 0 });
  await f.bridge.call('type_text', { text: 'fixture' });
  assert.equal(f.calls.filter(([method]) => method === 'get_window').length, 1);
  assert.deepEqual(f.calls.map(([method]) => method), ['get_window', 'get_window_state', 'click', 'type_text']);
});

test('an unexpected native-helper exit revokes the bridge even while idle and never relaunches it', async t => {
  const scratch = fileURLToPath(new URL('../aiTemp/codex-computer-bridge-tests/', import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'dist/project/cua/sky_js/src/targets/windows/internal');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@oai/sky', version: 'fixture', type: 'module' }));
  const helper = path.join(root, 'fixture.exe'); fs.writeFileSync(helper, 'not executed');
  fs.writeFileSync(path.join(base, 'helper_transport.js'), `
    export let current;
    export class WindowsHelperTransport {
      constructor() { current = this; }
      onExit(fn) { this.exit = fn; }
      close() { this.closed = true; return Promise.resolve(); }
      request(method, params) { return Promise.resolve(params); }
    }
  `);
  fs.writeFileSync(path.join(base, 'computer_use_client.js'), `
    export class WindowsComputerUseClient {
      constructor({transport}) {
        this.target = 'windows'; this.transport = transport;
        for (const method of ${JSON.stringify(METHODS)}) this[method] = params => transport.request(method, params);
        this.get_window = async () => (${JSON.stringify(window)});
      }
      close() { return this.transport.close(); }
    }
  `);
  let unexpected = 0;
  const loaded = await loadEngine({ sky_root: root, helper, window_id: 17, executable }, () => { unexpected++; });
  const { current } = await import(pathToFileURL(path.join(base, 'helper_transport.js')));
  assert.equal(loaded.bridge.closed, false);
  current.exit();
  assert.equal(loaded.bridge.closed, true);
  assert.equal(unexpected, 1);
  assert.equal(current.closed, true);
  await assert.rejects(loaded.bridge.call('activate_window', {}), /CODEX_ENGINE_CLOSED/);
  current.exit(); assert.equal(unexpected, 1);
});

test('explicitly requested windows and screenshot identifiers are preserved', async () => {
  const f = fixture();
  await f.bridge.call('click', { window, element_index: 0, mouse_button: 'right' });
  assert.deepEqual(f.calls.at(-1), ['click', { window, element_index: 0, mouse_button: 'right' }]);
  assert.doesNotThrow(() => validateCall('get_window_state', { include_screenshot: false, include_text: true }));
});
