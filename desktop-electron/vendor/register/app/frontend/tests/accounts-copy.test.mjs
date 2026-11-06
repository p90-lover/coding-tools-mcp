import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/pages/Accounts.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const taskSource = readFileSync(new URL('../src/lib/tasks.ts', import.meta.url), 'utf8')
const taskJs = ts.transpileModule(taskSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const taskHelpers = new Function('exports', taskJs + '\nreturn exports')({})
const timerStart = source.indexOf('  const copyStatusTimer = ')
const timerEnd = source.indexOf('\n\n  useEffect(() => {', timerStart)
const handler = source.slice(timerStart, timerEnd) +
  source.slice(source.indexOf('  const showCopyStatus = '), source.indexOf('  const currentPlatformMeta'))
const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const createCopy = new Function('navigator', 'document', 'setCopyStatus', 'useRef', 'useEffect', 'setTimeout', 'clearTimeout', js + '\nreturn copy')
function makeCopy(navigator, document, setCopyStatus, timers = { setTimeout: () => 1, clearTimeout() {} }) {
  return createCopy(navigator, document, setCopyStatus, current => ({ current }),
    effect => { timers.cleanup = effect() }, timers.setTimeout, timers.clearTimeout)
}

test('copy toast floats above the grid, expires at 500 ms, resets and cleans up on unmount', async () => {
  let now = 0, nextId = 0, status = '', updates = 0
  const pending = new Map()
  const timers = {
    setTimeout(callback, delay) {
      assert.equal(delay, 500)
      const id = ++nextId
      pending.set(id, { callback, at: now + delay })
      return id
    },
    clearTimeout(id) { pending.delete(id) },
  }
  const advance = milliseconds => {
    now += milliseconds
    for (const [id, timer] of pending) {
      if (timer.at <= now) { pending.delete(id); timer.callback() }
    }
  }
  const copy = makeCopy({ clipboard: { writeText: async () => {} } }, {},
    value => { status = value; updates++ }, timers)
  await copy('fixture', '邮箱')
  advance(499)
  assert.equal(status, '邮箱已复制')
  await copy('fixture', '邮箱')
  advance(1)
  assert.equal(status, '邮箱已复制')
  advance(499)
  assert.equal(status, '')
  await copy('fixture', '密码')
  timers.cleanup()
  const updatesAtUnmount = updates
  advance(500)
  assert.equal(updates, updatesAtUnmount)
  assert.equal(pending.size, 0)

  const start = source.indexOf('<div role="status" aria-live="polite"', source.indexOf('export default function Accounts'))
  const end = source.indexOf('</div>', start) + '</div>'.length
  const popupJs = ts.transpileModule('const popup = ' + source.slice(start, end),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText
  const popup = new Function('React', 'copyStatus', popupJs + '\nreturn popup')(
    { createElement: (type, props) => ({ type, props }) }, '邮箱已复制')
  assert.ok(popup.props.className.split(' ').includes('fixed'))
})

function clipboardDocument(result = true) {
  const state = { text: '', removed: false, restoredFocus: false }
  const element = {
    style: {}, value: '', select() { state.text = this.value },
    setSelectionRange() {}, remove() { state.removed = true },
  }
  return {
    state,
    document: {
      activeElement: { focus() { state.restoredFocus = true } },
      createElement: () => element,
      body: { appendChild() {}, removeChild() { state.removed = true } },
      execCommand: () => result,
    },
  }
}

test('clipboard writes exact account values and reports success without revealing them', async () => {
  const written = [], statuses = []
  const copy = makeCopy({ clipboard: { writeText: async text => { written.push(text) } } }, {}, value => statuses.push(value))
  await copy('demo@example.test', '邮箱')
  await copy(' secret fixture ', '密码')
  assert.deepEqual(written, ['demo@example.test', ' secret fixture '])
  assert.equal(statuses.at(-1), '密码已复制')
  assert.ok(statuses.every(value => !value.includes('secret fixture')))
})

test('missing or rejected Clipboard API falls back and cleans up selection control', async () => {
  for (const navigator of [{}, { clipboard: { writeText: async () => { throw new Error('Denied') } } }]) {
    const { state, document } = clipboardDocument()
    let status
    await makeCopy(navigator, document, value => { status = value })('fixture', '密码')
    assert.equal(state.text, 'fixture')
    assert.equal(state.removed, true)
    assert.equal(state.restoredFocus, true)
    assert.equal(status, '密码已复制')
  }
})

test('failed fallback reports failure and removes the temporary control', async () => {
  const { state, document } = clipboardDocument(false)
  let status
  await makeCopy({}, document, value => { status = value })('fixture', '密码')
  assert.match(status, /复制失败/)
  assert.equal(state.removed, true)
  assert.equal(state.restoredFocus, true)
})

test('account copy buttons remain visible, named and do not open account details', async () => {
  const acc = { email: 'demo@example.test', password: 'fixture' }, calls = []
  for (const [field, label] of [['email', '邮箱'], ['password', '密码']]) {
    const call = source.indexOf('copy(acc.' + field)
    const start = source.lastIndexOf('<button', call)
    const end = source.indexOf('</button>', call) + '</button>'.length
    const jsx = 'const button = ' + source.slice(start, end)
    const code = ts.transpileModule(jsx, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText
    const React = { createElement: (type, props) => ({ type, props }) }
    const button = new Function('React', 'Copy', 'acc', 'copy', code + '\nreturn button')(React, 'copy-icon', acc, (...args) => { calls.push(args) })
    assert.equal(button.props.type, 'button')
    assert.equal(button.props['aria-label'], '复制' + label)
    assert.equal(button.props.title, '复制' + label)
    assert.ok(!button.props.className.includes('opacity-0'))
    assert.equal(button.props.disabled, false)
    let stopped = false
    await button.props.onClick({ stopPropagation() { stopped = true } })
    assert.equal(stopped, true)
    assert.deepEqual(calls.at(-1), [acc[field], label])
  }
  assert.ok(!source.includes('title={acc.password}'))
})


function bulkRecoveryHarness(overrides = {}) {
  const definitions = source.slice(source.indexOf('function getDisplaySummary'), source.indexOf('function getVerificationMailbox')) +
    source.slice(source.indexOf('function getLifecycleStatus'), source.indexOf('function getDisplayStatus'))
  const selection = source.slice(source.indexOf('  const eligibleRecoveryIds = '), source.indexOf('  const toggleOne'))
  const handler = source.slice(source.indexOf('  const recoverSelected = '), source.indexOf('  const visibleTrial'))
  assert.ok(selection.includes('eligibleRecoveryIds') && handler.includes('recoverSelected'))
  const compiled = ts.transpileModule(definitions + selection + handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const state = { error: '', busy: false, task: null, status: 'old-status', calls: [] }
  const dependencies = {
    beginAccountAction: () => 1,
    tab: 'chatgpt',
    accounts: [
      { id: 1, platform: 'chatgpt', lifecycle_status: 'phone_required', display_status: 'invalid' },
      { id: 2, platform: 'chatgpt', lifecycle_status: 'registered', display_summary: { status: { lifecycle: '2fa_required', display: 'invalid' } } },
      { id: 3, platform: 'chatgpt', lifecycle_status: 'registered' },
      { id: 4, platform: 'chatgpt', lifecycle_status: 'expired' },
      { id: 5, platform: 'grok', lifecycle_status: 'phone_required' },
      { id: 6, platform: 'chatgpt', lifecycle_status: 'phone_required' },
    ],
    selectedIds: new Set([1, 2, 3, 4, 5, 99]),
    loading: false, pageReady: true, bulkRecovering: false, batchRefreshing: false, batchTask: null, batchTaskStatus: null,
    verificationHold: null, verificationHoldLoading: false, verificationHoldError: '',
    isTerminalTaskStatus: status => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status),
    apiFetch: async (path, options) => { state.calls.push({ path, options }); return { task_id: 'test-bulk-task' } },
    refreshVerificationHold() {},
    setBulkRecoveryError: value => { state.error = value },
    setBulkRecovering: value => { state.busy = value },
    setBatchTask: value => { state.task = value }, setBatchTaskStatus: value => { state.status = value },
    ...overrides,
  }
  const result = new Function(...Object.keys(dependencies), compiled + '\nreturn { ids: eligibleRecoveryIds, disabled: bulkRecoveryDisabled, submit: recoverSelected }')(...Object.values(dependencies))
  return { ...result, state }
}

test('bulk recovery uses lifecycle eligibility and one task request for eligible selected ChatGPT IDs', async () => {
  const result = bulkRecoveryHarness()
  assert.deepEqual(result.ids, [1, 2])
  assert.equal(result.disabled, false)
  await result.submit()
  assert.equal(result.state.calls.length, 1)
  assert.equal(result.state.calls[0].path, '/actions/chatgpt/bulk/complete_registration')
  assert.equal(result.state.calls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(result.state.calls[0].options.body), { account_ids: [1, 2], params: {} })
  assert.equal(result.state.task.taskId, 'test-bulk-task')
  assert.equal(result.state.status, null)
  assert.equal(result.state.busy, false)
})

test('bulk recovery cannot submit other platforms, empty eligibility, loading or active batches', async () => {
  for (const overrides of [
    { tab: 'grok' }, { selectedIds: new Set([3, 4, 5]) }, { loading: true }, { bulkRecovering: true },
    { batchRefreshing: true }, { batchTask: { taskId: 'active' }, batchTaskStatus: 'running' },
    { verificationHold: { active: true, account_id: 1 } }, { verificationHoldLoading: true }, { verificationHoldError: 'Unavailable' },
  ]) {
    const result = bulkRecoveryHarness(overrides)
    assert.equal(result.disabled, true)
    await result.submit()
    assert.equal(result.state.calls.length, 0)
  }
  assert.equal(bulkRecoveryHarness({ batchTask: { taskId: 'finished' }, batchTaskStatus: 'failed' }).disabled, false)
})

test('bulk recovery remains pending until response, accepts task id alias and shows a rejected request', async () => {
  let release
  const pending = bulkRecoveryHarness({ apiFetch: () => new Promise(resolve => { release = resolve }) })
  const request = pending.submit()
  assert.equal(pending.state.busy, true)
  release({ id: 'task-id-alias' })
  await request
  assert.equal(pending.state.task.taskId, 'task-id-alias')
  assert.equal(pending.state.busy, false)
  const rejected = bulkRecoveryHarness({ apiFetch: async () => { throw new Error('没有可恢复的账号') } })
  await rejected.submit()
  assert.equal(rejected.state.error, '没有可恢复的账号')
  assert.equal(rejected.state.task, null)
  assert.equal(rejected.state.busy, false)
})

test('bulk recovery rejection refreshes the hold and never opens an undefined task', async () => {
  let refreshed = 0
  const result = bulkRecoveryHarness({
    refreshVerificationHold() { refreshed++ },
    apiFetch: async () => ({ ok: false, error: 'Too many phone verification requests',
      data: { verification_hold: { active: true, account_id: 42 }, requires_user_action: true } }),
  })
  await result.submit()
  assert.equal(result.state.task, null)
  assert.equal(result.state.error, 'Too many phone verification requests')
  assert.equal(refreshed, 1)
})

test('verification recovery authorizes only the exact held account', () => {
  const hold = { active: true, code: 'rate_limit_exceeded', account_id: 42 }
  assert.deepEqual(taskHelpers.getVerificationRecoveryParams(42, hold), { resume_verification_hold: true })
  assert.equal(taskHelpers.getVerificationRecoveryParams(43, hold), null)
  assert.equal(taskHelpers.getVerificationRecoveryParams(42, { active: true }), null)
  assert.deepEqual(taskHelpers.getVerificationRecoveryParams(42, null), {})
  assert.deepEqual(taskHelpers.getVerificationRecoveryParams(42, { active: false, account_id: 43 }), {})
})

test('existing account action handler requires explicit same-account hold recovery and preserves other actions', async () => {
  const parsed = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let declaration
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'runAction') declaration = node
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(declaration)
  const handler = 'const ' + declaration.getText(parsed) + ';'
  const compiled = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  for (const fixture of [
    { id: 42, action: 'complete_registration', params: {}, allowed: false },
    { id: 42, action: 'complete_registration', params: { resume_verification_hold: true }, allowed: true },
    { id: 43, action: 'complete_registration', params: { resume_verification_hold: true }, allowed: false },
    { id: 43, action: 'refresh_token', params: {}, allowed: true },
    { id: 42, action: 'complete_registration', params: { resume_verification_hold: true }, allowed: true, response: { ok: false, error: 'Too many phone verification requests', data: { verification_hold: { active: true, account_id: 42 } } }, noTask: true },
    { id: 42, action: 'complete_registration', params: { resume_verification_hold: true }, allowed: false, loading: true },
    { id: 42, action: 'complete_registration', params: { resume_verification_hold: true }, allowed: false, error: 'Unavailable' },
  ]) {
    const calls = [], tasks = [], changes = []
    const acc = { id: fixture.id, platform: 'chatgpt', email: 'fixture@example.test' }
    const hold = { active: true, code: 'rate_limit_exceeded', account_id: 42 }
    const dependencies = {
      acc, verificationHold: hold, verificationHoldLoading: fixture.loading || false, verificationHoldError: fixture.error || '',
      recoveryHold: hold, recoveryParams: taskHelpers.getVerificationRecoveryParams(acc.id, hold),
      getVerificationRecoveryParams: taskHelpers.getVerificationRecoveryParams,
      actionPendingRef: { current: false }, actionGenerationRef: { current: 0 }, setActionError() {}, setPendingAction() {},
      onActionStart: () => 1, onTask: task => tasks.push(task), onError: () => changes.push(true),
      setRunning() {}, setActionTaskStatus() {}, setActionTask(task) { tasks.push(task) }, setToast() {}, onChanged() { changes.push(true) }, onResult() {},
      apiFetch: async (path, options) => { calls.push({ path, options }); return fixture.response || { task_id: 'manual-recovery' } },
    }
    const runAction = new Function(...Object.keys(dependencies), compiled + '\nreturn runAction')(...Object.values(dependencies))
    runAction({ id: fixture.action, label: 'fixture' }, fixture.params)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.length, fixture.allowed ? 1 : 0)
    assert.equal(tasks.length, fixture.allowed && !fixture.noTask ? 1 : 0)
    if (fixture.noTask) assert.equal(changes.length, 1)
    if (fixture.allowed) {
      assert.equal(calls[0].path, '/actions/chatgpt/' + fixture.id + '/' + fixture.action)
      assert.deepEqual(JSON.parse(calls[0].options.body), { params: fixture.params })
    }
  }
})



test('bulk deletion reports partial failures and preserves a newer page selection', async () => {
  const start=source.indexOf('  const deleteSelected = ')
  const end=source.indexOf('  const beginAccountAction = ',start)
  const compiled=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  for(const moved of [false,true]) {
    let selected=new Set([1,2]),error='',busy=false
    const pending=[]
    const deps={bulkDeleting:false,pageReady:true,selectedIds:new Set([1,2]),confirm:()=>true,
      setBulkDeleting:value=>{busy=value},setDeleteError:value=>{error=value},
      setSelectedIds:value=>{selected=typeof value==='function'?value(selected):value},
      apiFetch:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),load:async()=>{}}
    const submit=new Function(...Object.keys(deps),compiled+'\nreturn deleteSelected')(...Object.values(deps))
    const deletion=submit()
    if(moved) selected=new Set([101])
    pending[0].resolve({ok:true})
    pending[1].reject(new Error('Fixture delete unavailable'))
    await deletion
    assert.deepEqual([...selected],moved?[101]:[2])
    assert.match(error,/1 个账号删除失败/)
    assert.equal(busy,false)
  }
})


test('obsolete platform metadata cannot change the selected account platform after navigation', async () => {
  const lookup=source.indexOf('    getPlatforms().then',source.indexOf('export default function Accounts'))
  const start=source.lastIndexOf('  useEffect(() => {',lookup)
  const end=source.indexOf('  }, [platform, tab])',start)+'  }, [platform, tab])'.length
  const compiled=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  let release,cleanup,platformUpdates=0,metadataUpdates=0
  new Function('useEffect','getPlatforms','platform','tab','setPlatformsMap','setTab',compiled)(
    effect=>{cleanup=effect()},()=>new Promise(resolve=>{release=resolve}),undefined,'',
    ()=>metadataUpdates++,()=>platformUpdates++)
  cleanup?.()
  release([{name:'old-platform'}])
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(platformUpdates,0)
  assert.equal(metadataUpdates,0)
})

function makeAccountList(fetcher) {
  const start = source.indexOf('  const load = useCallback', source.indexOf('export default function Accounts'))
  const end = source.indexOf('\n\n  useEffect', start)
  const js = ts.transpileModule(source.slice(start, end), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  const state = { rows: [], total: 0, loading: false, error: '', pagination: null }
  const currentQueryRef = { current: {platform:'grok',search:'',status:'',page:2,filterKey:'grok-filter',key:'grok-page-2'} }
  const dependencies = {
    useCallback: fn => fn, tab:'grok',debouncedSearch:'',filterStatus:'',page:2,
    currentQueryRef, loadRequestRef:{current:0}, mountedRef:{current:true},
    setLoading:value=>{state.loading=value},setAccounts:value=>{state.rows=value},
    setTotal:value=>{state.total=value},setLoadError:value=>{state.error=value},
    setLoadedQuery:()=>{},setSelectedIds:()=>{},
    setPagination:value=>{state.pagination=value},apiFetch:fetcher,
  }
  const load = new Function(...Object.keys(dependencies),js+'\nreturn load')(...Object.values(dependencies))
  return {state,load,currentQueryRef}
}

test('account list requests the chosen page and a retained callback reads the current platform', async () => {
  const requests=[]
  const {state,load,currentQueryRef}=makeAccountList(async path=>{
    requests.push(path)
    return {items:[{id:101}],total:205}
  })
  await load()
  assert.equal(new URLSearchParams(requests[0].split('?')[1]).get('page'),'2')
  assert.equal(state.total,205)
  currentQueryRef.current={platform:'cursor',search:'new',status:'invalid',page:1,filterKey:'cursor-filter',key:'cursor-page-1'}
  await load()
  const params=new URLSearchParams(requests.at(-1).split('?')[1])
  assert.equal(params.get('platform'),'cursor')
  assert.equal(params.get('email'),'new')
  assert.equal(params.get('status'),'invalid')
})

test('obsolete account replies cannot replace the latest page or its loading state', async () => {
  const releases=[]
  const {state,load,currentQueryRef}=makeAccountList(()=>new Promise(resolve=>releases.push(resolve)))
  const first=load()
  currentQueryRef.current={...currentQueryRef.current,page:3,key:'grok-page-3'}
  const second=load()
  releases[0]({items:[{id:101}],total:205})
  await first
  assert.equal(state.loading,true)
  assert.deepEqual(state.rows,[])
  releases[1]({items:[{id:201}],total:205})
  await second
  assert.deepEqual(state.rows,[{id:201}])
  assert.equal(state.loading,false)
})

test('account failures are visible and an emptied final page requests the last valid page', async () => {
  const failed=makeAccountList(async()=>{throw new Error('Fixture unavailable')})
  await failed.load()
  assert.equal(failed.state.error,'Fixture unavailable')
  assert.equal(failed.state.loading,false)
  const clamped=makeAccountList(async()=>({items:[],total:100}))
  await clamped.load()
  assert.deepEqual(clamped.state.pagination,{key:'grok-filter',page:1})
})


function makeMenuExport(fetcher, ids = []) {
  const begin = source.indexOf('function ExportMenu(')
  const start = source.indexOf('  const doExport = ', begin)
  const end = source.indexOf('\n  const options = ', start)
  const state = {calls: [], downloads: [], alerts: [], open: true, loading: null}
  const deps = {platform: 'chatgpt', total: 2, disabled: false, loading: null,
    hasSelection: ids.length > 0, selectedIds: ids, statusFilter: 'invalid', searchFilter: 'fixture',
    exportPendingRef: {current: false},
    setLoading: value => { state.loading = value }, setOpen: value => { state.open = value },
    window: {alert: message => state.alerts.push(message)},
    apiDownload: (path, options) => { state.calls.push({path, body: JSON.parse(options.body)}); return fetcher() },
    triggerBrowserDownload: (...args) => state.downloads.push(args)}
  const js = ts.transpileModule(source.slice(start, end), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText
  return {state, submit: new Function(...Object.keys(deps), js + '\nreturn doExport')(...Object.values(deps))}
}

test('ChatGPT export blocks overlapping requests and creates one download', async () => {
  const releases = []
  const ui = makeMenuExport(() => new Promise(resolve => releases.push(resolve)), [101])
  const first = ui.submit('json')
  const second = ui.submit('csv')
  const requestCount = ui.state.calls.length
  for (const release of releases) release({blob: 'fixture', filename: 'accounts.json'})
  await Promise.all([first, second])
  assert.equal(requestCount, 1)
  assert.equal(ui.state.downloads.length, 1)
  assert.deepEqual(ui.state.calls[0].body, {platform: 'chatgpt', ids: [101], select_all: false,
    status_filter: null, search_filter: null})
  assert.equal(ui.state.loading, null)
})

test('ChatGPT export preserves filter semantics and retries after a failed request', async () => {
  let fail = true
  const ui = makeMenuExport(async () => {
    if (fail) throw Error('Fixture export unavailable')
    return {blob: 'fixture', filename: 'accounts.zip'}
  })
  await ui.submit('csv')
  assert.deepEqual(ui.state.alerts, ['Fixture export unavailable'])
  assert.equal(ui.state.open, true)
  assert.equal(ui.state.loading, null)
  assert.deepEqual(ui.state.calls[0].body, {platform: 'chatgpt', ids: [], select_all: true,
    status_filter: 'invalid', search_filter: 'fixture'})
  fail = false
  await ui.submit('cpa', true)
  assert.deepEqual(ui.state.calls[1].body, {platform: 'chatgpt', ids: [], select_all: true,
    status_filter: null, search_filter: null})
  assert.equal(ui.state.downloads.length, 1)
  assert.equal(ui.state.open, false)
})

test('generic CSV export uses complete server selection and filters instead of the loaded page', async () => {
  const start=source.indexOf('  const exportCsv = ',source.indexOf('export default function Accounts'))
  const end=source.indexOf('  const beginAccountAction = ',start)
  const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  for(const ids of [[],[101]]) {
    const calls=[],downloads=[]
    const dependencies={
      tab:'grok',debouncedSearch:'fixture',filterStatus:'invalid',
      pageReady:true,selectedIds:new Set(ids),accounts:[{id:101,email:'one@example.invalid'}],
      exportingRef:{current:false},setExporting:()=>{},setExportError:()=>{},
      getDisplayStatus:()=> 'invalid',getLifecycleStatus:()=> 'invalid',getPlanState:()=> 'unknown',
      getValidityStatus:()=> 'invalid',getCashierUrl:()=> '',escapeCsvField:String,
      currentQueryRef:{current:{platform:'grok',search:'fixture',status:'invalid'}},
      apiDownload:async(path,opts)=>{calls.push({path,body:JSON.parse(opts.body)});return {blob:'fixture',filename:'accounts.csv'}},
      triggerBrowserDownload:(...args)=>downloads.push(args),
    }
    const exportCsv=new Function(...Object.keys(dependencies),code+'\nreturn exportCsv')(...Object.values(dependencies))
    await exportCsv()
    assert.equal(calls.length,1)
    assert.equal(calls[0].path,'/accounts/export/table-csv')
    assert.deepEqual(calls[0].body,{platform:'grok',ids,select_all:ids.length===0,
      status_filter:ids.length?null:'invalid',search_filter:ids.length?null:'fixture'})
    assert.equal(downloads.length,1)
  }
})
