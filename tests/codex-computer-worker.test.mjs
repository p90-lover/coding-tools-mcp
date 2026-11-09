import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { METHODS } from '../src-tauri/src/tools/computer/codex-bridge.mjs';

const executable = 'G:\\Apps\\Fixture\\fixture.exe';
const window = { id: 17, app: 'process:' + executable, title: 'Worker fixture' };
const bridgeSource = fs.readFileSync(new URL('../src-tauri/src/tools/computer/codex-bridge.mjs', import.meta.url), 'utf8');

async function worker(t) {
  const scratch = fileURLToPath(new URL('../aiTemp/codex-computer-worker-tests/', import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'runtime-'));
  const base = path.join(root, 'dist/project/cua/sky_js/src/targets/windows/internal');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@oai/sky', version: 'fixture', type: 'module' }));
  const helper = path.join(root, 'fixture.exe');
  fs.writeFileSync(helper, 'not executed');
  fs.writeFileSync(path.join(base, 'helper_transport.js'), `
    export class WindowsHelperTransport {
      onExit() {}
      close() { return Promise.resolve(); }
    }
  `);
  fs.writeFileSync(path.join(base, 'computer_use_client.js'), `
    export class WindowsComputerUseClient {
      constructor() {
        this.target = 'windows';
        for (const method of ${JSON.stringify(METHODS)}) this[method] = async () => null;
        this.get_window = async () => (${JSON.stringify(window)});
        this.get_window_state = async () => { throw new Error('timeout'); };
        this.activate_window = async () => { throw new Error('Computer Use was stopped by the user with the physical Escape key'); };
        this.type_text = async () => { process.exitCode = 99; };
      }
      close() { return Promise.resolve(); }
    }
  `);
  const env = { ...process.env, TEMP: root, TMP: root, CODEX_HOME: root };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bridgeSource, '--', '--coding-tools-computer-bridge'], {
    cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (method, params) => child.stdin.write(JSON.stringify({ method, params }) + '\n');
  async function reply() {
    const line = await lines.next();
    assert.equal(line.done, false, 'worker exited before its next reply: ' + stderr);
    return JSON.parse(line.value);
  }
  write('initialize', { sky_root: root, helper, window_id: window.id, executable });
  assert.deepEqual(await reply(), { ok: true, result: { engine: '@oai/sky', version: 'fixture' } });
  return { child, write, reply, lines, exited, stderr: () => stderr };
}

test('the stdio worker survives a screenshot timeout and answers the next observation', { timeout: 10000 }, async t => {
  const w = await worker(t);
  w.write('get_window_state', { include_screenshot: true, include_text: true });
  assert.deepEqual(await w.reply(), { ok: false, code: 'CODEX_ENGINE_TIMEOUT', fatal: false });
  w.write('get_window', { id: window.id });
  assert.deepEqual(await w.reply(), { ok: true, result: window });
  w.child.stdin.end();
  const [code, signal] = await w.exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(w.stderr(), '');
});

test('physical Escape ends the stdio worker before a queued input is dispatched', { timeout: 10000 }, async t => {
  const w = await worker(t);
  w.write('activate_window', {});
  w.write('type_text', { text: 'must not be dispatched' });
  assert.deepEqual(await w.reply(), { ok: false, code: 'CODEX_ENGINE_INTERRUPTED', fatal: true });
  const [code, signal] = await w.exited;
  assert.equal(code, 0, 'the fake type_text exits 99 if it was dispatched');
  assert.equal(signal, null);
  assert.equal((await w.lines.next()).done, true);
  assert.equal(w.stderr(), '');
});
