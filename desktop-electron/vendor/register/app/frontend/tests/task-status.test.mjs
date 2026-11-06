import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/components/tasks/TaskLogPanel.tsx', import.meta.url), 'utf8')
const taskSource = readFileSync(new URL('../src/lib/tasks.ts', import.meta.url), 'utf8')
const taskJs = ts.transpileModule(taskSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const taskHelpers = new Function('exports', taskJs + '\nreturn exports')({})
const start = source.lastIndexOf('  useEffect(() => {', source.indexOf('    if (!taskId) return'))
const end = source.indexOf('  }, [taskId])', start) + '  }, [taskId])'.length
const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

async function mountPanel(fetch) {
  const state = { task: null, lines: [], done: null, callbacks: [], requests: [], stream: null, poll: null, cleared: false }
  const ref = current => ({ current })
  let effect
  state.now = 0
  const timers = new Map()
  let nextTimer = 0
  state.advance = milliseconds => {
    state.now += milliseconds
    for (const [id, timer] of [...timers]) {
      if (timer.at <= state.now) { timers.delete(id); timer.callback() }
    }
  }
  class EventSource {
    constructor() { state.stream = this; this.closed = false }
    close() { this.closed = true }
  }
  const dependencies = {
    Date: { now: () => state.now, parse: Date.parse },
    setTimeout: (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, { at: state.now + milliseconds, callback }); return id },
    clearTimeout: id => timers.delete(id),
    setLogError: value => { state.logError = value }, setStatusError: value => { state.statusError = value },
    useEffect: callback => { effect = callback }, taskId: 'existing-recovery',
    API_BASE: '/api', EventSource,
    apiFetch: async (path, options) => { state.requests.push(path); return fetch(path, options) },
    isTerminalTaskStatus: taskHelpers.isTerminalTaskStatus,
    copyGenerationRef: ref(0),
    seenEventIdsRef: ref(new Set()), cursorRef: ref(0), doneRef: ref(false),
    onDoneRef: ref(status => state.callbacks.push(status)), sseHealthyRef: ref(false), eventSourceRef: ref(null),
    streamSnapshotRef: ref({ received: false, version: 0 }),
    setCopyStatus: () => {},
    setLines: update => { state.lines = typeof update === 'function' ? update(state.lines) : update },
    setTask: value => { state.task = typeof value === 'function' ? value(state.task) : value }, setDoneStatus: value => { state.done = value },
    window: { setInterval: callback => { state.poll = callback; return 1 }, clearInterval: () => { state.cleared = true } },
  }
  new Function(...Object.keys(dependencies), js)(...Object.values(dependencies))
  state.cleanup = effect()
  await new Promise(resolve => setImmediate(resolve))
  return state
}

test('queued and cancelling panels explain why execution has not completed', () => {
  const require = createRequire(import.meta.url)
  const panelJs = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const render = status => {
    let stateIndex = 0
    const states = [[], { status, progress_detail: { current: 0, total: 28 } }, null]
    const load = name => name === 'react' ? {
      useState: () => [states[stateIndex++], () => {}], useEffect: () => {}, useRef: value => ({ current: value }),
    } : name === '@/lib/tasks' ? taskHelpers : name === '@/lib/utils' ? {} : require(name)
    const exports = {}
    new Function('require', 'exports', panelJs)(load, exports)
    return renderToStaticMarkup(exports.TaskLogPanel({ taskId: 'batch', onDone: () => {} }))
  }
  assert.match(render(undefined), /正在读取任务状态/)
  assert.doesNotMatch(render(undefined), /执行中/)
  assert.match(render('pending'), /等待同平台或同账号/)
  assert.match(render('pending'), /关闭窗口不会取消任务/)
  assert.match(render('cancel_requested'), /当前步骤退出后/)
  assert.doesNotMatch(render('running'), /等待同平台或同账号|当前步骤退出后/)
  assert.doesNotMatch(render('cancelled'), /等待同平台或同账号|当前步骤退出后/)
})

test('healthy task stream still refreshes queued status and progress from persisted state', async () => {
  let snapshots = 0
  const state = await mountPanel(async path => {
    assert.equal(path, '/tasks/existing-recovery')
    return ++snapshots === 1
      ? { status: 'pending', progress_detail: { current: 0, total: 1, label: '0/1' } }
      : { status: 'running', progress_detail: { current: 1, total: 2, label: '1/2' } }
  })
  assert.equal(state.task.status, 'pending')
  state.stream.onopen()
  state.stream.onmessage({ data: JSON.stringify({ id: 2, type: 'state', line: '任务已开始执行' }) })
  assert.equal(state.lines.at(-1), '任务已开始执行')
  await state.poll()
  assert.equal(state.task.status, 'running')
  assert.equal(state.task.progress_detail.label, '1/2')
  assert.equal(state.requests.length, 2)
  state.cleanup()
  assert.equal(state.cleared, true)
  assert.equal(state.stream.closed, true)
})

test('unhealthy stream retains event fallback and task snapshot refresh', async () => {
  const state = await mountPanel(async path => path.includes('/events?')
    ? { items: [{ id: 5, line: 'existing event' }] }
    : { status: 'running' })
  state.stream.onerror()
  await state.poll()
  assert.deepEqual(state.lines, ['existing event'])
  assert.ok(state.requests.includes('/tasks/existing-recovery/events?since=0'))
  assert.equal(state.task.status, 'running')
  state.cleanup()
})

test('terminal snapshot closes a healthy stream and calls completion only once', async () => {
  let snapshots = 0
  const state = await mountPanel(async path => path.includes('/events?') ? { items: [] }
    : ({ status: ++snapshots === 1 ? 'pending' : 'failed', error: 'Recovery failed' }))
  state.stream.onopen()
  await state.poll()
  assert.equal(state.task.status, 'failed')
  assert.equal(state.task.error, 'Recovery failed')
  assert.equal(state.done, 'failed')
  assert.deepEqual(state.callbacks, ['failed'])
  assert.equal(state.stream.closed, true)
  await state.poll()
  assert.equal(snapshots, 2)
  assert.deepEqual(state.callbacks, ['failed'])
  state.cleanup()
})


test('paused phone verification closes its task stream and has an amber terminal label', async () => {
  const state = await mountPanel(async () => ({ status: 'paused', result: {
    verification_hold: { active: true, code: 'rate_limit_exceeded', reason: 'OpenAI 手机验证限流' },
  } }))
  assert.equal(taskHelpers.getTaskStatusText('paused'), '手机验证暂停')
  assert.equal(taskHelpers.TASK_STATUS_VARIANTS.paused, 'warning')
  assert.equal(state.done, 'paused')
  assert.equal(state.stream.closed, true)
  assert.deepEqual(state.callbacks, ['paused'])
  const requests = state.requests.length
  await state.poll()
  assert.equal(state.requests.length, requests)
  state.cleanup()
})

test('queued phone task with an active hold keeps polling and can become runnable', async () => {
  let snapshots = 0
  const state = await mountPanel(async path => path.includes('/events?') ? { items: [] } : ({
    status: ++snapshots === 1 ? 'pending' : 'running',
    result: { verification_hold: { active: true, code: 'rate_limit_exceeded' } },
  }))
  assert.equal(state.done, null)
  assert.equal(state.stream.closed, false)
  await state.poll()
  assert.equal(state.task.status, 'running')
  assert.equal(state.done, null)
  state.cleanup()
})

test('closed task panel ignores a delayed terminal snapshot and queued stream event', async () => {
  let release
  const state = await mountPanel(() => new Promise(resolve => { release = resolve }))
  state.cleanup()
  state.stream.onmessage({ data: JSON.stringify({ done: true, status: 'failed', line: 'late old task' }) })
  release({ status: 'failed', error: 'old task failed' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.task, null)
  assert.equal(state.done, null)
  assert.deepEqual(state.lines, [])
  assert.deepEqual(state.callbacks, [])
})


test('task snapshots update status immediately without repeated healthy-stream GETs', async () => {
  const state = await mountPanel(async () => ({ status: 'pending' }))
  state.stream.onopen()
  state.stream.onmessage({ data: JSON.stringify({ task: {
    status: 'running', progress: '1/2', progress_detail: { current: 1, total: 2, label: '1/2' },
  } }) })
  assert.equal(state.task.status, 'running')
  assert.equal(state.task.progress_detail.current, 1)
  for (let i = 0; i < 10; i++) await state.poll()
  assert.equal(state.requests.length, 1)
  assert.equal(state.lines.length, 0)
  state.cleanup()
})

test('a streamed snapshot wins over a delayed initial GET even after stream failure', async () => {
  let release
  const state = await mountPanel(() => new Promise(resolve => { release = resolve }))
  state.stream.onopen()
  state.stream.onmessage({ data: JSON.stringify({ task: {
    status: 'running', progress_detail: { current: 1, total: 2, label: '1/2' },
  } }) })
  state.stream.onerror()
  release({ status: 'pending', progress_detail: { current: 0, total: 2, label: '0/2' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.task.status, 'running')
  assert.equal(state.task.progress_detail.current, 1)
  state.cleanup()
})

test('stream completion retrieves final error details once and ignores duplicate completion', async () => {
  let snapshots = 0
  const state = await mountPanel(async () => ++snapshots === 1
    ? { status: 'pending' }
    : { status: 'failed', error: 'Fixture requires manual verification' })
  state.stream.onopen()
  const completion = { done: true, status: 'failed', task: {
    status: 'failed', progress_detail: { current: 1, total: 1, label: '1/1' },
  } }
  state.stream.onmessage({ data: JSON.stringify(completion) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.task.error, 'Fixture requires manual verification')
  assert.equal(state.requests.length, 2)
  assert.deepEqual(state.callbacks, ['failed'])
  assert.equal(state.stream.closed, true)
  state.stream.onmessage({ data: JSON.stringify(completion) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.requests.length, 2)
  assert.deepEqual(state.callbacks, ['failed'])
  state.cleanup()
})

test('snapshot-capable streams retain polling fallback after a connection error', async () => {
  let snapshots = 0
  const state = await mountPanel(async path => path.includes('/events?')
    ? { items: [] }
    : { status: ++snapshots === 1 ? 'pending' : 'running',
        progress_detail: { current: snapshots === 1 ? 0 : 2, total: 3 } })
  state.stream.onopen()
  state.stream.onmessage({ data: JSON.stringify({ task: {
    status: 'running', progress_detail: { current: 1, total: 3 },
  } }) })
  state.stream.onerror()
  await state.poll()
  assert.equal(state.task.progress_detail.current, 2)
  assert.ok(state.requests.includes('/tasks/existing-recovery/events?since=0'))
  state.cleanup()
})

test('reopening a completed task drains persisted log pages before closing the panel', async () => {
  const events = Array.from({ length: 201 }, (_, index) => ({ id: index + 1, line: `history ${index + 1}` }))
  const state = await mountPanel(async path => {
    if (!path.includes('/events?')) return { status: 'succeeded' }
    const cursor = Number(path.split('since=')[1])
    return { items: events.filter(item => item.id > cursor).slice(0, 200) }
  })
  assert.equal(state.done, 'succeeded')
  assert.deepEqual(state.callbacks, ['succeeded'])
  assert.equal(state.lines.length, 201)
  assert.equal(state.lines[0], 'history 1')
  assert.equal(state.lines.at(-1), 'history 201')
  assert.ok(state.requests.includes('/tasks/existing-recovery/events?since=200'))
  assert.equal(state.stream.closed, true)
  state.cleanup()
})

test('unmount ignores delayed history without repeating an already confirmed completion', async () => {
  let release
  const state = await mountPanel(path => path.includes('/events?')
    ? new Promise(resolve => { release = resolve })
    : { status: 'succeeded' })
  assert.deepEqual(state.callbacks, ['succeeded'])
  state.cleanup()
  release({ items: [{ id: 1, line: 'old history' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(state.lines, [])
  assert.deepEqual(state.callbacks, ['succeeded'])
})

function makeLogCopy(navigator, document, lines = ['fixture line 1', 'fixture line 2']) {
  const start = source.indexOf('  const copyLogs = ')
  const end = source.indexOf('\n  return (', start)
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const statuses = []
  const copyGenerationRef = { current: 0 }
  const copy = new Function('navigator', 'document', 'lines', 'setCopyStatus', 'copyGenerationRef',
    compiled + '\nreturn copyLogs')(navigator, document, lines, value => statuses.push(value), copyGenerationRef)
  return { copy, statuses, invalidate: () => { copyGenerationRef.current++ } }
}


test('pending copy for a closed or switched task cannot update feedback or start a stale fallback', async () => {
  for (const rejected of [false, true]) {
    let settle
    const pending = new Promise((resolve, reject) => { settle = rejected ? reject : resolve })
    const { copy, statuses, invalidate } = makeLogCopy({ clipboard: { writeText: () => pending } }, {})
    const writing = copy()
    invalidate()
    settle(rejected ? new Error('Denied') : undefined)
    await writing
    assert.deepEqual(statuses, [''])
  }
})

test('a newer copy suppresses an older rejected write and its fallback', async () => {
  let rejectOld, calls = 0
  const pending = new Promise((resolve, reject) => { rejectOld = reject })
  const { copy, statuses } = makeLogCopy({ clipboard: { writeText: () => ++calls === 1 ? pending : Promise.resolve() } }, {})
  const oldWrite = copy()
  await copy()
  rejectOld(new Error('Denied'))
  await oldWrite
  assert.equal(statuses.at(-1), '日志已复制')
  assert.equal(statuses.filter(status => status === '日志已复制').length, 1)
})

function fallbackClipboard(result = true) {
  const state = { text: '', removed: false, focused: false }
  const el = { value: '', style: {}, select() { state.text = this.value }, remove() { state.removed = true } }
  return { state, document: { activeElement: { focus() { state.focused = true } },
    createElement: () => el, body: { appendChild() {} }, execCommand: () => result } }
}

test('copy logs reports successful exact multiline clipboard writes', async () => {
  const written = []
  const { copy, statuses } = makeLogCopy({ clipboard: { writeText: async text => written.push(text) } }, {})
  await copy()
  assert.deepEqual(written, ['fixture line 1\nfixture line 2'])
  assert.equal(statuses.at(-1), '日志已复制')
})

test('copy logs supports unavailable and rejected Clipboard API with focus cleanup', async () => {
  for (const navigator of [{}, { clipboard: { writeText: async () => { throw new Error('Denied') } } }]) {
    const { state, document } = fallbackClipboard()
    const { copy, statuses } = makeLogCopy(navigator, document)
    await copy()
    assert.equal(state.text, 'fixture line 1\nfixture line 2')
    assert.equal(state.removed, true)
    assert.equal(state.focused, true)
    assert.equal(statuses.at(-1), '日志已复制')
  }
})

test('copy logs reports fallback denial and ignores empty logs', async () => {
  const { state, document } = fallbackClipboard(false)
  const { copy, statuses } = makeLogCopy({}, document)
  await copy()
  assert.match(statuses.at(-1), /复制失败/)
  assert.equal(state.removed, true)
  const empty = makeLogCopy({ clipboard: { writeText: () => assert.fail('copied empty log') } }, {}, [])
  await empty.copy()
  assert.deepEqual(empty.statuses, [])
})

for (const finalStatus of ['succeeded', 'failed', 'cancelled', 'paused']) {
  test(`quiet connected streams reconcile persisted ${finalStatus} without a terminal event`, async () => {
    let snapshots = 0
    const state = await mountPanel(async path => path.includes('/events?')
      ? { items: [{ id: 9, line: 'Persisted final event' }] }
      : { status: ++snapshots === 1 ? 'running' : finalStatus })
    state.stream.onopen()
    state.stream.onmessage({ data: JSON.stringify({ task: { status: 'running' } }) })
    state.advance(15000)
    await state.poll()
    assert.equal(state.done, finalStatus)
    assert.deepEqual(state.callbacks, [finalStatus])
    assert.equal(state.stream.closed, true)
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(state.lines.includes('Persisted final event'))
    state.cleanup()
  })
}

test('log endpoint failure cannot block authoritative terminal status', async () => {
  let snapshots = 0
  const state = await mountPanel(async path => {
    if (path.includes('/events?')) throw new Error('Fixture log outage')
    return { status: ++snapshots === 1 ? 'running' : 'cancelled' }
  })
  state.stream.onerror()
  await state.poll()
  assert.equal(state.task.status, 'cancelled')
  assert.equal(state.done, 'cancelled')
  assert.deepEqual(state.callbacks, ['cancelled'])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.logError, true)
  state.cleanup()
})

test('terminal status does not wait for a delayed log history response', async () => {
  let release
  const state = await mountPanel(path => path.includes('/events?')
    ? new Promise(resolve => { release = resolve })
    : Promise.resolve({ status: 'cancelled' }))
  assert.equal(state.done, 'cancelled')
  assert.deepEqual(state.callbacks, ['cancelled'])
  release({ items: [{ id: 1, line: 'Final log after status confirmation' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(state.lines, ['Final log after status confirmation'])
  assert.deepEqual(state.callbacks, ['cancelled'])
  state.cleanup()
})

test('a delayed older stream snapshot cannot regress a reconciled snapshot', async () => {
  let snapshots = 0
  const state = await mountPanel(async path => path.includes('/events?') ? { items: [] }
    : (++snapshots === 1
      ? { status: 'pending', updated_at: '2026-10-17T00:00:00Z' }
      : { status: 'running', updated_at: '2026-10-17T00:00:02Z', progress_detail: { current: 2, total: 3 } }))
  state.stream.onopen()
  state.stream.onmessage({ data: JSON.stringify({ task: {
    status: 'running', updated_at: '2026-10-17T00:00:01Z', progress_detail: { current: 1, total: 3 },
  } }) })
  state.advance(15000)
  await state.poll()
  assert.equal(state.task.progress_detail.current, 2)
  state.stream.onmessage({ data: JSON.stringify({ task: {
    status: 'pending', updated_at: '2026-10-17T00:00:00Z', progress_detail: { current: 0, total: 3 },
  } }) })
  assert.equal(state.task.status, 'running')
  assert.equal(state.task.progress_detail.current, 2)
  state.cleanup()
})

test('fallback polls cannot overlap while an earlier poll waits for history', async () => {
  let release, historyReads = 0
  const state = await mountPanel(path => {
    if (path.includes('/events?')) { historyReads++; return new Promise(resolve => { release = resolve }) }
    return Promise.resolve({ status: 'running' })
  })
  state.stream.onerror()
  const first = state.poll()
  const second = state.poll()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(historyReads, 1)
  release({ items: [] })
  await Promise.all([first, second])
  state.cleanup()
})

test('a poll started before stream completion cannot replace final details', async () => {
  let snapshots = 0, release
  const state = await mountPanel(path => {
    if (path.includes('/events?')) return Promise.resolve({ items: [] })
    snapshots++
    if (snapshots === 1) return Promise.resolve({ status: 'running' })
    if (snapshots === 2) return new Promise(resolve => { release = resolve })
    return Promise.resolve({ status: 'failed', error: 'Final confirmed error' })
  })
  state.stream.onopen()
  state.stream.onmessage({ data: JSON.stringify({ task: { status: 'running' } }) })
  state.advance(15000)
  const pending = state.poll()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(release, 'periodic reconciliation must start')
  state.stream.onmessage({ data: JSON.stringify({ done: true, status: 'failed' }) })
  await new Promise(resolve => setImmediate(resolve))
  release({ status: 'pending', error: 'Stale details' })
  await pending
  assert.equal(state.task.status, 'failed')
  assert.equal(state.task.error, 'Final confirmed error')
  assert.deepEqual(state.callbacks, ['failed'])
  state.cleanup()
})

test('failed history recovers after terminal confirmation without repeating completion', async () => {
  let logsAvailable = false
  const state = await mountPanel(async path => {
    if (!path.includes('/events?')) return { status: 'cancelled' }
    if (!logsAvailable) throw new Error('Fixture log outage')
    return { items: [{ id: 1, line: 'Recovered final log' }] }
  })
  assert.equal(state.done, 'cancelled')
  assert.equal(state.logError, true)
  logsAvailable = true
  await state.poll()
  assert.equal(state.logError, false)
  assert.deepEqual(state.lines, ['Recovered final log'])
  assert.deepEqual(state.callbacks, ['cancelled'])
  const reads = state.requests.length
  await state.poll()
  assert.equal(state.requests.length, reads)
  state.cleanup()
})

test('a status read timeout is visible and does not prevent the next status read', async () => {
  let reads = 0
  const state = await mountPanel((path, options) => {
    if (path.includes('/events?')) return Promise.resolve({ items: [] })
    if (++reads > 1) return Promise.resolve({ status: 'running' })
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Fixture read timeout'))))
  })
  state.advance(10000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.statusError, true)
  assert.equal(state.done, null)
  await state.poll()
  assert.equal(state.task.status, 'running')
  assert.equal(state.statusError, false)
  assert.deepEqual(state.callbacks, [])
  state.cleanup()
})

test('closing a panel aborts its pending read without changing confirmed state', async () => {
  let aborted = false
  const state = await mountPanel((path, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Panel closed')) })
  }))
  state.cleanup()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(aborted, true)
  assert.equal(state.task, null)
  assert.equal(state.statusError, false)
  assert.deepEqual(state.callbacks, [])
})

test('an invalid stream frame falls back to status and persisted logs', async () => {
  let reads = 0
  const state = await mountPanel(async path => path.includes('/events?')
    ? { items: [{ id: 1, line: 'Recovered history' }] }
    : { status: ++reads === 1 ? 'pending' : 'running' })
  state.stream.onopen()
  state.stream.onmessage({ data: JSON.stringify({ task: { status: 'pending' } }) })
  assert.doesNotThrow(() => state.stream.onmessage({ data: 'invalid fixture frame' }))
  await state.poll()
  assert.equal(state.task.status, 'running')
  assert.deepEqual(state.lines, ['Recovered history'])
  assert.equal(state.logError, false)
  assert.deepEqual(state.callbacks, [])
  state.cleanup()
})

for (const status of [undefined, 'running']) {
  test(`a completion frame with ${status || 'missing'} status is confirmed rather than assumed`, async () => {
    const state = await mountPanel(async path => path.includes('/events?') ? { items: [] } : { status: 'running' })
    state.stream.onopen()
    state.stream.onmessage({ data: JSON.stringify({ task: { status: 'running' } }) })
    state.stream.onmessage({ data: JSON.stringify({ done: true, status }) })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.done, null)
    assert.equal(state.task.status, 'running')
    assert.deepEqual(state.callbacks, [])
    state.cleanup()
  })
}

test('a null stream frame is recoverable instead of throwing into the page', async () => {
  const state = await mountPanel(async path => path.includes('/events?') ? { items: [] } : { status: 'running' })
  assert.doesNotThrow(() => state.stream.onmessage({ data: 'null' }))
  await state.poll()
  assert.equal(state.task.status, 'running')
  assert.equal(state.done, null)
  state.cleanup()
})

test('a missing persisted task releases the viewer as failed without claiming cancellation', async () => {
  let reads = 0
  const state = await mountPanel(async path => {
    if (path.includes('/events?')) return { items: [] }
    if (++reads === 1) return { status: 'running' }
    throw new Error('{"detail":"任务不存在"}')
  })
  state.stream.onerror()
  await state.poll()
  assert.equal(state.done, 'failed')
  assert.equal(state.task.error, '任务不存在')
  assert.deepEqual(state.callbacks, ['failed'])
  assert.equal(state.stream.closed, true)
  state.cleanup()
})

test('a rejected pre-completion poll cannot replace confirmed final details', async () => {
  let reads = 0, rejectOld
  const state = await mountPanel((path) => {
    if (path.includes('/events?')) return Promise.resolve({ items: [] })
    if (++reads === 1) return Promise.resolve({ status: 'running' })
    if (reads === 2) return new Promise((resolve, reject) => { rejectOld = reject })
    return Promise.resolve({ status: 'failed', error: 'Confirmed final details' })
  })
  state.stream.onopen()
  state.stream.onmessage({ data: JSON.stringify({ task: { status: 'running' } }) })
  state.advance(15000)
  const old = state.poll()
  await new Promise(resolve => setImmediate(resolve))
  state.stream.onmessage({ data: JSON.stringify({ done: true, status: 'failed' }) })
  await new Promise(resolve => setImmediate(resolve))
  rejectOld(new Error('{"detail":"任务不存在"}'))
  await old
  assert.equal(state.task.error, 'Confirmed final details')
  assert.deepEqual(state.callbacks, ['failed'])
  state.cleanup()
})

test('final detail reads retry after failure without notifying completion again', async () => {
  let reads = 0
  const state = await mountPanel(async () => {
    reads++
    if (reads === 1) return { status: 'running' }
    if (reads === 2) throw new Error('Fixture final detail outage')
    return { status: 'failed', error: 'Recovered final details' }
  })
  state.stream.onopen()
  state.stream.onmessage({ data: JSON.stringify({ done: true, status: 'failed' }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.statusError, true)
  await state.poll()
  assert.equal(state.statusError, false)
  assert.equal(state.task.error, 'Recovered final details')
  assert.deepEqual(state.callbacks, ['failed'])
  state.cleanup()
})
