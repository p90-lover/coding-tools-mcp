import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/pages/Register.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const taskSource = readFileSync(new URL('../src/lib/tasks.ts', import.meta.url), 'utf8')
const taskJs = ts.transpileModule(taskSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const terminal = new Function('exports', taskJs + '\nreturn exports')({}).isTerminalTaskStatus
const registrationSource = readFileSync(new URL('../src/lib/registration.ts', import.meta.url), 'utf8')
const registrationJs = ts.transpileModule(registrationSource,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const registration = new Function('exports', registrationJs + '\nreturn exports')({})


test('account registration opens the shared register page for the selected platform', () => {
  const accounts = readFileSync(new URL('../src/pages/Accounts.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('Accounts.tsx', accounts, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  let handler
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Button'
      && node.children.some(child => ts.isJsxText(child) && child.text.trim() === '自动注册')) {
      handler = node.openingElement.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'onClick')
        ?.initializer.expression.getText(ast)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(handler)
  for (const tab of ['chatgpt', 'grok', 'fixture & platform']) {
    const visited = []
    const deps = {tab, navigate: url => visited.push(url), beginAccountAction() {}, setShowRegister() {}}
    const js = ts.transpileModule('const click = ' + handler, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText
    new Function(...Object.keys(deps), js + '\nreturn click')(...Object.values(deps))()
    assert.deepEqual(visited, ['/register?platform=' + encodeURIComponent(tab)])
  }
})

test('registration entry preserves an explicit platform while restoring the actual active task', async () => {
  const ast = ts.createSourceFile('Register.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'Register')
  const variables = {}
  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      const name = ts.isArrayBindingPattern(node.name) ? node.name.elements[0].name.getText(ast) : node.name.getText(ast)
      variables[name] = node
    }
    ts.forEachChild(node, visit)
  }
  visit(component)
  assert.ok(variables.requestedPlatform)
  for (const requestedPlatform of ['', 'grok']) {
    const initial = variables.form.initializer.arguments[0].getText(ast)
    const edited = variables.editedFieldsRef.initializer.arguments[0].getText(ast)
    const compile = code => ts.transpileModule(code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText
    const formValue = new Function('DEFAULT_FORM', 'requestedPlatform',
      compile('const value = ' + initial) + '\nreturn typeof value === "function" ? value() : value')({platform: '', count: 1}, requestedPlatform)
    const editedFields = new Function('requestedPlatform', compile('const value = ' + edited) + '\nreturn value')(requestedPlatform)
    assert.equal(formValue.platform, requestedPlatform)
    const {state} = await restore('active-fixture', async () => ({
      id: 'active-fixture', task_id: 'active-fixture', platform: 'chatgpt', status: 'running',
      result: {registration_config: {count: 50, concurrency: 5}},
    }), [...editedFields], formValue.platform)
    assert.equal(state.task.task_id, 'active-fixture')
    assert.equal(state.polling, true)
    assert.equal(state.form.platform, requestedPlatform || 'chatgpt')
    assert.equal(state.form.concurrency, 5)
  }
})

test('fresh registration prefers GPT or a remembered supported platform over empty Anything', () => {
  const platforms = [
    { name: 'anything', supported_identity_modes: [], supported_executors: [] },
    { name: 'chatgpt', supported_identity_modes: ['mailbox', 'oauth_browser'], supported_oauth_providers: ['google'], supported_executors: ['protocol', 'headless', 'headed'] },
    { name: 'grok', supported_identity_modes: ['mailbox'], supported_executors: ['protocol'] },
  ]
  assert.equal(registration.pickRegistrationPlatform(platforms), 'chatgpt')
  assert.equal(registration.pickRegistrationPlatform(platforms, 'grok'), 'grok')
  assert.equal(registration.pickRegistrationPlatform(platforms, 'anything'), 'chatgpt')
  assert.equal(registration.pickRegistrationPlatform(platforms, 'removed'), 'chatgpt')
  assert.equal(registration.pickRegistrationPlatform(platforms.slice(2)), 'grok')
  assert.equal(registration.pickRegistrationPlatform(platforms.slice(0, 1)), 'anything')
  assert.deepEqual(registration.buildRegistrationOptions(platforms[0]), [])
  const identities = registration.buildRegistrationOptions(platforms[1])
  assert.deepEqual(identities.map(option => option.identityProvider), ['mailbox', 'oauth_browser'])
  assert.deepEqual(registration.buildExecutorOptions(identities[0].identityProvider, platforms[1].supported_executors, false)
    .filter(option => !option.disabled).map(option => option.value), ['protocol', 'headless', 'headed'])
})


test('restoration failure keeps Start unavailable until a successful reload', async () => {
  const { state } = await restore(null, async () => { throw new Error('Fixture task lookup failed') })
  assert.match(state.error, /Fixture task lookup failed/)
  const expression = source.match(/<Button onClick=\{submit\} disabled=\{([^}]+)\}/)[1]
  const dependencies = {
    restoring: state.restoring, polling: state.polling, submitting: false, registrationHeld: false,
    form: { platform: 'chatgpt' }, registrationReady: true, optionsLoading: false, optionsError: '',
    restoreError: state.restoreError,
  }
  assert.equal(Boolean(new Function(...Object.keys(dependencies), 'return ' + expression)(...Object.values(dependencies))), true)
})

async function hydrate({ fail = false, unmount = false } = {}) {
  const state = {
    form: { platform: 'chatgpt', proxy: '', mail_provider: 'chosen-mail', sms_provider: 'chosen-sms' },
    loading: false, error: '', platforms: [],
  }
  let release
  const data = new Promise(resolve => { release = resolve })
  const effect = makeEffect('const nextForm: Record<string, any> = {', {
    loadAttempt: 0, editedFieldsRef: { current: new Set(['proxy']) },
    getConfig: () => fail ? Promise.reject(new Error('Fixture config unavailable')) : data,
    getPlatforms: async () => [{ name: 'chatgpt' }],
    getConfigOptions: async () => ({
      mailbox_settings: [{ provider_key: 'default-mail', is_default: true }],
      sms_settings: [{ provider_key: 'default-sms', is_default: true }],
    }),
    apiFetch: async () => [{ url: 'http://fixture-proxy.invalid', is_active: true }],
    getDefaultProviderKey: items => items.find(item => item.is_default)?.provider_key || '',
    listProviderFieldKeys: () => [],
    setPlatforms: value => { state.platforms = value },
    setConfigOptions() {},
    setOptionsError: value => { state.error = value },
    setOptionsLoading: value => { state.loading = value },
    setForm: update => { state.form = update(state.form) },
  })
  const cleanup = effect()
  if (unmount) cleanup?.()
  release({})
  await new Promise(resolve => setImmediate(resolve))
  return state
}

test('failed registration configuration is visible instead of silently dropping saved defaults', async () => {
  const state = await hydrate({ fail: true })
  assert.match(state.error, /Fixture config unavailable/)
  assert.deepEqual(state.platforms, [])
})

test('configuration hydration preserves a cleared proxy and chosen providers', async () => {
  const state = await hydrate()
  assert.equal(state.form.proxy, '')
  assert.equal(state.form.mail_provider, 'chosen-mail')
  assert.equal(state.form.sms_provider, 'chosen-sms')
})

test('unmounted registration does not apply a late configuration reply', async () => {
  const state = await hydrate({ unmount: true })
  assert.deepEqual(state.platforms, [])
})

function makeEffect(marker, dependencies) {
  dependencies = { loadAttempt: 0, setRestoreError() {}, editedFieldsRef: { current: new Set() }, activeTaskIdRef: { current: dependencies.task?.task_id || '' }, ...dependencies }
  const markerIndex = source.indexOf(marker)
  assert.ok(markerIndex >= 0, `Register must include ${marker}`)
  const start = source.lastIndexOf('  useEffect(() => {', markerIndex)
  const end = source.indexOf('\n  }, [', markerIndex)
  const effect = source.slice(start, source.indexOf('\n', end + 1))
  const js = ts.transpileModule(effect, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  let callback
  new Function('useEffect', ...Object.keys(dependencies), js)(fn => { callback = fn }, ...Object.values(dependencies))
  return callback
}

async function restore(savedId, fetch, editedFields = [], platform = 'anything') {
  const state = { task: null, polling: false, restoring: true, error: '', restoreError: '', form: { platform, count: 2 } }
  const storage = new Map(savedId ? [['register-task-id', savedId]] : [])
  const effect = makeEffect('const restoreTask = async () => {', {
    apiFetch: fetch, isTerminalTaskStatus: terminal, editedFieldsRef: { current: new Set(editedFields) },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTask: value => { state.task = value }, setPolling: value => { state.polling = value },
    setForm: update => { state.form = update(state.form) },
    setRestoring: value => { state.restoring = value }, setSubmitError: value => { state.error = value },
    setRestoreError: value => { state.error = value; state.restoreError = value },
  })
  const cleanup = effect()
  await new Promise(resolve => setImmediate(resolve))
  return { state, storage, cleanup }
}

test('restoration retries preserve edited batch settings and platform', async () => {
  const { state } = await restore('old-task', async path => path === '/tasks/old-task'
    ? { id: 'old-task', platform: 'chatgpt', status: 'succeeded',
        result: { registration_config: { count: 1, executor_type: 'headed' } } }
    : { total: 0, items: [] }, ['count', 'platform'])
  assert.equal(state.form.count, 2)
  assert.equal(state.form.platform, 'anything')
  assert.equal(state.form.executor_type, 'headed')
})

test('platform hydration waits for restoration, then fills declared identity and execution choices', () => {
  const platforms = [
    { name: 'anything', supported_identity_modes: [], supported_executors: [] },
    { name: 'chatgpt', supported_identity_modes: ['mailbox'], supported_executors: ['protocol', 'headless', 'headed'] },
  ]
  const form = { platform: '', identity_provider: '', oauth_provider: '', executor_type: '', chrome_user_data_dir: '', chrome_cdp_url: '' }
  const set = (key, value) => { form[key] = value }
  const dependencies = {
    form, platforms, set, pickRegistrationPlatform: registration.pickRegistrationPlatform,
    localStorage: { getItem: () => 'anything', setItem() {} },
  }
  makeEffect('const fallback = pickRegistrationPlatform', { ...dependencies, restoring: true })()
  assert.equal(form.platform, '')
  makeEffect('const fallback = pickRegistrationPlatform', { ...dependencies, restoring: false })()
  assert.equal(form.platform, 'chatgpt')
  const meta = platforms.find(platform => platform.name === form.platform)
  const registrationOptions = registration.buildRegistrationOptions(meta)
  makeEffect('if (registrationOptions.length === 0)', { form, set, registrationOptions })()
  assert.equal(form.identity_provider, 'mailbox')
  assert.equal(form.oauth_provider, '')
  const supportedExecutors = meta.supported_executors
  const executorOptions = registration.buildExecutorOptions(form.identity_provider, supportedExecutors, false)
  makeEffect('const validExecutors = executorOptions.filter', {
    form, set, executorOptions, supportedExecutors,
    pickOAuthExecutor: registration.pickOAuthExecutor,
    hasReusableOAuthBrowser: registration.hasReusableOAuthBrowser,
  })()
  assert.equal(form.executor_type, 'protocol')
})

test('active task summary uses saved headed identity and does not borrow current form defaults', () => {
  const start = source.indexOf('  const activeRegistration = ')
  assert.ok(start >= 0, 'summary must distinguish active task configuration')
  const end = source.indexOf('  const activeTaskStats', start)
  const summaryJs = ts.transpileModule(source.slice(start, end),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const summarize = new Function('task', 'form', 'platforms', 'configOptions', 'isTerminalTaskStatus',
    'buildRegistrationOptions', 'getCaptchaStrategyLabel',
    summaryJs + '\nreturn { summaryRegistration, summaryExecutor, summaryVerification, summaryPlatform }')
  const platforms = [{
    name: 'chatgpt', display_name: 'ChatGPT',
    supported_identity_modes: ['mailbox', 'oauth_browser'], supported_oauth_providers: ['google'],
    supported_identity_mode_options: [{ value: 'mailbox', label: '系统邮箱' }],
    supported_oauth_provider_options: [{ value: 'google', label: 'Google' }],
    supported_executor_options: [{ value: 'headless', label: '后台浏览器自动' }, { value: 'headed', label: '可视浏览器自动' }],
  }]
  const form = { platform: 'anything', executor_type: 'headless', identity_provider: 'mailbox', oauth_provider: '' }
  const run = task => summarize(task, form, platforms, {}, terminal,
    registration.buildRegistrationOptions, executor => 'verification:' + executor)
  const result = run({ status: 'running', platform: 'chatgpt', result: { registration_config: {
    executor_type: 'headed', identity_provider: 'oauth_browser', oauth_provider: 'google', count: 2,
  } } })
  assert.equal(result.summaryExecutor, '可视浏览器自动')
  assert.equal(result.summaryRegistration, 'Google')
  assert.equal(result.summaryVerification, 'verification:headed')
  assert.equal(result.summaryPlatform.display_name, 'ChatGPT')
  const unknown = run({ status: 'running', platform: 'chatgpt', result: {} })
  assert.equal(unknown.summaryExecutor, '未知')
  assert.equal(unknown.summaryRegistration, '未知')
  assert.equal(unknown.summaryVerification, '未知')
  const idle = summarize(null, { ...form, platform: 'chatgpt' }, platforms, {}, terminal,
    registration.buildRegistrationOptions, executor => 'verification:' + executor)
  assert.equal(idle.summaryExecutor, '后台浏览器自动')
  assert.equal(idle.summaryRegistration, '系统邮箱')
})

test('navigation exposes the existing registration route', () => {
  const items = app.slice(app.indexOf('const NAV_ITEMS'), app.indexOf('function Sidebar'))
  assert.match(items, /path: '\/register'/)
  assert.match(app, /Route path="\/tasks" element={<TaskHistory \/>}/)
})

test('reopening registration restores its persisted task and busy state', async () => {
  const task = { id: 'existing-task', task_id: 'existing-task', type: 'register', status: 'running' }
  const { state } = await restore(task.id, async path => {
    assert.equal(path, '/tasks/existing-task')
    return task
  })
  assert.equal(state.task, task)
  assert.equal(state.polling, true)
  assert.equal(state.restoring, false)
})

test('restored task platform survives the initial empty platform metadata', async () => {
  const { state } = await restore('chatgpt-task', async () => ({
    id: 'chatgpt-task', task_id: 'chatgpt-task', platform: 'chatgpt', status: 'running',
  }))
  assert.equal(state.form.platform, 'chatgpt')
  assert.equal(state.form.count, 2)
  const select = (key, value) => { state.form[key] = value }
  const dependencies = {
    form: state.form, set: select, restoring: false,
    pickRegistrationPlatform: registration.pickRegistrationPlatform,
    localStorage: { getItem: () => null, setItem() {} },
  }
  makeEffect("const fallback = pickRegistrationPlatform", { ...dependencies, platforms: [] })()
  assert.equal(state.form.platform, 'chatgpt')
  makeEffect("const fallback = pickRegistrationPlatform", {
    ...dependencies, platforms: [{ name: 'anything' }, { name: 'chatgpt' }],
  })()
  assert.equal(state.form.platform, 'chatgpt')
})

test('a restored terminal task keeps its results and allows another registration', async () => {
  for (const status of ['succeeded', 'failed', 'interrupted', 'cancelled']) {
    const { state } = await restore('finished-task', async () => ({ id: 'finished-task', status }))
    assert.equal(state.task.status, status)
    assert.equal(state.polling, false)
    assert.equal(state.restoring, false)
  }
})

test('reopening paused registration restores the saved configuration without a busy spinner', async () => {
  const config = { executor_type: 'headed', identity_provider: 'mailbox', count: 3 }
  const task = { id: 'held-registration', platform: 'chatgpt', type: 'register', status: 'paused',
    result: { registration_config: config, verification_hold: { active: true, account_id: 42 } } }
  const { state } = await restore(null, async path => {
    const status = new URLSearchParams(path.split('?')[1]).get('status')
    return { total: status?.split(',').includes('paused') ? 1 : 0, items: status?.split(',').includes('paused') ? [task] : [] }
  })
  assert.equal(state.task, task)
  assert.equal(state.polling, false)
  assert.equal(state.form.executor_type, 'headed')
  assert.equal(state.form.count, 3)
  assert.equal(state.restoring, false)
})

test('first visit restores registration with one filtered lookup instead of scanning unrelated jobs', async () => {
  const calls = []
  const task = { id: 'active-register', type: 'register', status: 'pending' }
  const { state, storage } = await restore(null, async path => {
    calls.push(path)
    const params = new URLSearchParams(path.split('?')[1])
    assert.equal(params.get('task_type'), 'register')
    assert.equal(params.get('status'), 'pending,claimed,running,cancel_requested,paused')
    assert.equal(params.get('page_size'), '1')
    return { total: 2, items: [task] }
  })
  assert.equal(state.task, task)
  assert.equal(state.polling, true)
  assert.equal(storage.get('register-task-id'), task.id)
  assert.equal(calls.length, 1)
})

test('a finished saved task does not hide a newer active registration', async () => {
  const active = { id: 'new-running-task', task_id: 'new-running-task', type: 'register', status: 'running' }
  const { state } = await restore('finished-task', async path => {
    if (path === '/tasks/finished-task') return { id: 'finished-task', status: 'cancelled' }
    const status = new URLSearchParams(path.split('?')[1]).get('status')
    return { total: status?.split(',').includes('running') ? 1 : 0, items: status?.split(',').includes('running') ? [active] : [] }
  })
  assert.equal(state.task, active)
  assert.equal(state.polling, true)
})

test('a missing saved task clears its stale identity and releases Start', async () => {
  const { state, storage } = await restore('deleted-task', async path => {
    if (path === '/tasks/deleted-task') throw new Error('{"detail":"任务不存在"}')
    return { total: 0, items: [] }
  })
  assert.equal(state.task, null)
  assert.equal(state.polling, false)
  assert.equal(state.restoring, false)
  assert.equal(storage.has('register-task-id'), false)
})

test('unmount ignores late restoration results', async () => {
  let release
  const state = { task: null, restoring: true }
  const effect = makeEffect('const restoreTask = async () => {', {
    apiFetch: () => new Promise(resolve => { release = resolve }), isTerminalTaskStatus: terminal,
    sessionStorage: { getItem: () => 'old-task', setItem: () => assert.fail('unmounted effect wrote storage'), removeItem: () => {} },
    setTask: value => { state.task = value }, setPolling: () => assert.fail('unmounted effect changed polling'),
    setRestoring: value => { state.restoring = value }, setSubmitError: () => assert.fail('unmounted effect showed an error'),
  })
  const cleanup = effect()
  cleanup()
  release({ id: 'old-task', status: 'running' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.task, null)
  assert.equal(state.restoring, true)
})

test('polling a deleted task stops its busy state instead of swallowing the error', async () => {
  let poll, task = { id: 'deleted-task', task_id: 'deleted-task', status: 'running' }, busy = true, cleared = false
  const effect = makeEffect('const interval = window.setInterval', {
    task, apiFetch: async () => { throw new Error('{"detail":"任务不存在"}') }, isTerminalTaskStatus: terminal,
    document: { visibilityState: 'visible' },
    window: { setInterval: callback => { poll = callback; return 1 }, clearInterval: () => { cleared = true } },
    sessionStorage: { removeItem: () => {} },
    setTask: value => { task = value }, setPolling: value => { busy = value }, setSubmitError: () => {},
    applyTerminalTask: () => assert.fail('missing task is not a completed result'),
  })
  effect()
  await poll()
  assert.equal(task, null)
  assert.equal(busy, false)
  assert.equal(cleared, true)
})

test('registration guard blocks ChatGPT during an active or unknown hold and permits other platforms', async () => {
  const handler = source.slice(source.indexOf('  const submit = async () => {'), source.indexOf('  const handleTaskDone = '))
  const compiled = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  for (const fixture of [
    { platform: 'chatgpt', hold: { active: true, account_id: 42 }, allowed: false },
    { platform: 'chatgpt', hold: { active: true, account_id: 46, account_exists: false }, allowed: false },
    { platform: 'chatgpt', loading: true, allowed: false },
    { platform: 'chatgpt', error: 'Unavailable', allowed: false },
    { platform: 'grok', hold: { active: true, account_id: 42 }, allowed: true },
    { platform: 'chatgpt', allowed: true },
  ]) {
    const calls = []
    const dependencies = {
      form: { platform: fixture.platform, identity_provider: 'oauth_browser', count: 1 },
      activeTaskIdRef: { current: '' }, submitPendingRef: { current: false }, verificationHold: fixture.hold || null,
      verificationHoldLoading: fixture.loading || false, verificationHoldError: fixture.error || '',
      allProviderFieldKeys: [], optionsLoading: false, optionsError: '', restoreError: '', setSubmitError() {}, setSubmitting() {}, setTask() {}, setPolling() {},
      sessionStorage: { setItem() {} }, isTerminalTaskStatus: terminal,
      apiFetch: async (path, options) => { calls.push({ path, options }); return { task_id: 'registration-fixture' } },
    }
    const submit = new Function(...Object.keys(dependencies), compiled + '\nreturn submit')(...Object.values(dependencies))
    await submit()
    assert.equal(calls.length, fixture.allowed ? 1 : 0)
    if (fixture.allowed) assert.equal(calls[0].path, '/tasks/register')
  }
})

test('late completion of the previous registration cannot replace a newer task', async () => {
  const start = source.indexOf('  const handleTaskDone = ')
  const end = source.indexOf('\n  useEffect', start)
  const compiled = ts.transpileModule(source.slice(start, end),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  for (const reject of [false, true]) {
    let release, fail, applied = false, polling = true
    const activeTaskIdRef = { current: 'old-task' }
    const dependencies = {
      useCallback: callback => callback, task: { task_id: 'old-task' }, activeTaskIdRef,
      handledTerminalTaskIdsRef: { current: new Set() },
      apiFetch: () => new Promise((resolve, reject) => { release = resolve; fail = reject }),
      applyTerminalTask: () => { applied = true },
      setPolling: value => { polling = value },
      setTask: () => assert.fail('stale completion changed the task'),
      sessionStorage: { removeItem: () => assert.fail('stale completion removed the current task') },
      setSubmitError: () => assert.fail('stale completion changed the error'),
    }
    const done = new Function(...Object.keys(dependencies), compiled + '\nreturn handleTaskDone')(...Object.values(dependencies))
    const pending = done('succeeded')
    activeTaskIdRef.current = 'new-task'
    if (reject) fail(new Error('任务不存在'))
    else release({ task_id: 'old-task', status: 'succeeded' })
    await pending
    assert.equal(applied, false)
    assert.equal(polling, true)
  }
})
