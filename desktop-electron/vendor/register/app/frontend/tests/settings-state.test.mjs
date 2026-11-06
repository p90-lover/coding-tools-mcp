import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const page = read('../src/pages/SettingsPage.tsx')
const settings = read('../src/pages/Settings.tsx')
const cards = read('../src/components/settings/ProviderCards.tsx')
const advanced = read('../src/components/settings/AdvancedSettings.tsx')
const compile = code => ts.transpileModule(code, {compilerOptions: {
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
}}).outputText
const extract = (source, start, end) => {
  const offset = source.indexOf(start)
  assert.ok(offset >= 0, start)
  const limit = source.indexOf(end, offset + start.length)
  assert.ok(limit > offset, end)
  return source.slice(offset, limit)
}
const make = (code, dependencies, result) => new Function(...Object.keys(dependencies),
  compile(code) + '\nreturn ' + result)(...Object.values(dependencies))
const flush = () => new Promise(resolve => setImmediate(resolve))
const setter = (state, key) => value => { state[key] = typeof value === 'function' ? value(state[key]) : value }
function effect(source, marker, dependencies) {
  const index = source.indexOf(marker)
  const start = source.lastIndexOf('  useEffect(() => {', index)
  const end = source.indexOf('\n  }, [', index)
  assert.ok(index >= 0 && start >= 0 && end > start, marker)
  let callback
  make(source.slice(start, source.indexOf('\n', end + 1)), {
    loadAttempt: 0, useEffect: value => { callback = value }, ...dependencies,
  }, 'undefined')
  return callback
}

test('general settings do not silently hydrate empty defaults after a failed read', async () => {
  const state = {form: {}, error: '', loading: true, options: null}
  const load = effect(page, 'Promise.all([getConfig', {
    getConfig: async () => { throw new Error('Fixture config unavailable') },
    getConfigOptions: async () => ({}),
    setForm: setter(state, 'form'), setConfigOptions: setter(state, 'options'),
    setLoadError: setter(state, 'error'), setLoading: setter(state, 'loading'),
  })
  load()
  await flush()
  assert.match(state.error, /Fixture config unavailable/)
  assert.equal(state.loading, false)
})

for (const [label, source, start, end] of [
  ['general', page, '  const save = async () => {', '  const executorOptions'],
  ['shared', settings, '  const save = async () => {', '  const tab = TABS.find'],
]) {
  test(label + ' settings surface save errors and release the synchronous guard', async () => {
    const state = {saving: false, saved: true, error: ''}
    const code = extract(source, start, end)
    let calls = 0
    const save = make(code, {
      form: {default_executor: 'headed'}, saving: false, loading: false, loadError: '',
      configLoading: false, optionsError: '', mountedRef: {current: true},
      savePendingRef: {current: false}, dirtyFieldsRef: {current: new Set(['default_executor'])},
      setSaving: setter(state, 'saving'), setSaved: setter(state, 'saved'),
      setSaveError: setter(state, 'error'), invalidateConfigCache() {}, setTimeout() {},
      apiFetch: async () => { calls++; throw new Error('Fixture save rejected') },
    }, 'save')
    await assert.doesNotReject(save())
    assert.match(state.error, /Fixture save rejected/)
    assert.equal(state.saving, false)
    assert.equal(state.saved, false)
    await save()
    assert.equal(calls, 2)
  })
}


for (const [label, source, end] of [
  ['general', page, '  const executorOptions'],
  ['shared', settings, '  const tab = TABS.find'],
]) {
  test(label + ' saves only edited settings and retains their empty and false values after retry', async () => {
    const state = {saving: false, saved: false, error: ''}
    const form = {default_executor: 'headed', oauth_email_hint: '', chatgpt_token_refresh_headless: 'false',
      cpa_api_url: 'https://fixture-old.invalid', cpa_api_key: 'fixture-old-key'}
    const stored = {default_executor: 'headless', oauth_email_hint: 'before@example.invalid',
      chatgpt_token_refresh_headless: 'true', cpa_api_url: 'https://fixture-new.invalid', cpa_api_key: 'fixture-rotated-key'}
    const dirtyFieldsRef = {current: new Set(['oauth_email_hint', 'chatgpt_token_refresh_headless'])}
    const posts = []
    let reject = true
    const save = make(extract(source, '  const save = async () => {', end), {
      form, loading: false, loadError: '', configLoading: false, optionsError: '',
      savePendingRef: {current: false}, dirtyFieldsRef, mountedRef: {current: true},
      setSaving: setter(state, 'saving'), setSaved: setter(state, 'saved'), setSaveError: setter(state, 'error'),
      invalidateConfigCache() {}, loadConfigData: async () => {},
      apiFetch: async (_path, init) => {
        const {data} = JSON.parse(init.body)
        posts.push(data)
        if (reject) throw new Error('Fixture save rejected')
        Object.assign(stored, data)
      },
    }, 'save')
    await save()
    assert.deepEqual([...dirtyFieldsRef.current], ['oauth_email_hint', 'chatgpt_token_refresh_headless'])
    assert.equal(state.saved, false)
    reject = false
    await save()
    assert.deepEqual(posts, [
      {oauth_email_hint: '', chatgpt_token_refresh_headless: 'false'},
      {oauth_email_hint: '', chatgpt_token_refresh_headless: 'false'},
    ])
    assert.equal(stored.default_executor, 'headless')
    assert.equal(stored.cpa_api_url, 'https://fixture-new.invalid')
    assert.equal(stored.cpa_api_key, 'fixture-rotated-key')
    assert.equal(stored.oauth_email_hint, '')
    assert.equal(stored.chatgpt_token_refresh_headless, 'false')
    assert.equal(dirtyFieldsRef.current.size, 0)
    assert.equal(state.saved, true)
    await save()
    assert.deepEqual(posts[2], {})
    assert.equal(stored.cpa_api_key, 'fixture-rotated-key')
  })
}

test('provider metadata reload preserves edited global settings', async () => {
  const state = {form: {default_executor: 'headed', cpa_api_url: 'fixture draft'}, error: '', loading: false}
  const load = make(extract(settings, '  const loadConfigData = ', '\n  // Sync activeTab'), {
    useCallback: fn => fn, useEffect() {}, mountedRef: {current: true}, loadRequestRef: {current: 0},
    dirtyFieldsRef: {current: new Set(['default_executor', 'cpa_api_url'])},
    getConfig: async () => ({default_executor: 'headless', cpa_api_url: 'stored'}),
    getConfigOptions: async () => ({mailbox_settings: [], captcha_settings: [], sms_settings: []}),
    setForm: setter(state, 'form'), setConfigOptions() {}, setProviderSettings() {},
    setOptionsError: setter(state, 'error'), setConfigLoading: setter(state, 'loading'),
  }, 'loadConfigData')
  await load(true)
  assert.equal(state.form.default_executor, 'headed')
  assert.equal(state.form.cpa_api_url, 'fixture draft')
})


test('a provider reload begun before a save cannot revert the saved form after it completes', async () => {
  const state = {form: {cpa_api_url: 'fixture-new'}, error: '', loading: false, saving: false, saved: false}
  let releaseOptions, configReads = 0, optionReads = 0
  const oldOptions = new Promise(resolve => { releaseOptions = resolve })
  const handlers = make(
    extract(settings, '  const loadConfigData = ', '\n  // Sync activeTab') +
    extract(settings, '  const save = async () => {', '  const tab = TABS.find'),
    {
      useCallback: fn => fn, useEffect() {}, mountedRef: {current: true}, loadRequestRef: {current: 0},
      dirtyFieldsRef: {current: new Set(['cpa_api_url'])}, savePendingRef: {current: false},
      configLoading: false, optionsError: '', form: state.form,
      getConfig: async () => ({cpa_api_url: configReads++ === 0 ? 'fixture-old' : 'fixture-new'}),
      getConfigOptions: () => optionReads++ === 0 ? oldOptions : Promise.resolve({}),
      setForm: setter(state, 'form'), setConfigOptions() {}, setProviderSettings() {},
      setOptionsError: setter(state, 'error'), setConfigLoading: setter(state, 'loading'),
      setSaving: setter(state, 'saving'), setSaved: setter(state, 'saved'), setSaveError: setter(state, 'error'),
      apiFetch: async () => ({}), invalidateConfigCache() {}, setTimeout() {},
    }, '{loadConfigData, save}')
  const pendingLoad = handlers.loadConfigData()
  await flush()
  await handlers.save()
  releaseOptions({})
  await pendingLoad
  assert.equal(state.form.cpa_api_url, 'fixture-new')
  assert.equal(state.loading, false)
})

test('provider row mutations report errors instead of rejecting an event handler', async () => {
  const state = {loading: {}, errors: {}, results: {}}
  const run = make(extract(cards, '  const withLoading = ', '  const handleToggle = '), {
    pendingKeysRef: {current: new Set()}, mountedRef: {current: true},
    setLoading: setter(state, 'loading'), setActionErrors: setter(state, 'errors'),
    setTestResults: setter(state, 'results'),
  }, 'withLoading')
  await assert.doesNotReject(run('fixture', async () => { throw new Error('Fixture toggle rejected') }))
  assert.match(state.errors.fixture, /Fixture toggle rejected/)
  assert.equal(state.loading.fixture, false)
})

test('setting a default provider preserves its saved metadata', async () => {
  const item = {id: 7, provider_key: 'fixture', config: {country: '16'}, auth: {key: 'fixture'},
    enabled: true, metadata: {owner: 'fixture-owner'}}
  let sent
  const setDefault = make(extract(cards, '  const handleSetDefault = ', '  const handleTestInline = '), {
    withLoading: async (_key, fn) => fn(), settingsMap: {fixture: item}, providerType: 'sms',
    apiFetch: async (_path, options) => { sent = JSON.parse(options.body) },
    invalidateConfigOptionsCache() {}, onReload: async () => {},
  }, 'handleSetDefault')
  await setDefault({value: 'fixture'})
  assert.deepEqual(sent.metadata, item.metadata)
  assert.deepEqual(sent.auth, item.auth)
})


for (const [name, code] of [['EditModal', cards], ['CreateProviderDefinitionModal', settings]]) {
  test(name + ' guards pending dismissal and restores opener focus', () => {
    const ast = ts.createSourceFile('provider.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
    const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    const handlers = {}
    let closeCode = ''
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'close') closeCode = 'const close = ' + node.initializer.getText(ast)
      if (ts.isJsxOpeningElement(node) && ['Dialog.Root', 'Dialog.Content'].includes(node.tagName.getText(ast))) {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.name.getText(ast).startsWith('on')
            && attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
            handlers[attribute.name.getText(ast)] = attribute.initializer.expression.getText(ast)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(component)
    assert.ok(handlers.onEscapeKeyDown)
    for (const busy of [false, true]) {
      let closed = 0, restored = 0, prevented = 0
      const trigger = {focus: () => restored++}, returnFocusRef = {current: null}
      const deps = {creating: busy, savePendingRef: {current: busy}, returnFocusRef,
        document: {activeElement: trigger}, onClose: () => closed++}
      const callbacks = make(closeCode + '\nconst callbacks = {' +
        Object.entries(handlers).map(([key, value]) => key + ': ' + value).join(',') + '}', deps, 'callbacks')
      callbacks.onOpenAutoFocus()
      assert.equal(returnFocusRef.current, trigger)
      callbacks.onOpenChange(true)
      assert.equal(closed, 0)
      callbacks.onOpenChange(false)
      assert.equal(closed, busy ? 0 : 1)
      callbacks.onEscapeKeyDown({preventDefault: () => prevented++})
      callbacks.onPointerDownOutside({preventDefault: () => prevented++})
      assert.equal(prevented, busy ? 2 : 0)
      callbacks.onCloseAutoFocus({preventDefault: () => prevented++})
      assert.equal(restored, 1)
    }
  })
}

test('Escape closes only an open searchable dropdown and removes its capture listener', () => {
  const ast = ts.createSourceFile('cards.tsx', cards, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'SearchableSelect')
  let effectCode
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes("window.addEventListener('keydown'")) effectCode = node.arguments[0].getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(component)
  assert.ok(effectCode)
  for (const open of [false, true]) {
    const inside = {}, states = [], listeners = new Set()
    let inputFocus = 0, restored = 0, prevented = 0, stopped = 0
    const deps = {open, inputRef: {current: {focus: () => inputFocus++}},
      containerRef: {current: {contains: target => target === inside}},
      triggerRef: {current: {focus: () => restored++}}, setOpen: value => states.push(value),
      window: {
        addEventListener: (type, handler, capture) => { assert.equal(type, 'keydown'); assert.equal(capture, true); listeners.add(handler) },
        removeEventListener: (type, handler, capture) => { assert.equal(type, 'keydown'); assert.equal(capture, true); listeners.delete(handler) },
      }}
    const run = make('const effect = ' + effectCode, deps, 'effect')
    const cleanup = run()
    assert.equal(inputFocus, Number(open))
    assert.equal(listeners.size, Number(open))
    if (!open) { assert.equal(cleanup, undefined); continue }
    const event = (key, target) => ({key, target, preventDefault: () => prevented++, stopPropagation: () => stopped++})
    const handler = [...listeners][0]
    handler(event('Enter', inside))
    handler(event('Escape', {}))
    assert.deepEqual(states, [])
    handler(event('Escape', inside))
    assert.deepEqual(states, [false])
    assert.equal(prevented, 1)
    assert.equal(stopped, 1)
    assert.equal(restored, 1)
    cleanup()
    assert.equal(listeners.size, 0)
  }
})


test('provider selectors open, step, wrap and commit keyboard choices without losing zero IDs', () => {
  const ast = ts.createSourceFile('ProviderCards.tsx', cards, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'SearchableSelect')
  const declarations = {}
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['chooseOption', 'handleKeyDown'].includes(node.name.getText(ast))) declarations[node.name.getText(ast)] = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(component)
  assert.ok(declarations.handleKeyDown)
  const code = 'const ' + declarations.chooseOption + ';\nconst ' + declarations.handleKeyDown
  const options = [{value: '0', label: 'Zero'}, {value: '16', label: 'Selected'}, {value: '33', label: 'Other'}]
  const state = {open: false, search: 'old', activeIndex: 0, value: '16', focused: 0, changes: 0}
  const key = (name, filtered = options) => {
    const deps = {open: state.open, value: state.value, activeIndex: state.activeIndex, filtered, options,
      setOpen: value => { state.open = value }, setSearch: value => { state.search = value },
      setActiveIndex: value => { state.activeIndex = typeof value === 'function' ? value(state.activeIndex) : value },
      onChange: value => { state.value = value; state.changes++ }, triggerRef: {current: {focus: () => state.focused++}}}
    const run = make(code, deps, 'handleKeyDown')
    let prevented = 0
    run({key: name, preventDefault: () => prevented++})
    return prevented
  }
  assert.equal(key('ArrowDown'), 1)
  assert.equal(state.open, true)
  assert.equal(state.activeIndex, 1)
  assert.equal(state.search, '')
  assert.equal(state.changes, 0)
  key('ArrowDown');assert.equal(state.activeIndex, 2)
  key('ArrowDown');assert.equal(state.activeIndex, 0)
  key('ArrowUp');assert.equal(state.activeIndex, 2)
  key('Enter');assert.equal(state.value, '33');assert.equal(state.open, false)
  state.open = true;state.activeIndex = 0
  key('Enter');assert.equal(state.value, '0');assert.equal(state.focused, 2)
  state.open = true
  const changes = state.changes
  key('Enter', []);assert.equal(state.open, true);assert.equal(state.changes, changes)
  key('ArrowDown', []);assert.equal(state.activeIndex, 0)
})

test('provider selector blur closes only when focus leaves the control', () => {
  const ast = ts.createSourceFile('ProviderCards.tsx', cards, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'SearchableSelect')
  let callback
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onBlur') callback = node.initializer.expression.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(component)
  assert.ok(callback)
  const closed = [], deferred = []
  const blur = make('const blur = ' + callback, {setOpen: value => closed.push(value), window: {setTimeout: callback => deferred.push(callback)}}, 'blur')
  const inside = {}, target = {contains: value => value === inside}
  blur({currentTarget: target, relatedTarget: inside})
  assert.deepEqual(closed, [])
  blur({currentTarget: target, relatedTarget: {}})
  assert.deepEqual(closed, [])
  assert.equal(deferred.length, 1)
  deferred[0]()
  assert.deepEqual(closed, [false])
})

test('provider dialog preserves unlisted settings and reports rejected saves', async () => {
  const state = {saving: false, saved: false, error: ''}
  let sent
  const save = make(extract(cards, '  const handleSave = ', '  const handleTest = '), {
    fields: [{key: 'api_key', category: 'auth'}, {key: 'legacy_key', secret: true}], form: {api_key: 'fixture-new', legacy_key: 'fixture-new-legacy'},
    setting: {id: 7, enabled: true, auth: {retained: 'fixture-hidden', legacy_key: 'fixture-old-legacy'}, config: {hidden: 'keep'},
      metadata: {owner: 'fixture-owner'}}, providerType: 'sms', provider: {value: 'fixture'},
    mountedRef: {current: true}, savePendingRef: {current: false}, testPendingRef: {current: false},
    setSaving: setter(state, 'saving'), setSaved: setter(state, 'saved'), setSaveError: setter(state, 'error'),
    apiFetch: async (_path, options) => { sent = JSON.parse(options.body); throw new Error('Fixture dialog rejected') },
    invalidateConfigOptionsCache() {}, onSaved: async () => {}, onClose() {}, setTimeout() {}, console: {error() {}},
  }, 'handleSave')
  await save()
  assert.equal(sent.config.hidden, 'keep')
  assert.equal(sent.auth.retained, 'fixture-hidden')
  assert.equal(({...sent.config, ...sent.auth}).legacy_key, 'fixture-new-legacy')
  assert.deepEqual(sent.metadata, {owner: 'fixture-owner'})
  assert.match(state.error, /Fixture dialog rejected/)
})

test('old cached configuration requests cannot replace a newer forced response', async () => {
  const code = ts.transpileModule(read('../src/lib/app-data.ts'), {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  }}).outputText
  const pending = []
  const exports = {}
  new Function('exports', 'require', code)(exports, () => ({
    apiFetch: () => new Promise(resolve => pending.push(resolve)),
  }))
  const old = exports.getConfig()
  exports.invalidateConfigCache()
  const fresh = exports.getConfig({force: true})
  pending[1]({default_executor: 'headed'})
  await fresh
  pending[0]({default_executor: 'protocol'})
  await old
  assert.deepEqual(await exports.getConfig(), {default_executor: 'headed'})
})



test('a double click creates one provider definition and its first setting', async () => {
  const calls = []
  let release
  const create = make(extract(settings, '  const createProviderDefinitionAndSetting = ', '  const dialogItem = '), {
    providerDefinitionPendingRef: {current: false},
    providerDefinitionForm: {sms: {provider_key: 'fixture-custom', label: 'Fixture custom', driver_type: 'fixture'}},
    providerDrivers: {sms: [{driver_type: 'fixture'}]}, providerSettings: {sms: []},
    setProviderError() {}, setProviderDefinitionCreating() {}, setProviderNotice() {},
    setProviderCreateDialog() {}, setProviderDefinitionForm() {},
    invalidateConfigOptionsCache() {}, loadConfigData: async () => {},
    getErrorMessage: error => error.message,
    apiFetch: path => {
      calls.push(path)
      return path === '/provider-definitions' ? new Promise(resolve => { release = resolve }) : Promise.resolve({ok: true})
    },
  }, 'createProviderDefinitionAndSetting')
  const first = create('sms')
  const second = create('sms')
  assert.deepEqual(calls, ['/provider-definitions'])
  release({ok: true})
  await Promise.all([first, second])
  assert.deepEqual(calls, ['/provider-definitions', '/provider-settings'])
})

test('a pending solver status read prevents restart dispatch until its result settles', async () => {
  const state = {status: {running: false}, error: '', checking: false, restarting: false}
  const calls = []
  let release
  const functions = make(extract(advanced, '  const checkSolver = ', '\n  useEffect'), {
    useCallback: fn => fn, mountedRef: {current: true}, checkPendingRef: {current: false},
    restartPendingRef: {current: false}, status: state.status,
    setStatus: setter(state, 'status'), setError: setter(state, 'error'),
    setChecking: setter(state, 'checking'), setRestarting: setter(state, 'restarting'),
    apiFetch: (path, options) => {
      calls.push(options?.method || 'GET')
      if (calls.length === 1) return new Promise(resolve => { release = resolve })
      return Promise.resolve({ok: true, running: false, restarting: true})
    },
  }, '{checkSolver, restartSolver}')
  const check = functions.checkSolver()
  await functions.restartSolver()
  assert.deepEqual(calls, ['GET'])
  release({running: false, restarting: false})
  await check
  await functions.restartSolver()
  assert.deepEqual(calls, ['GET', 'POST', 'GET'])
  assert.equal(state.status.restarting, true)
  assert.equal(state.restarting, false)
})

test('capability save and reset cannot overlap for the same platform', async () => {
  const state = {saving: {}, saved: {}, errors: {}, drafts: {fixture: {supported_executors: ['headless']}}}
  const calls = []
  let release
  const handlers = make(extract(advanced, '  const save = async (name:', '\n  return ('), {
    mountedRef: {current: true}, pendingKeysRef: {current: new Set()}, drafts: state.drafts,
    setSaving: setter(state, 'saving'), setSaved: setter(state, 'saved'),
    setErrors: setter(state, 'errors'), setDrafts: setter(state, 'drafts'),
    invalidatePlatformsCache() {}, getPlatforms: async () => [], setTimeout() {},
    apiFetch: (_path, options) => {
      calls.push(options.method)
      return new Promise(resolve => { release = resolve })
    },
  }, '{save, reset}')
  const first = handlers.save('fixture')
  const second = handlers.reset('fixture')
  assert.deepEqual(calls, ['PUT'])
  release({ok: true})
  await Promise.all([first, second])
})
