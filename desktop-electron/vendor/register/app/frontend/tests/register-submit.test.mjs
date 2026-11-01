import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/pages/Register.tsx', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf('  const submit = async () => {'), source.indexOf('  const handleTaskDone'))
const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const submitFactory = new Function('form', 'allProviderFieldKeys', 'apiFetch', 'setTask', 'setPolling', 'setSubmitting', 'setSubmitError', 'sessionStorage', 'isTerminalTaskStatus', 'submitPendingRef', 'verificationHold', 'verificationHoldLoading', 'verificationHoldError', 'activeTaskIdRef', 'optionsLoading', 'optionsError', 'restoreError', js + '\nreturn submit')
const makeSubmit = (...args) => submitFactory(...args, { setItem() {} }, status => ['succeeded', 'failed', 'interrupted', 'cancelled', 'paused'].includes(status), { current: false }, null, false, '', { current: '' }, false, '', '')
const form = { platform: 'chatgpt', count: 50, concurrency: 5, executor_type: 'headless', identity_provider: 'mailbox', mail_provider: 'cfworker_admin_api', proxy: 'http://127.0.0.1:17891' }

test('rejected registration is visible and leaves Start available', async () => {
  let error = '', submitting = false
  const submit = makeSubmit(form, [], async () => { throw new Error('Backend unavailable') },
    () => assert.fail('failed request created a task'), () => assert.fail('failed request started polling'),
    value => { submitting = value }, value => { error = value })
  await submit()
  assert.equal(error, 'Backend unavailable')
  assert.equal(submitting, false)
})

test('Start is pending until the task creation response arrives', async () => {
  let release, submitting = false, polling = false, task
  const submit = makeSubmit(form, [], () => new Promise(resolve => { release = resolve }),
    value => { task = value }, value => { polling = value },
    value => { submitting = value }, () => {})
  const request = submit()
  assert.equal(submitting, true)
  assert.equal(polling, false)
  release({ task_id: 'local-test', status: 'queued' })
  await request
  assert.equal(task.task_id, 'local-test')
  assert.equal(polling, true)
  assert.equal(submitting, false)
})

test('missing mailbox selection fails before creating a live task', async () => {
  let error = ''
  const submit = makeSubmit({ ...form, mail_provider: '' }, [],
    () => assert.fail('missing mailbox created a live task'), () => {}, () => {}, () => {},
    value => { error = value })
  await submit()
  assert.match(error, /邮箱/)
})

test('50-account request preserves proxy and mailbox without reporting uncompleted successes', async () => {
  let payload, task
  const submit = makeSubmit(form, [], async (_path, options) => {
    payload = JSON.parse(options.body)
    return { task_id: 'local-test', status: 'queued', success: 0 }
  }, value => { task = value }, () => {}, () => {}, () => {})
  await submit()
  assert.equal(payload.count, 50)
  assert.equal(payload.concurrency, 5)
  assert.equal(payload.proxy, form.proxy)
  assert.equal(payload.extra.mail_provider, form.mail_provider)
  assert.equal(task.success, 0)
})


test('repeated Start calls while creation is pending produce only one registration request', async () => {
  let release, calls = 0
  const submit = makeSubmit(form, [], () => {
    calls++
    return new Promise(resolve => { release = resolve })
  }, () => {}, () => {}, () => {}, () => {})
  const first = submit()
  void submit()
  assert.equal(calls, 1)
  release({ task_id: 'local-test', status: 'pending' })
  await first
})

test('a rejected request releases the synchronous Start guard for a retry', async () => {
  let calls = 0
  const submit = makeSubmit(form, [], async () => {
    calls++
    throw new Error('fixture unavailable')
  }, () => {}, () => {}, () => {}, () => {})
  await submit()
  await submit()
  assert.equal(calls, 2)
})

for (const count of [0, -1, 1.5, '', NaN, Infinity]) {
  test(`invalid batch count ${String(count)} never creates a registration`, async () => {
    let error = ''
    const submit = makeSubmit({ ...form, count }, [], () => assert.fail('invalid count started registration'),
      () => {}, () => {}, () => {}, value => { error = value })
    await submit()
    assert.match(error, /整数/)
  })
}


for (const concurrency of [0, -1, 1.5, '', NaN, Infinity, 6]) {
  test('invalid registration concurrency ' + String(concurrency) + ' never creates a task', async () => {
    let calls = 0, error = ''
    const submit = makeSubmit({...form, concurrency}, [], async () => { calls++; return {task_id: 'unexpected'} },
      () => {}, () => {}, () => {}, value => { error = value })
    await submit()
    assert.equal(calls, 0)
    assert.match(error, /并发/)
  })
}

test('legacy registration forms default to one concurrent worker', async () => {
  let payload
  const legacy = {...form}
  delete legacy.concurrency
  const submit = makeSubmit(legacy, [], async (_path, options) => {
    payload = JSON.parse(options.body)
    return {task_id: 'fixture'}
  }, () => {}, () => {}, () => {}, () => {})
  await submit()
  assert.equal(payload.concurrency, 1)
})

test('malformed creation response releases Start and reports a missing task ID', async () => {
  let error = '', submitting = false
  const submit = makeSubmit(form, [], async () => ({}), () => assert.fail('malformed task accepted'),
    () => assert.fail('malformed task started polling'), value => { submitting = value }, value => { error = value })
  await submit()
  assert.match(error, /任务 ID/)
  assert.equal(submitting, false)
})

test('registration extra includes only selected mailbox and SMS fields', async () => {
  const optionsSource = readFileSync(new URL('../src/lib/config-options.ts', import.meta.url), 'utf8')
  const optionsJs = ts.transpileModule(optionsSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const helpers = new Function('exports', optionsJs + '\nreturn exports')({})
  const start = source.indexOf('  const allProviderFieldKeys = ')
  const selection = source.slice(start, source.indexOf('\n  useEffect', start))
  const selectKeys = new Function('form', 'currentMailboxProvider', 'currentSmsProvider', 'listProviderFieldKeys',
    ts.transpileModule(selection, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nreturn allProviderFieldKeys')
  const selected = { ...form, sms_provider: 'smsbower', mail_key: 'fixture-mail', smsbower_api_key: 'fixture-bower',
    herosms_api_key: 'fixture-old', yescaptcha_key: '' }
  const mailbox = { fields: [{ key: 'mail_key' }] }
  const sms = { fields: [{ key: 'smsbower_api_key' }] }
  const keys = selectKeys(selected, mailbox, sms, helpers.listProviderFieldKeys)
  let payload
  const submit = makeSubmit(selected, keys, async (_path, options) => {
    payload = JSON.parse(options.body)
    return { id: 'fixture-alias', status: 'pending' }
  }, task => assert.equal(task.task_id, 'fixture-alias'), () => {}, () => {}, () => {})
  await submit()
  assert.equal(payload.extra.mail_key, 'fixture-mail')
  assert.equal(payload.extra.smsbower_api_key, 'fixture-bower')
  assert.ok(!('herosms_api_key' in payload.extra))
  assert.ok(!('yescaptcha_key' in payload.extra))
  assert.deepEqual(selectKeys({ identity_provider: 'oauth_browser' }, mailbox, sms, helpers.listProviderFieldKeys), ['smsbower_api_key'])
})

test('provider dropdown options handle list and keyed metadata without dropping zero IDs', () => {
  const optionsSource = readFileSync(new URL('../src/lib/config-options.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(optionsSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const helpers = new Function('exports', compiled + '\nreturn exports')({})
  const field = { asyncValueKey: 'id', asyncLabelKey: 'name' }
  assert.deepEqual(helpers.getProviderFieldOptions({ countries: { zero: { id: 0, name: 'Zero' }, one: { id: 1, name: 'One' } } }, field),
    [{ value: '0', label: 'Zero (0)' }, { value: '1', label: 'One (1)' }])
  assert.deepEqual(helpers.getProviderFieldOptions({ services: ['dr'] }, field), [{ value: 'dr', label: 'dr' }])
})
