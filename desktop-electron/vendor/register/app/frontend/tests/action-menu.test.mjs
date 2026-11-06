import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
const source = readFileSync(new URL('../src/pages/Accounts.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

test('action select drafts match the first visible option', () => {
  const ast = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildActionParamDraft')
  assert.ok(declaration)
  const build = new Function(compile(declaration.getText(ast)) + '\nreturn buildActionParamDraft')()
  assert.deepEqual(build({id:'generate_link',params:[
    {key:'country',options:['US','SG']},{key:'plan',options:['plus','team']},{key:'note',type:'textarea'},
  ]},{email:'fixture@example.invalid'}),{country:'US',plan:'plus',note:''})
})


const parsed = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

test('keyboard menu focus waits for metadata and preserves another focused control', () => {
  let effect
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'useEffect' &&
        node.arguments[0]?.getText(parsed).includes('keyboardMenuOpenRef.current')) effect = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(effect)
  const code = compile('(' + effect.getText(parsed) + ')()')
  for (const fixture of [
    { open: false, loading: false, keyboard: true, active: 'menu', expected: 0 },
    { open: true, loading: true, keyboard: true, active: 'menu', expected: 0 },
    { open: true, loading: false, keyboard: false, active: 'menu', expected: 0 },
    { open: true, loading: false, keyboard: true, active: 'menu', expected: 1 },
    { open: true, loading: false, keyboard: true, active: 'trigger', expected: 1 },
    { open: true, loading: false, keyboard: true, active: 'body', expected: 1 },
    { open: true, loading: false, keyboard: true, active: 'other', expected: 0 },
  ]) {
    let focused = 0
    const item = { focus() { focused++ } }
    const menu = { querySelector: () => item }, trigger = {}, body = {}, other = {}
    const deps = {
      open: fixture.open, actionsLoading: fixture.loading,
      keyboardMenuOpenRef: { current: fixture.keyboard },
      menuRef: { current: menu }, triggerRef: { current: trigger },
      document: { activeElement: { menu, trigger, body, other }[fixture.active], body },
    }
    new Function(...Object.keys(deps), code)(...Object.values(deps))
    assert.equal(focused, fixture.expected, JSON.stringify(fixture))
  }
})

function variable(name) {
  let declaration
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) declaration = node
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(declaration, `Missing ${name}`)
  return 'const ' + declaration.getText(parsed) + ';\n'
}
function pageActions(apiFetch, { delayedCopy = false } = {}) {
  const copy = deferred()
  const state = { pending: { operation: 0 }, result: null, results: [], toast: null, toasts: [], tasks: [], changes: 0, copied: [] }
  const focus = { current: 0 }
  const update = (key, value) => { state[key] = typeof value === 'function' ? value(state[key]) : value }
  const deps = {
    useCallback: fn => fn, mountedRef: { current: true }, currentQueryRef: { current: { platform: 'grok' } },
    accountActionFocusRef: focus, finishedAccountTasksRef: { current: new Set() },
    accountOptionsSubmitRef: { current: null }, pendingAccountAction: state.pending,
    setAccountActionFocus() {}, setPendingAccountAction: value => update('pending', value),
    setActionResult: value => { state.result = value?.payload ?? null; if (value) state.results.push(value) },
    setAccountActionNotice: value => { state.toast = value; if (value) state.toasts.push(value) },
    setAccountActionTasks: value => update('tasks', value),
    load: () => { state.changes++ }, refreshVerificationHold() {},
    apiFetch, getTaskStatusText: value => value,
    window: { open() {} }, navigator: { clipboard: { writeText: text => {
      state.copied.push(text)
      return delayedCopy ? copy.promise : Promise.resolve()
    } } },
  }
  const names = ['beginAccountAction', 'isAccountActionCurrent', 'handleAccountActionError',
    'presentAccountActionResult', 'handleSyncAccountAction', 'registerAccountActionTask', 'handleActionDone',
    'openAccountActionOptions', 'submitAccountActionOptions']
  const code = compile(names.map(variable).join('\n'))
  const render = () => {
    const values = { ...deps, pendingAccountAction: state.pending }
    return new Function(...Object.keys(values), code + '\nreturn {' + names.join(',') + '}')(...Object.values(values))
  }
  const handlers = render()
  return { state, focus, copy, ...handlers,
    submitOptions: params => render().submitAccountActionOptions(params) }
}
function rowActions(controller, apiFetch, accountId = 1) {
  const state = { running: null }
  const generation = { current: 0 }
  const deps = {
    acc: { id: accountId, platform: 'grok', email: `fixture-${accountId}@example.invalid` },
    verificationHold: null, verificationHoldLoading: false, verificationHoldError: '',
    recoveryParams: {}, recoveryHold: null, actionPendingRef: { current: false }, actionGenerationRef: generation,
    setRunning: value => { state.running = value },
    onActionStart: controller.beginAccountAction,
    onTask: controller.registerAccountActionTask,
    onError: (operation, error) => controller.handleAccountActionError(operation, 'grok', error),
    onResult: (title, data, operation) => controller.handleSyncAccountAction(title, data, operation, 'grok'),
    apiFetch,
  }
  const run = new Function(...Object.keys(deps), compile(variable('runAction')) + '\nreturn runAction')(...Object.values(deps))
  return { run, state, generation }
}

function actionRequest(reply) {
  let calls = 0
  const fetcher = async () => { calls++; return reply() }
  const controller = pageActions(fetcher)
  const row = rowActions(controller, fetcher)
  const state = controller.state
  Object.defineProperties(state, {
    calls: { get: () => calls },
    running: { get: () => row.state.running },
    error: { get: () => state.pending?.error || '' },
    task: { get: () => state.tasks.find(task => task.operation === controller.focus.current) },
  })
  return { state, run: (action, params) => row.run(action, params, 0) }
}

test('failed parameter requests keep the form open with a useful error', async()=>{
  const ui=actionRequest(async()=>{throw Error('Fixture action unavailable')})
  await ui.run({id:'fixture',label:'Fixture'}, {country:'US'})
  assert.ok(ui.state.pending)
  assert.match(ui.state.error,/Fixture action unavailable/)
  assert.equal(ui.state.running,null)
})

test('a successful action closes its parameters only after acceptance',async()=>{
  let release
  const ui=actionRequest(()=>new Promise(resolve=>{release=resolve}))
  const request=ui.run({id:'fixture',label:'Fixture'}, {country:'US'})
  assert.ok(ui.state.pending)
  release({sync:true,ok:true,data:{fixture:true}})
  await request
  assert.equal(ui.state.pending,null)
  assert.deepEqual(ui.state.result,{fixture:true})
})

test('parameter action submission is single flight',async()=>{
  let release
  const ui=actionRequest(()=>new Promise(resolve=>{release=resolve}))
  const first=ui.run({id:'fixture',label:'Fixture'},{}), second=ui.run({id:'fixture',label:'Fixture'}, {})
  assert.equal(ui.state.calls,1)
  release({task_id:'fixture-task'})
  await Promise.all([first,second])
  assert.equal(ui.state.task.taskId,'fixture-task')
})

function metadataLoader(fetcher) {
  const start=source.indexOf('  const reloadPlatformActions = ')
  assert.ok(start>=0,'the account page must own its shared action metadata')
  const end=source.indexOf('\n\n  useEffect',start)
  const state={metadata:{platform:'',actions:[],loading:true,error:''}}
  const request={current:0}
  const deps={tab:'chatgpt',mountedRef:{current:true},actionMetadataRequestRef:request,useCallback:fn=>fn,
    setActionMetadata:update=>{state.metadata=typeof update==='function'?update(state.metadata):update},
    apiFetch:fetcher}
  return {state,request,load:new Function(...Object.keys(deps),compile(source.slice(start,end))+'\nreturn reloadPlatformActions')(...Object.values(deps))}
}

test('older action metadata cannot replace a newer response',async()=>{
  const pending=[]
  const ui=metadataLoader(()=>new Promise(resolve=>pending.push(resolve)))
  const old=ui.load(),fresh=ui.load()
  pending[1]({actions:[{id:'fresh'}]});await fresh
  pending[0]({actions:[{id:'old'}]});await old
  assert.equal(ui.state.metadata.actions[0].id,'fresh')
})

test('metadata failure is visible, malformed data is rejected, and retry recovers',async()=>{
  let mode='failed'
  const ui=metadataLoader(async()=>{
    if(mode==='failed')throw Error('Fixture metadata unavailable')
    return mode==='invalid'?{}:{actions:[{id:'fresh'}]}
  })
  await ui.load()
  assert.match(ui.state.metadata.error,/Fixture metadata unavailable/)
  assert.equal(ui.state.metadata.loading,false)
  mode='invalid';await ui.load()
  assert.ok(ui.state.metadata.error)
  mode='valid';await ui.load()
  assert.equal(ui.state.metadata.error,'')
  assert.equal(ui.state.metadata.actions[0].id,'fresh')
})


test('generated async links remain available when automatic copy is denied', async () => {
  const ui = completionHarness({ delayedCopy: true })
  const done = ui.handleActionDone('succeeded')
  ui.reply.resolve({ data: { url: 'https://fixture.invalid/link' } })
  await new Promise(resolve => setImmediate(resolve))
  ui.copy.reject(new Error('Fixture copy denied'))
  await done
  assert.equal(ui.state.result?.url, 'https://fixture.invalid/link')
  assert.match(ui.state.toast.text, /复制失败/)
  assert.doesNotMatch(ui.state.toast.text, /已复制/)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function completionHarness({ delayedCopy = false } = {}) {
  const reply = deferred()
  const fetcher = path => path === '/tasks/old-task' ? reply.promise : Promise.resolve({ task_id: 'new-task' })
  const controller = pageActions(fetcher, { delayedCopy })
  const row = rowActions(controller, fetcher)
  const oldTask = { taskId: 'old-task', title: 'Old action', operation: 0, platform: 'grok',
    accountId: 1, actionId: 'old-action', onFinished: () => {
      if (row.generation.current === 0) row.state.running = null
    } }
  controller.registerAccountActionTask(oldTask)
  const state = controller.state
  Object.defineProperties(state, {
    running: { get: () => row.state.running },
    task: { get: () => state.tasks.find(task => task.operation === controller.focus.current) },
  })
  return { state, reply, copy: controller.copy, actionGenerationRef: row.generation,
    runAction: row.run, handleActionDone: status => controller.handleActionDone(oldTask, status) }
}

for (const outcome of ['success', 'failure', 'read-error']) {
  test(`late ${outcome} from a previous action cannot overwrite a newer action`, async () => {
    const ui = completionHarness()
    const done = ui.handleActionDone(outcome === 'failure' ? 'failed' : 'succeeded')
    await ui.runAction({ id: 'new-action', label: 'New action' }, {})
    if (outcome === 'read-error') ui.reply.reject(new Error('Old lookup failed'))
    else ui.reply.resolve({ data: { value: 'Old result' }, error: 'Old failure' })
    await done
    assert.equal(ui.state.task.taskId, 'new-task')
    assert.equal(ui.state.running, 'new-action')
    assert.deepEqual(ui.state.results, [])
    assert.deepEqual(ui.state.toasts, [])
    assert.equal(ui.state.changes, 1)
  })
}

for (const rejected of [false, true]) {
  test(`late clipboard ${rejected ? 'failure' : 'success'} cannot reopen a previous result`, async () => {
    const ui = completionHarness({ delayedCopy: true })
    const done = ui.handleActionDone('succeeded')
    ui.reply.resolve({ data: { url: 'https://fixture.invalid/old-result' } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ui.state.copied.length, 1)
    await ui.runAction({ id: 'new-action', label: 'New action' }, {})
    if (rejected) ui.copy.reject(new Error('Old clipboard denial'))
    else ui.copy.resolve()
    await done
    assert.deepEqual(ui.state.results, [])
    assert.deepEqual(ui.state.toasts, [])
    assert.equal(ui.state.running, 'new-action')
  })
}

test('a current result survives refreshing and removing its account row', async () => {
  const ui = completionHarness({ delayedCopy: true })
  const done = ui.handleActionDone('succeeded')
  ui.reply.resolve({ data: { url: 'https://fixture.invalid/current-result' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ui.state.changes, 1)
  ui.actionGenerationRef.current++ // The table row unmounts after its data changes.
  ui.copy.resolve()
  await done
  assert.equal(ui.state.results.length, 1)
  assert.equal(ui.state.changes, 1)
})


test('an inactive task keeps its monitor without mounting a dialog', () => {
  const ast = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ActionTaskModal')
  assert.ok(component)
  const code = ts.transpileModule(component.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React}}).outputText
  const monitor = function FixtureMonitor() {}
  const deps = {React: {createElement: (type, props, ...children) => ({type, props, children})},
    useState: initial => [initial, () => {}], useRef: initial => ({current: initial}),
    isTerminalTaskStatus: () => false, getBatchTaskSummary: () => null, TaskLogPanel: monitor}
  const render = new Function(...Object.keys(deps), code + '\nreturn ActionTaskModal')(...Object.values(deps))
  const node = render({visible: false, title: 'Inactive fixture', taskId: 'fixture-hidden', taskStatus: 'running', onClose() {}, onDone() {}})
  assert.equal(node.type, 'div')
  assert.equal(node.props.hidden, true)
  assert.equal(node.children[0].type, monitor)
  assert.equal(node.children[0].props.taskId, 'fixture-hidden')
})

test('task dismissal waits for terminal status and hiding never steals focus', () => {
  const ast = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ActionTaskModal')
  const handlers = {}
  let closeCode
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'close') closeCode = 'const close = ' + node.initializer.getText(ast)
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === 'Dialog.Content') {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(ast).startsWith('on') && ts.isJsxExpression(attribute.initializer)) {
          handlers[attribute.name.getText(ast)] = attribute.initializer.expression.getText(ast)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(component)
  for (const terminal of [false, true]) {
    let closed = 0, restored = 0, prevented = 0
    const previous = {isConnected: true, matches: () => false, focus: () => restored++}
    const deps = {terminal, closeRequestedRef: {current: false}, returnFocusRef: {current: previous},
      document: {body: {}}, onClose: () => closed++}
    const callbacks = new Function(...Object.keys(deps), compile(closeCode + '; const handlers = {' +
      Object.entries(handlers).map(([key, value]) => key + ': ' + value).join(',') + '};') + '\nreturn {close, handlers}')(...Object.values(deps))
    callbacks.handlers.onCloseAutoFocus({preventDefault: () => prevented++})
    assert.equal(restored, 0)
    callbacks.handlers.onEscapeKeyDown({preventDefault: () => prevented++})
    callbacks.handlers.onPointerDownOutside({preventDefault: () => prevented++})
    assert.equal(prevented, terminal ? 1 : 3)
    callbacks.close()
    assert.equal(closed, Number(terminal))
    callbacks.handlers.onCloseAutoFocus({preventDefault: () => prevented++})
    assert.equal(restored, Number(terminal))
  }
})

test('current action results retain their originating account for focus restoration', async () => {
  const ui = pageActions(async () => ({}))
  await ui.presentAccountActionResult('Fixture', {value: 'fixture'}, 0, 'grok', 7)
  assert.equal(ui.state.results[0].accountId, 7)
})


test('floating action feedback yields to active result and task dialogs', () => {
  const ast = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  let condition
  function visit(node) {
    if (ts.isJsxExpression(node) && node.expression && ts.isBinaryExpression(node.expression)
      && node.expression.left.getText(ast).includes('hasVisibleActionTask')) condition = node.expression.left.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(condition)
  const show = new Function('accountActionNotice', 'actionResult', 'hasVisibleActionTask', 'return Boolean(' + condition + ')')
  const notice = {type: 'success', text: 'Fixture'}
  assert.equal(show(notice, null, false), true)
  assert.equal(show(notice, {payload: {}}, false), false)
  assert.equal(show(notice, null, true), false)
  assert.equal(show(null, null, false), false)
})

function cancellationHarness() {
  const start = source.indexOf('  const requestCancel = ', source.indexOf('function ActionTaskModal'))
  const end = source.indexOf('\n  return (', start)
  const reply = deferred()
  const state = { calls: 0, submitting: false, requested: false, error: '' }
  const deps = {
    terminal: false, cancelPending: false, taskId: 'fixture-task',
    cancelPendingRef: { current: false },
    setCancelSubmitting: value => { state.submitting = value },
    setCancelRequested: value => { state.requested = value },
    setCancelError: value => { state.error = value },
    apiFetch: () => { state.calls++; return reply.promise },
  }
  const cancel = new Function(...Object.keys(deps),
    compile(source.slice(start, end)) + '\nreturn requestCancel')(...Object.values(deps))
  return { state, reply, cancel }
}

test('repeated cancellation while its request is pending sends one request', async () => {
  const ui = cancellationHarness()
  const first = ui.cancel(), second = ui.cancel()
  assert.equal(ui.state.calls, 1)
  assert.equal(ui.state.submitting, true)
  assert.equal(ui.state.requested, false)
  ui.reply.resolve({ ok: true })
  await Promise.all([first, second])
  assert.equal(ui.state.requested, true)
  assert.equal(ui.state.submitting, false)
})

test('rejected cancellation releases its pending control and reports the failure', async () => {
  const ui = cancellationHarness()
  const request = ui.cancel()
  assert.equal(ui.state.submitting, true)
  ui.reply.reject(new Error('Fixture cancel unavailable'))
  await request
  assert.equal(ui.state.requested, false)
  assert.equal(ui.state.submitting, false)
  assert.match(ui.state.error, /Fixture cancel unavailable/)
})

test('different accounts share result focus without finishing the newer account task', async () => {
  const reply = deferred()
  const fetcher = path => path === '/tasks/old-account' ? reply.promise : Promise.resolve({ task_id: 'other-account' })
  const controller = pageActions(fetcher)
  const newerRow = rowActions(controller, fetcher, 2)
  let notified = 0
  const previous = { taskId: 'old-account', title: 'Account one', accountId: 1, actionId: 'old',
    platform: 'grok', operation: 0, onFinished: () => { notified++ } }
  controller.registerAccountActionTask(previous)
  const done = controller.handleActionDone(previous, 'succeeded')
  await newerRow.run({ id: 'new', label: 'Account two action' }, {})
  reply.resolve({ data: { value: 'Old account result' } })
  await done
  assert.deepEqual(controller.state.results, [])
  assert.deepEqual(controller.state.toasts, [])
  assert.equal(newerRow.state.running, 'new')
  assert.equal(controller.state.tasks.find(task => task.taskId === 'other-account').status, null)
  assert.equal(notified, 1)
})

test('a late creation response stays monitored without taking focus from the newer request', async () => {
  const delayed = deferred()
  let detailReads = 0
  const fetcher = path => {
    if (path.startsWith('/tasks/')) { detailReads++; return Promise.resolve({}) }
    return path.includes('/1/') ? delayed.promise : Promise.resolve({ task_id: 'newer-task' })
  }
  const controller = pageActions(fetcher)
  const first = rowActions(controller, fetcher, 1), second = rowActions(controller, fetcher, 2)
  const pending = first.run({ id: 'first', label: 'First' }, {})
  await second.run({ id: 'second', label: 'Second' }, {})
  delayed.resolve({ task_id: 'late-task' })
  await pending
  const late = controller.state.tasks.find(task => task.taskId === 'late-task')
  assert.ok(late)
  assert.equal(controller.state.tasks.find(task => task.operation === controller.focus.current).taskId, 'newer-task')
  await controller.handleActionDone(late, 'succeeded')
  assert.equal(first.state.running, null)
  assert.equal(second.state.running, 'second')
  assert.equal(detailReads, 0)
  assert.deepEqual(controller.state.results, [])
})

test('repeated terminal notifications present one result and notify the row once', async () => {
  const reply = deferred()
  let reads = 0, notifications = 0
  const controller = pageActions(() => { reads++; return reply.promise })
  const task = { taskId: 'same-task', title: 'Fixture', accountId: 1, actionId: 'fixture',
    platform: 'grok', operation: 0, onFinished: () => { notifications++ } }
  controller.registerAccountActionTask(task)
  const first = controller.handleActionDone(task, 'succeeded')
  const second = controller.handleActionDone(task, 'succeeded')
  reply.resolve({ data: { value: 'One result' } })
  await Promise.all([first, second])
  assert.equal(reads, 1)
  assert.equal(notifications, 1)
  assert.equal(controller.state.results.length, 1)
})

test('parameter requests retain errors and retry after their table row disappears', async () => {
  let mode = 'fail', calls = 0
  const fetcher = async () => {
    calls++
    if (mode === 'fail') throw new Error('Fixture action unavailable')
    return { sync: true, ok: true, data: { value: 'Accepted' } }
  }
  const controller = pageActions(fetcher)
  const row = rowActions(controller, fetcher)
  const action = { id: 'params', label: 'Parameters' }
  controller.openAccountActionOptions({ action, params: { note: 'Retained note' }, title: 'Fixture account',
    platform: 'grok', submit: (params, operation) => row.run(action, params, operation) })
  row.generation.current++
  controller.submitOptions({ note: 'Retained note' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.state.pending.params.note, 'Retained note')
  assert.match(controller.state.pending.error, /Fixture action unavailable/)
  assert.equal(controller.state.pending.submitting, false)
  mode = 'success'
  controller.submitOptions({ note: 'Retained note' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.state.pending, null)
  assert.equal(controller.state.result.value, 'Accepted')
  assert.equal(calls, 2)
})

test('an older accepted request cannot close a newer parameter dialog', async () => {
  const reply = deferred()
  const controller = pageActions(() => reply.promise)
  const row = rowActions(controller, () => reply.promise)
  const first = { id: 'first', label: 'First' }
  controller.openAccountActionOptions({ action: first, params: {}, title: 'One', platform: 'grok',
    submit: (params, operation) => row.run(first, params, operation) })
  controller.submitOptions({})
  await new Promise(resolve => setImmediate(resolve))
  controller.openAccountActionOptions({ action: { id: 'second', label: 'Second' }, params: { note: 'New draft' },
    title: 'Two', platform: 'grok', submit() {} })
  reply.resolve({ task_id: 'old-post-task' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.state.pending.action.id, 'second')
  assert.equal(controller.state.pending.params.note, 'New draft')
  assert.equal(controller.state.tasks[0].taskId, 'old-post-task')
})
