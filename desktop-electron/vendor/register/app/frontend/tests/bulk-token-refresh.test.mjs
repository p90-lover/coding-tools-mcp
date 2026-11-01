import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/pages/Accounts.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function makeBulkRefreshHarness(overrides = {}) {
  const definitions =
    source.slice(source.indexOf('function getDisplaySummary'), source.indexOf('function getVerificationMailbox')) +
    source.slice(source.indexOf('function getLifecycleStatus'), source.indexOf('function getPlanState'))
  const selection = source.slice(source.indexOf('  const pageIds = '), source.indexOf('  const togglePage = '))
  const handler = source.slice(source.indexOf('  const refreshSelectedTokens = '), source.indexOf('  const visibleTrial = '))
  assert.ok(selection.includes('eligibleTokenRefreshIds'))
  assert.ok(handler.includes('/actions/chatgpt/bulk/refresh_token'))
  const compiled = ts.transpileModule(definitions + selection + handler, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const state = { calls: [], task: null, status: 'old-status', summary: null, error: '', submitting: false }
  const dependencies = {
    beginAccountAction: () => 1,
    tab: 'chatgpt',
    accounts: [
      { id: 1, platform: 'chatgpt', lifecycle_status: 'registered' },
      { id: 2, platform: 'chatgpt', lifecycle_status: 'phone_required' },
      { id: 3, platform: 'chatgpt', lifecycle_status: '2fa_required' },
      { id: 4, platform: 'chatgpt', lifecycle_status: 'expired' },
      { id: 5, platform: 'grok', lifecycle_status: 'registered' },
      { id: 6, platform: 'chatgpt', lifecycle_status: 'fraud_guard' },
      { id: 7, platform: 'chatgpt', lifecycle_status: 'rate_limit_exceeded' },
      { id: 0, platform: 'chatgpt', lifecycle_status: 'registered' },
      { id: -1, platform: 'chatgpt', lifecycle_status: 'registered' },
      { id: 101, platform: 'chatgpt', lifecycle_status: 'registered' },
      { id: 102, platform: 'chatgpt', lifecycle_status: 'registered' },
    ],
    selectedIds: new Set([1, 2, 3, 4, 5, 6, 7, 0, -1, 101, 102, 999]),
    loading: false,
    pageReady: true,
    batchRefreshing: false,
    bulkRecovering: false,
    bulkRefreshSubmitting: false,
    verificationHold: null,
    verificationHoldLoading: false,
    verificationHoldError: '',
    batchTask: null,
    batchTaskStatus: null,
    isTerminalTaskStatus: status => ['succeeded', 'failed', 'cancelled', 'interrupted', 'paused'].includes(status),
    apiFetch: async (path, options) => {
      state.calls.push({ path, options })
      return { task_id: 'bulk-refresh-task', status: 'pending', progress: '0/4' }
    },
    setBulkRefreshError: value => { state.error = value },
    setBulkRefreshSubmitting: value => { state.submitting = value },
    setBatchTask: value => { state.task = value },
    setBatchTaskStatus: value => { state.status = value },
    setBatchTaskSummary: value => { state.summary = value },
    ...overrides,
  }
  const result = new Function(
    ...Object.keys(dependencies),
    compiled + '\nreturn { eligible: eligibleTokenRefreshIds, pending: pendingRegistrationIds, blocked: blockedSelectedIds, recovery: eligibleRecoveryIds, recoveryDisabled: bulkRecoveryDisabled, operationDisabled: batchOperationDisabled, disabled: bulkTokenRefreshDisabled, submit: refreshSelectedTokens }',
  )(...Object.values(dependencies))
  return { ...result, state }
}

test('ChatGPT background refresh setting preserves the visible default and updates the saved form', () => {
  const settings = readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const tabs = settings.slice(settings.indexOf('const TABS:'), settings.indexOf('\nfunction Field('))
  const field = settings.slice(settings.indexOf('function Field('), settings.indexOf('\nfunction ProviderField('))
  const js = ts.transpileModule(tabs + field, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText
  const selects = []
  const React = { createElement: (type, props) => {
    if (type === 'select') selects.push(props)
    return { type, props }
  } }
  const { TABS, Field } = new Function('React', 'Cpu', 'Sliders', 'Shield', 'PROVIDER_META',
    js + '\nreturn { TABS, Field }')(React, null, null, null, { mailbox: {}, captcha: {}, sms: {} })
  const option = TABS.find(tab => tab.id === 'chatgpt').sections.flatMap(section => section.items)
    .find(item => item.key === 'chatgpt_token_refresh_headless')
  assert.ok(option, 'Background refresh must be configurable in the ChatGPT settings tab')
  assert.deepEqual(option.options.map(item => item.value), ['false', 'true'])

  for (const initial of [undefined, 'false', 'true']) {
    let form = { default_executor: 'headed', ...(initial === undefined ? {} : { [option.key]: initial }) }
    const render = () => Field({ field: option, form,
      setForm: update => { form = update(form) }, showSecret: {}, setShowSecret() {} })
    render()
    assert.equal(selects.at(-1).value, initial || 'false')
    assert.equal(selects.at(-1)['aria-label'], '浏览器显示方式')
    for (const value of ['true', 'false']) {
      selects.at(-1).onChange({ target: { value } })
      render()
      assert.equal(selects.at(-1).value, value)
      assert.equal(form.chatgpt_token_refresh_headless, value)
      assert.equal(form.default_executor, 'headed')
    }
  }
})

test('bulk token refresh sends only selected eligible ChatGPT ids with an empty params object', async () => {
  const result = makeBulkRefreshHarness()
  assert.deepEqual(result.eligible, [1, 4, 101, 102])
  assert.deepEqual(result.pending, [2, 3])
  assert.deepEqual(result.blocked, [6, 7])
  assert.deepEqual(result.recovery, [2, 3])
  assert.equal(result.disabled, false)
  await result.submit()
  assert.equal(result.state.calls.length, 1)
  assert.equal(result.state.calls[0].path, '/actions/chatgpt/bulk/refresh_token')
  assert.equal(result.state.calls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(result.state.calls[0].options.body), {
    account_ids: [1, 4, 101, 102],
    params: {},
  })
  assert.equal(result.state.task.taskId, 'bulk-refresh-task')
  assert.equal(result.state.summary, null)
  assert.equal(result.state.submitting, false)
})

test('bulk token refresh never selects all when selection is empty and blocks overlapping batches', async () => {
  for (const overrides of [
    { selectedIds: new Set() },
    { loading: true },
    { bulkRefreshSubmitting: true },
    { batchRefreshing: true },
    { bulkRecovering: true },
    { batchTask: { taskId: 'active' }, batchTaskStatus: null },
    { batchTask: { taskId: 'active' }, batchTaskStatus: 'running' },
  ]) {
    const result = makeBulkRefreshHarness(overrides)
    assert.equal(result.disabled, true)
    await result.submit()
    assert.equal(result.state.calls.length, 0)
  }
  assert.equal(makeBulkRefreshHarness({ batchTask: { taskId: 'done' }, batchTaskStatus: 'succeeded' }).disabled, false)
})


test('a phone-only hold leaves unrelated token and quota actions available', async () => {
  for (const overrides of [
    { verificationHold: { active: true, account_id: 7 } },
    { verificationHoldLoading: true },
    { verificationHoldError: 'phone hold lookup unavailable' },
  ]) {
    const result = makeBulkRefreshHarness(overrides)
    assert.equal(result.disabled, false)
    assert.equal(result.recoveryDisabled, true)
    assert.equal(result.operationDisabled, false)
    assert.deepEqual(result.eligible, [1, 4, 101, 102])
    await result.submit()
    assert.equal(result.state.calls.length, 1)
    assert.deepEqual(JSON.parse(result.state.calls[0].options.body), {
      account_ids: [1, 4, 101, 102], params: {},
    })
  }
})

test('bulk token refresh caps a selected request at one hundred unique positive ids', () => {
  const accounts = Array.from({ length: 110 }, (_, index) => ({
    id: index + 1,
    platform: 'chatgpt',
    lifecycle_status: 'registered',
  }))
  const result = makeBulkRefreshHarness({ accounts, selectedIds: new Set(accounts.map(account => account.id)) })
  assert.equal(result.eligible.length, 100)
  assert.equal(new Set(result.eligible).size, 100)
  assert.ok(result.eligible.every(id => Number.isSafeInteger(id) && id > 0))
})

test('bulk refresh copy explains recovery rows and partial outcomes without exposing raw tokens', () => {
  assert.match(source, /批量自动刷新 Token/)
  assert.match(source, /待注册账号请使用[“"]?批量恢复注册/)
  assert.match(source, /批量刷新部分完成/)
  assert.match(source, /需人工处理/)
  assert.match(source, /\/tasks\/\$\{taskId\}\/cancel/)
  assert.match(source, /取消请求已提交，等待后端返回最终状态/)
  assert.match(source, /batchTaskIdRef\.current !== completedTaskId/)
  assert.match(source, /batchTaskIdRef\.current = null/)
  assert.match(source, /variant=\{taskStatus === 'succeeded' && partial \? 'warning'/)
  assert.match(source, /\{getTaskStatusText\(taskStatus\)\}/)
  assert.doesNotMatch(source, /partial \? '部分完成' : getTaskStatusText/)
  const summarySource = source.slice(source.indexOf('function getBatchTaskSummary'), source.indexOf('function ActionTaskModal'))
  const summaryJs = ts.transpileModule(summarySource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const getSummary = new Function(summaryJs + '\nreturn getBatchTaskSummary')()
  assert.deepEqual(getSummary({ result: { data: {
    refreshed: [1],
    skipped: [2],
    failed: [3],
    remaining: [4],
    needs_user_action: [5],
    access_token: 'must-not-be-rendered',
  } } }), {
    refreshed: 1,
    skipped: 1,
    failed: 1,
    remaining: 1,
    needsUserAction: 1,
  })
  assert.doesNotMatch(summarySource, /access_token|refresh_token|raw token/i)
})

test('blocked account statuses have distinct labels, filters, and manual-review treatment', () => {
  const utilsSource = readFileSync(new URL('../src/lib/utils.ts', import.meta.url), 'utf8')
  assert.match(source, /fraud_guard: 'danger'/)
  assert.match(source, /rate_limit_exceeded: 'warning'/)
  assert.match(source, /fraud_guard/)
  assert.match(source, /rate_limit_exceeded/)
  assert.match(source, /风控拦截/)
  assert.match(source, /手机号限流/)
  assert.match(source, /需人工审核/)
  assert.match(source, /不能更换号码绕过/)
  assert.match(utilsSource, /BLOCKED_ACCOUNT_STATUS_FILTER_OPTIONS/)
  assert.match(utilsSource, /fraud_guard/)
  assert.match(utilsSource, /rate_limit_exceeded/)
})

test('rate-limited accounts expose only exact-owner manual recovery while fraud guard stays blocked', async () => {
  const parsed = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'runAction') handler = node
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(handler)
  const handlerSource = 'const ' + handler.getText(parsed) + ';'
  const compiled = ts.transpileModule(handlerSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText

  async function runFixture(status, hold, params) {
    const calls = [], tasks = [], toasts = []
    const recoveryParams = hold?.active && hold.account_id === 42
      ? { resume_verification_hold: true }
      : (hold ? null : {})
    const deps = {
      acc: { id: 42, platform: 'chatgpt', lifecycle_status: status },
      verificationHold: hold,
      verificationHoldLoading: false,
      verificationHoldError: '',
      recoveryHold: hold,
      recoveryParams,
      getVerificationRecoveryParams: (id, currentHold) => currentHold?.active && currentHold.account_id === id
        ? { resume_verification_hold: true } : (currentHold ? null : {}),
      actionPendingRef: { current: false }, actionGenerationRef: { current: 0 },
      onActionStart: () => 1, onTask: task => tasks.push(task), onError: (_operation, text) => toasts.push({ type: 'error', text }),
      setActionError() {},
      setPendingAction() {},
      setRunning() {},
      setActionTaskStatus() {},
      setActionTask(task) { tasks.push(task) },
      setToast(value) { toasts.push(value) },
      onChanged() {},
      onResult() {},
      apiFetch: async (path, options) => {
        calls.push({ path, options })
        return { task_id: 'manual-rate-recovery' }
      },
    }
    const runAction = new Function(...Object.keys(deps), compiled + '\nreturn runAction')(...Object.values(deps))
    runAction({ id: 'complete_registration', label: '恢复注册' }, params)
    await new Promise(resolve => setImmediate(resolve))
    return { calls, tasks, toasts }
  }

  const exact = await runFixture('rate_limit_exceeded', { active: true, account_id: 42 }, { resume_verification_hold: true })
  assert.equal(exact.calls.length, 1)
  assert.equal(exact.calls[0].path, '/actions/chatgpt/42/complete_registration')
  assert.deepEqual(JSON.parse(exact.calls[0].options.body), { params: { resume_verification_hold: true } })
  assert.equal(exact.tasks.length, 1)

  for (const fixture of [
    ['rate_limit_exceeded', { active: true, account_id: 43 }, { resume_verification_hold: true }],
    ['rate_limit_exceeded', null, { resume_verification_hold: true }],
    ['rate_limit_exceeded', { active: true, account_id: 42 }, {}],
    ['fraud_guard', { active: true, account_id: 42 }, { resume_verification_hold: true }],
  ]) {
    const blocked = await runFixture(...fixture)
    assert.equal(blocked.calls.length, 0)
    assert.equal(blocked.tasks.length, 0)
    assert.match(blocked.toasts.at(-1)?.text || '', /人工|不能更换号码绕过/)
  }
})

test('terminal summaries ignore stale success and failure callbacks after another batch starts', async () => {
  const prefix = '          onDone={(status) => {'
  const start = source.indexOf(prefix, source.indexOf('{batchTask && ('))
  const end = source.indexOf('\n          }}', start)
  assert.ok(start > 0 && end > start)
  const callbackSource = '(status) => {' + source.slice(start + prefix.length, end) + '\n}'
  const js = ts.transpileModule('const done = ' + callbackSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const stale of [false, true]) {
    for (const rejectRequest of [false, true]) {
      let resolve, reject
      const updates = []
      const ref = { current: 'old-task' }
      const deps = {
        batchTask: { taskId: 'old-task', title: '批量自动刷新 Token（2）' },
        batchTaskIdRef: ref,
        setBatchTaskStatus: () => {}, setBatchRefreshing: () => {}, load: () => {},
        setBatchTaskSummary: value => updates.push(value),
        apiFetch: path => {
          assert.equal(path, '/tasks/old-task')
          return new Promise((yes, no) => { resolve = yes; reject = no })
        },
      }
      const done = new Function(...Object.keys(deps), js + '\nreturn done')(...Object.values(deps))
      done('succeeded')
      if (stale) ref.current = 'new-task'
      const summary = { refreshed: [1], skipped: [], failed: [], remaining: [] }
      if (rejectRequest) reject(new Error('fixture failure'))
      else resolve({ result: { data: summary } })
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(updates, stale ? [] : [rejectRequest ? null : summary])
    }
  }
})

test('cancellation submits the exact task and waits for authoritative terminal status', async () => {
  const start = source.indexOf('  const requestCancel = ', source.indexOf('function ActionTaskModal'))
  const end = source.indexOf('\n\n  return (', start)
  const js = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const mode of ['running', 'terminal', 'pending', 'error']) {
    const calls = [], requested = [], errors = []
    const deps = {
      terminal: mode === 'terminal', cancelPending: mode === 'pending', taskId: 'exact-task',
      cancelPendingRef: { current: false }, setCancelSubmitting() {},
      setCancelRequested: value => requested.push(value), setCancelError: value => errors.push(value),
      apiFetch: async (path, options) => { calls.push({ path, options }); return mode === 'error'
        ? { ok: false, error: 'fixture rejection' } : { ok: true, status: 'cancel_requested' } },
    }
    const cancel = new Function(...Object.keys(deps), js + '\nreturn requestCancel')(...Object.values(deps))
    await cancel()
    assert.deepEqual(calls, ['terminal', 'pending'].includes(mode) ? [] : [
      { path: '/tasks/exact-task/cancel', options: { method: 'POST' } },
    ])
    assert.deepEqual(requested, mode === 'running' ? [true] : [])
    if (mode === 'error') assert.equal(errors.at(-1), 'fixture rejection')
  }
})

