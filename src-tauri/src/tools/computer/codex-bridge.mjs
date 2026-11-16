// Original integration code. The installed Codex runtime is loaded in place, never vendored.
import { realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

const MAX_MESSAGE = 16 * 1024 * 1024;
const fields = {
  get_window: ['id', 'app'],
  get_window_state: ['window', 'include_screenshot', 'include_text'],
  click: ['window', 'x', 'y', 'element_index', 'mouse_button', 'click_count', 'screenshotId'],
  press_key: ['window', 'key'],
  type_text: ['window', 'text'],
  scroll: ['window', 'x', 'y', 'scrollX', 'scrollY', 'screenshotId'],
  set_value: ['window', 'element_index', 'value'],
  drag: ['window', 'from_x', 'from_y', 'to_x', 'to_y', 'screenshotId'],
  perform_secondary_action: ['window', 'element_index', 'action'],
  activate_window: ['window'],
};
export const METHODS = Object.freeze(Object.keys(fields));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function appPath(app) {
  if (typeof app !== 'string' || !app.startsWith('process:')) return null;
  return path.win32.normalize(app.slice(8).replace(/^\\\\\?\\/, '')).toLowerCase();
}
export function sameExecutable(app, executable) {
  return appPath(app) === appPath('process:' + executable);
}
export function validateCall(method, params) {
  if (!Object.hasOwn(fields, method) || !object(params)) fail('INVALID_CODEX_METHOD');
  if (Object.keys(params).some(key => !fields[method].includes(key))) fail('INVALID_CODEX_PARAMS');
  for (const key of ['x', 'y', 'from_x', 'from_y', 'to_x', 'to_y', 'scrollX', 'scrollY']) {
    if (key in params && (!Number.isFinite(params[key]) || Math.abs(params[key]) > 1_000_000)) fail('INVALID_COORDINATE');
  }
  for (const key of ['element_index', 'id']) {
    if (key in params && (!Number.isSafeInteger(params[key]) || params[key] < 0)) fail('INVALID_ELEMENT');
  }
  for (const key of ['include_text', 'include_screenshot']) {
    if (key in params && typeof params[key] !== 'boolean') fail('INVALID_CODEX_PARAMS');
  }
  for (const key of ['text', 'key', 'value', 'action', 'screenshotId', 'app']) {
    if (key in params && (typeof params[key] !== 'string' || params[key].length > 16384)) fail('INVALID_CODEX_PARAMS');
  }
  if ('click_count' in params && (!Number.isInteger(params.click_count) || params.click_count < 1 || params.click_count > 3)) fail('INVALID_CODEX_PARAMS');
  if ('mouse_button' in params && !['left', 'right', 'middle', 'l', 'r', 'm'].includes(params.mouse_button)) fail('INVALID_CODEX_PARAMS');
  const required = {
    get_window: ['id'], press_key: ['key'], type_text: ['text'],
    scroll: ['x', 'y', 'scrollX', 'scrollY'], set_value: ['element_index', 'value'],
    drag: ['from_x', 'from_y', 'to_x', 'to_y'], perform_secondary_action: ['element_index', 'action'],
  }[method] ?? [];
  if (required.some(key => !Object.hasOwn(params, key))) fail('INVALID_CODEX_PARAMS');
  if (method === 'click' && (params.element_index === undefined ? params.x === undefined || params.y === undefined : params.x !== undefined || params.y !== undefined)) fail('INVALID_CODEX_PARAMS');
  if (method === 'get_window_state' && params.include_screenshot === false && params.include_text !== true) fail('INVALID_CODEX_PARAMS');
  if (JSON.stringify(params).length > 32768) fail('CODEX_REQUEST_TOO_LARGE');
}

export function createBridge({ client, windowId, executable }) {
  let closed = false, nativeWindow = null;
  function approve(request) {
    const meta = request?.meta;
    if (closed || meta?.connector_id !== 'computer-use' || !sameExecutable(meta?.tool_params?.app, executable)) {
      return { action: 'decline' };
    }
    // This is an existing local app grant, not a new or persistent Codex approval.
    return { action: 'accept', _meta: { persist: 'session' } };
  }
  return {
    approve,
    get closed() { return closed; },
    async call(method, params) {
      if (closed) fail('CODEX_ENGINE_CLOSED');
      validateCall(method, params);
      // Rehydrating before every input changes the native observation cache. Keep the exact
      // Window from this grant; Rust and the native helper still verify its process on each call.
      if (!nativeWindow || method === 'get_window') nativeWindow = await client.get_window({ id: windowId });
      const window = nativeWindow;
      if (closed || window.id !== windowId || !sameExecutable(window.app, executable)) fail('CONTROL_SCOPE_MISMATCH');
      if (method === 'get_window') {
        if (params.id !== windowId || (params.app !== undefined && params.app !== window.app)) fail('CONTROL_SCOPE_MISMATCH');
        return window;
      }
      if (params.window !== undefined && (!object(params.window) || params.window.id !== windowId || params.window.app !== window.app)) fail('CONTROL_SCOPE_MISMATCH');
      const result = await client[method]({ ...params, window });
      if (closed) fail('CODEX_ENGINE_CLOSED');
      if (method === 'get_window_state') {
        if (!object(result) || result.window?.id !== windowId || result.window?.app !== window.app || !Array.isArray(result.screenshots)) fail('INVALID_CODEX_RESPONSE');
        for (const image of result.screenshots) {
          if (!object(image) || typeof image.id !== 'string' || typeof image.url !== 'string'
            || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.url)) fail('INVALID_CODEX_RESPONSE');
        }
      }
      if (JSON.stringify(result ?? null).length > MAX_MESSAGE - 1024) fail('CODEX_RESPONSE_TOO_LARGE');
      return result ?? null;
    },
    async close() { closed = true; await client.close(); },
  };
}

export async function loadEngine(config, onUnexpectedExit = () => {}) {
  const root = realpathSync(config.sky_root);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@oai/sky' || typeof manifest.version !== 'string') fail('INCOMPATIBLE_CODEX_RUNTIME');
  const base = path.join(root, 'dist/project/cua/sky_js/src/targets/windows/internal');
  const { WindowsComputerUseClient } = await import(pathToFileURL(path.join(base, 'computer_use_client.js')).href);
  const { WindowsHelperTransport } = await import(pathToFileURL(path.join(base, 'helper_transport.js')).href);
  const helper = realpathSync(config.helper);
  if (!helper.startsWith(root + path.sep)) fail('INVALID_CODEX_RUNTIME');
  let bridge;
  const transport = new WindowsHelperTransport({ helperCommand: helper, helperArgs: ['--parent-pid', String(process.pid)], timeoutMs: 10000 });
  const client = new WindowsComputerUseClient({ transport: {
    close: () => transport.close(),
    request: (method, params, options) => transport.request(method, params, {
      ...options, createElicitation: request => bridge.approve(request),
    }),
  } });
  if (client.target !== 'windows' || METHODS.some(method => typeof client[method] !== 'function')) {
    await client.close(); fail('INCOMPATIBLE_CODEX_RUNTIME');
  }
  bridge = createBridge({ client, windowId: config.window_id, executable: config.executable });
  // The SDK can otherwise relaunch an exited helper. Physical Escape revokes this worker:
  // even an interruption while idle must require a new local grant, never an automatic restart.
  transport.onExit(() => {
    if (!bridge.closed) {
      void bridge.close().catch(() => {});
      onUnexpectedExit();
    }
  });
  return { bridge, version: manifest.version };
}

// A call's failure ends this worker only when the worker can no longer be trusted: the engine
// closed, the person pressed physical Escape, or the window stopped being the approved one. Any
// other refusal (a stale element index, a parameter the engine rejected, a window it cannot see)
// is that call's alone: the worker keeps serving, so one rejected click no longer ends control
// (until 2026-11-09 every failure was fatal and stopped the session).
const FATAL_CODES = new Set(['CODEX_ENGINE_CLOSED', 'CONTROL_SCOPE_MISMATCH', 'INVALID_CODEX_RUNTIME', 'INCOMPATIBLE_CODEX_RUNTIME']);
// What kind of failure an uncoded engine error was, read from its message. Only the fixed code
// leaves the bridge, never the message, which can carry window titles or paths. Until 2026-11-09
// every uncoded failure was CODEX_ENGINE_FAILED, so a failing screenshot could not be told from a
// stale element or a timeout.
const KINDS = [
  [/screenshot|capture|bitmap|printwindow|dxgi|d3d|graphics/i, 'CODEX_CAPTURE_FAILED'],
  [/timed? ?out/i, 'CODEX_ENGINE_TIMEOUT'],
  [/access (is )?denied|permission|elevat/i, 'CODEX_ACCESS_DENIED'],
  [/element|index|stale/i, 'CODEX_ELEMENT_INVALID'],
  [/accessib|automation|uia/i, 'CODEX_ACCESSIBILITY_FAILED'],
];
export function failureReply(error, closed = false) {
  const message = String(error?.message ?? '');
  if (/stopped by the user|physical Escape/i.test(message)) return { ok: false, code: 'CODEX_ENGINE_INTERRUPTED', fatal: true };
  if (/^Computer Use has been stopped for this turn\b/i.test(message)) return { ok: false, code: 'CODEX_POLICY_STOPPED', fatal: true };
  // The SDK's own words when it gives up on its helper. Its request timer kills the helper
  // (measured with @oai/sky 0.7.12 on 2026-11-10: the exit listeners ran 20 ms after the
  // rejection), and that exit ends this worker through loadEngine's onExit. So these replies are
  // fatal: "control stays on" would be wrong. The helper's own "timeout" stays a refusal, since the
  // helper is still running then.
  if (/^computer-use request timed out/i.test(message)) return { ok: false, code: 'CODEX_ENGINE_TIMEOUT', fatal: true };
  if (/^computer-use helper exited/i.test(message)) return { ok: false, code: 'CODEX_ENGINE_CLOSED', fatal: true };
  // The engine lists no window it will not control: Codex leaves out its own (ChatGPT and Codex).
  if (/window id \d+ was not found/i.test(message)) return { ok: false, code: 'CODEX_WINDOW_HIDDEN', fatal: closed };
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code
    : KINDS.find(([pattern]) => pattern.test(message))?.[1] ?? 'CODEX_ENGINE_FAILED';
  return { ok: false, code, fatal: closed || FATAL_CODES.has(code) };
}

async function* messages(stream) {
  let buffer = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 32768) fail('CODEX_REQUEST_TOO_LARGE');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) fail('INVALID_CODEX_PARAMS');
}
async function send(value) {
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > MAX_MESSAGE) fail('CODEX_RESPONSE_TOO_LARGE');
  if (!process.stdout.write(text)) await once(process.stdout, 'drain');
}
export async function main() {
  let bridge;
  try {
    for await (const request of messages(process.stdin)) {
      if (!bridge) {
        if (request.method !== 'initialize') fail('INVALID_CODEX_PARAMS');
        const loaded = await loadEngine(request.params, () => process.exit(130));
        bridge = loaded.bridge;
        await send({ ok: true, result: { engine: '@oai/sky', version: loaded.version } });
        continue;
      }
      try {
        await send({ ok: true, result: await bridge.call(request.method, request.params) });
      } catch (error) {
        // Never echo native error text, source code, typed values or screenshot bytes.
        const reply = failureReply(error, bridge.closed);
        await send(reply);
        if (reply.fatal) break;
      }
    }
  } catch {
    await send({ ok: false, code: 'CODEX_ENGINE_START_FAILED', fatal: true }).catch(() => {});
    process.exitCode = 1;
  } finally { await bridge?.close().catch(() => {}); }
}
if (process.argv.includes('--coding-tools-computer-bridge')) await main();
