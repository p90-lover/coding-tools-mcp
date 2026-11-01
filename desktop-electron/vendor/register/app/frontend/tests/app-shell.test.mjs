import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function storedCredential(value, fetch = async () => assert.fail('Unexpected fixture request')) {
  const utils = readFileSync(new URL('../src/lib/utils.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = utils.indexOf('export function getAuthToken')
  const end = utils.indexOf('\nexport function triggerBrowserDownload', start)
  const code = compile("const API = '/api';\n" + utils.slice(start, end).replace(/^export /gm, ''))
  const values = new Map([['theme', 'dark']])
  if (value !== undefined) values.set('_auth_token', value)
  const removed = []
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, next) => values.set(key, next),
    removeItem: key => { removed.push(key); values.delete(key) },
  }
  let reloads = 0
  const utilities = new Function('localStorage', 'fetch', 'window', code + '\nreturn { getAuthToken, apiDownload }')(localStorage, fetch, { location: { reload: () => { reloads += 1 } } })
  return { get: utilities.getAuthToken, download: utilities.apiDownload, values, removed, reloads: () => reloads }
}

test('saved header-safe credentials remain unchanged, including legacy passwords', () => {
  for (const token of ['fixture.opaque-token', 'fixture legacy password', 'fixture-café', '0']) {
    const storage = storedCredential(token)
    assert.equal(storage.get(), token)
    assert.equal(storage.values.get('_auth_token'), token)
    assert.deepEqual(storage.removed, [])
  }
})

test('unusable persisted credentials are cleared so the access check can request login', () => {
  for (const token of ['fixture-密碼', 'fixture\r\nvalue', 'fixture\0value']) {
    const storage = storedCredential(token)
    assert.equal(storage.get(), '')
    assert.equal(storage.values.has('_auth_token'), false)
    assert.equal(storage.values.get('theme'), 'dark')
    assert.deepEqual(storage.removed, ['_auth_token'])
  }
})

test('missing saved credentials do not rewrite unrelated browser preferences', () => {
  for (const token of [undefined, '']) {
    const storage = storedCredential(token)
    assert.equal(storage.get(), '')
    assert.deepEqual(storage.removed, [])
    assert.equal(storage.values.get('theme'), 'dark')
  }
})



test('download preserves literal percent signs in plain filenames', async () => {
  for (const header of ['attachment; filename=fixture%name.json', 'attachment; filename="fixture%41.json"',
    'attachment; filename="semi;percent%41.json"; other=value']) {
    const expected = header.includes('semi;') ? 'semi;percent%41.json' : header.includes('%41') ? 'fixture%41.json' : 'fixture%name.json'
    const storage = storedCredential(undefined, async () => new Response('fixture body', { headers: { 'Content-Disposition': header } }))
    const result = await storage.download('/fixture-download')
    assert.equal(result.filename, expected)
    assert.equal(await result.blob.text(), 'fixture body')
  }
})

test('UTF-8 extended download names take precedence independent of case and parameter order', async () => {
  const filename = 'fixture-帳戶%name.json'
  for (const header of [
    "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
    "attachment; filename*=utf-8'en'" + encodeURIComponent(filename),
    'attachment; filename="fallback.json"; FILENAME*=utf-8\'\'' + encodeURIComponent(filename),
  ]) {
    const storage = storedCredential(undefined, async () => new Response('fixture body', { headers: { 'Content-Disposition': header } }))
    assert.equal((await storage.download('/fixture-download')).filename, filename)
  }
})

test('malformed extended download names retain a usable fallback and never discard the body', async () => {
  for (const [header, filename] of [
    ["attachment; filename=plain%name.json; filename*=UTF-8''broken%ZZ", 'plain%name.json'],
    ["attachment; filename*=UTF-8''broken%ZZ", 'download'],
    ['', 'download'],
    ['attachment; filename="quoted\\\"name.json"', 'quoted"name.json'],
  ]) {
    const storage = storedCredential(undefined, async () => new Response('fixture body', { headers: { 'Content-Disposition': header } }))
    const result = await storage.download('/fixture-download')
    assert.equal(result.filename, filename)
    assert.equal(await result.blob.text(), 'fixture body')
  }
})

test('a failed download preserves valid credentials and permits retry', async () => {
  let calls = 0
  const storage = storedCredential('fixture-valid-token', async () => ++calls === 1
    ? new Response('{"detail":"Fixture export unavailable"}', { status: 503 })
    : new Response('fixture retry body', { headers: { 'Content-Disposition': 'attachment; filename=retry.json' } }))
  await assert.rejects(storage.download('/fixture-download'), /Fixture export unavailable/)
  assert.equal(storage.get(), 'fixture-valid-token')
  const result = await storage.download('/fixture-download')
  assert.equal(result.filename, 'retry.json')
  assert.equal(await result.blob.text(), 'fixture retry body')
  assert.equal(storage.reloads(), 0)
})

test('an unauthorized download clears only app authentication and requests login', async () => {
  const storage = storedCredential('fixture-valid-token', async () => new Response('{"detail":"Unauthorized"}', { status: 401 }))
  await assert.rejects(storage.download('/fixture-download'), /Unauthorized/)
  assert.equal(storage.get(), '')
  assert.equal(storage.values.get('theme'), 'dark')
  assert.equal(storage.reloads(), 1)
})

async function checkAccess(reply, token = '') {
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App')
  let effectCode
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes("fetch(API + '/auth/check')")) effectCode = node.arguments[0].getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(component)
  assert.ok(effectCode)
  const states = []
  const deps = {API: '/api', fetch: reply, getAuthToken: () => token, setAuthState: value => states.push(value)}
  const effect = new Function(...Object.keys(deps), compile('const effect = ' + effectCode) + '\nreturn effect')(...Object.values(deps))
  effect()
  await new Promise(resolve => setImmediate(resolve))
  return states.at(-1)
}

test('access check failures and invalid replies show retry instead of opening the shell', async () => {
  assert.equal(await checkAccess(async () => { throw new Error('Fixture offline') }), 'error')
  assert.equal(await checkAccess(async () => ({ ok: false, json: async () => ({ detail: 'Fixture unavailable' }) })), 'error')
  assert.equal(await checkAccess(async () => ({ ok: true, json: async () => ({ required: 'false' }) })), 'error')
})

test('access check preserves public, locked and previously authenticated flows', async () => {
  assert.equal(await checkAccess(async () => ({ ok: true, json: async () => ({ required: false }) })), 'open')
  const required = async () => ({ ok: true, json: async () => ({ required: true }) })
  assert.equal(await checkAccess(required), 'locked')
  assert.equal(await checkAccess(required, 'fixture-existing-session'), 'authed')
})

test('login distinguishes transport failure from a rejected password and accepts success', async () => {
  const start = source.indexOf('  const submit = ', source.indexOf('function LoginScreen'))
  const end = source.indexOf('\n\n  return (', start)
  const submitCode = compile(source.slice(start, end))
  for (const fixture of [
    { reply: { ok: false, json: async () => ({ detail: 'Fixture unavailable' }) }, error: '请求失败' },
    { reply: { ok: true, json: async () => ({ ok: false, error: '密码错误' }) }, error: '密码错误' },
    { reply: { ok: true, json: async () => ({ ok: true, token: 'fixture-new-session' }) }, token: 'fixture-new-session' },
  ]) {
    const state = { loading: false, error: '', token: '', loggedIn: false }
    const deps = {
      API: '/api', pw: 'fixture-password', loginPendingRef: {current: false}, fetch: async () => fixture.reply,
      setLoading: value => { state.loading = value }, setError: value => { state.error = value },
      setAuthToken: value => { state.token = value }, onLogin: () => { state.loggedIn = true },
    }
    const submit = new Function(...Object.keys(deps), submitCode + '\nreturn submit')(...Object.values(deps))
    await submit({ preventDefault() {} })
    assert.equal(state.loading, false)
    assert.equal(state.error, fixture.error || '')
    assert.equal(state.token, fixture.token || '')
    assert.equal(state.loggedIn, Boolean(fixture.token))
  }
})



function loginHarness(fetcher, pw = 'fixture-password') {
  const start = source.indexOf('  const submit = ', source.indexOf('function LoginScreen'))
  const end = source.indexOf('\n\n  return (', start)
  const state = {loading: false, error: '', writes: [], logins: [], requests: []}
  const deps = {API: '/api', pw, loginPendingRef: {current: false},
    fetch: (path, options) => { state.requests.push(path); return fetcher(path, options) },
    setLoading: value => { state.loading = value }, setError: value => { state.error = value },
    setAuthToken: value => state.writes.push(value), onLogin: value => state.logins.push(value)}
  const submit = new Function(...Object.keys(deps), compile(source.slice(start, end)) + '\nreturn submit')(...Object.values(deps))
  return {state, submit: () => submit({preventDefault() {}})}
}

test('login makes one request while submission is pending and releases the guard after failure', async () => {
  const releases = []
  const ui = loginHarness(() => new Promise(resolve => releases.push(resolve)))
  const first = ui.submit(), second = ui.submit()
  const count = ui.state.requests.length
  for (const release of releases) release({ok: true, json: async () => ({ok: false, error: 'Fixture denied'})})
  await Promise.all([first, second])
  assert.equal(count, 1)
  assert.equal(ui.state.loading, false)
  const retry = ui.submit()
  releases.at(-1)({ok: true, json: async () => ({ok: true, token: 'fixture-session'})})
  await retry
  assert.deepEqual(ui.state.logins, ['fixture-session'])
})

test('malformed login success cannot authenticate or persist an unusable credential', async () => {
  for (const reply of [null, {ok: 'false', token: 'fixture'}, {ok: true, token: {}},
    {ok: true, token: 'fixture\r\nvalue'}, {ok: true, token: 'fixture-密碼'}, {ok: true, token: '   '}]) {
    const ui = loginHarness(async () => ({ok: true, json: async () => reply}))
    await ui.submit()
    assert.deepEqual(ui.state.logins, [])
    assert.deepEqual(ui.state.writes, [])
    assert.equal(ui.state.error, '请求失败')
    assert.equal(ui.state.loading, false)
  }
})

test('structured login rejection remains a renderable password error', async () => {
  const ui = loginHarness(async () => ({ok: true, json: async () => ({ok: false, error: {message: 'Fixture denied'}})}))
  await ui.submit()
  assert.equal(ui.state.error, '密码错误')
  assert.deepEqual(ui.state.logins, [])
})

test('login without a token opens the shell only after public mode is confirmed', async () => {
  for (const required of [true, false, undefined, 'false']) {
    const ui = loginHarness(async path => ({ok: true, json: async () => path.endsWith('/check') ? {required} : {ok: true}}))
    await ui.submit()
    assert.deepEqual(ui.state.requests, ['/api/auth/login', '/api/auth/check'])
    assert.equal(ui.state.logins.length, Number(required === false))
    assert.equal(ui.state.writes.length, Number(required === false))
    if (required !== false) assert.equal(ui.state.error, '请求失败')
  }
})

test('login retains header-safe opaque and legacy credentials exactly', async () => {
  for (const token of ['fixture-session', 'fixture legacy password', 'fixture-café', '0']) {
    const ui = loginHarness(async () => ({ok: true, json: async () => ({ok: true, token})}))
    await ui.submit()
    assert.deepEqual(ui.state.writes, [token])
    assert.deepEqual(ui.state.logins, [token])
  }
})

test('empty login submission does not issue a request', async () => {
  const ui = loginHarness(() => assert.fail('Empty password submitted'), '')
  await ui.submit()
  assert.deepEqual(ui.state.requests, [])
  assert.equal(ui.state.loading, false)
})

test('mobile navigation follows viewport changes without changing desktop preferences', () => {
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const shell = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'Shell')
  let effectCode, initialCode
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes("matchMedia('(max-width: 767px)')")) {
      effectCode = node.arguments[0].getText(ast)
    }
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
      && node.name.elements[0].name?.getText(ast) === 'mobile') {
      initialCode = node.initializer.arguments[0].getText(ast)
    }
    ts.forEachChild(node, visit)
  }
  visit(shell)
  assert.ok(effectCode)
  assert.ok(initialCode)
  for (const initial of [false, true]) {
    const states = [], menus = [], listeners = new Set()
    const query = { matches: initial,
      addEventListener: (event, handler) => { assert.equal(event, 'change'); listeners.add(handler) },
      removeEventListener: (event, handler) => { assert.equal(event, 'change'); listeners.delete(handler) } }
    const window = { matchMedia: value => { assert.equal(value, '(max-width: 767px)'); return query } }
    const initialize = new Function('window', compile('const initialize = ' + initialCode) + '\nreturn initialize')(window)
    assert.equal(initialize(), initial)
    const deps = { window, setMobile: value => states.push(value), setMobileOpen: value => menus.push(value) }
    const effect = new Function(...Object.keys(deps), compile('const effect = ' + effectCode) + '\nreturn effect')(...Object.values(deps))
    const cleanup = effect()
    assert.deepEqual(states, [initial])
    assert.deepEqual(menus, [false])
    assert.equal(listeners.size, 1)
    query.matches = !initial
    for (const handler of listeners) handler()
    assert.deepEqual(states, [initial, !initial])
    assert.deepEqual(menus, [false, false])
    cleanup()
    assert.equal(listeners.size, 0)
  }
})

test('sidebar theme control names describe the next theme in the cycle', () => {
  const expression = source.match(/title=\{(theme === [^\n]+)\}/)[1]
  const label = new Function('theme', 'return ' + expression)
  for (const [theme, nextLabel] of [
    ['dark', '切换到浅色'], ['light', '切换到跟随系统'], ['system', '切换到深色'],
  ]) assert.equal(label(theme), nextLabel)
})

