import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/pages/Accounts.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function modalHandler(name, fetcher) {
  const begin = source.indexOf('function ' + name + '(')
  const declaration = name === 'ImportModal' ? 'submit' : 'save'
  const start = source.indexOf('  const ' + declaration + ' = ', begin)
  const end = source.indexOf('\n  return (', start)
  const state = { busy: false, error: '', result: null, done: 0, calls: [] }
  const pending = { current: false }
  const deps = {
    form: { email: 'fixture@example.invalid', lifecycle_status: 'phone_required', primary_token: 'fixture-token' },
    platform: 'chatgpt', acc: { id: 1 }, text: 'fixture@example.invalid fixture-password',
    savePendingRef: pending, submitPendingRef: pending,
    initialFormRef: { current: { lifecycle_status: 'phone_required', primary_token: 'fixture-initial', cashier_url: '' } },

    setSaving: value => { state.busy = value }, setLoading: value => { state.busy = value },
    setError: value => { state.error = value }, setResult: value => { state.result = value },
    onDone: () => state.done++, onSave: () => state.done++,
    apiFetch: (path, options) => { state.calls.push({ path, options }); return fetcher(path, options) },
  }
  const submit = new Function(...Object.keys(deps), compile(source.slice(start, end)) + '\nreturn ' + declaration)(...Object.values(deps))
  return { submit, state }
}

for (const name of ['AddModal', 'DetailModal', 'ImportModal']) {
  test(name + ' keeps rejected saves visible and retryable without completing', async () => {
    let reject = true
    const ui = modalHandler(name, async () => {
      if (reject) throw new Error('Fixture request unavailable')
      return { created: 1 }
    })
    await assert.doesNotReject(ui.submit())
    assert.match(ui.state.error, /Fixture request unavailable/)
    assert.equal(ui.state.done, 0)
    assert.equal(ui.state.busy, false)
    reject = false
    await ui.submit()
    assert.equal(ui.state.done, 1)
    assert.equal(ui.state.error, '')
  })

  test(name + ' submits once while a write is pending', async () => {
    let release
    const ui = modalHandler(name, () => new Promise(resolve => { release = resolve }))
    const first = ui.submit()
    const second = ui.submit()
    assert.equal(ui.state.calls.length, 1)
    release({ created: 1 })
    await Promise.all([first, second])
    assert.equal(ui.state.done, 1)
    assert.equal(ui.state.busy, false)
  })
}


for (const [name, pendingName] of [
  ['AddModal', 'savePendingRef'], ['DetailModal', 'savePendingRef'], ['ImportModal', 'submitPendingRef'],
]) {
  test(name + ' blocks dismissal during writes and restores focus after closing', () => {
    const ast = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
    const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    const handlers = {}
    function visit(node) {
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
    let closed = 0, restored = 0, prevented = 0
    const pending = { current: false }, returnFocusRef = { current: null }
    const trigger = { focus: () => restored++ }
    const deps = { [pendingName]: pending, returnFocusRef, onClose: () => closed++,
      document: { activeElement: trigger } }
    const callbacks = Object.fromEntries(Object.entries(handlers).map(([key, code]) => [
      key, new Function(...Object.keys(deps), compile('const handler = ' + code) + '\nreturn handler')(...Object.values(deps)),
    ]))
    callbacks.onOpenAutoFocus()
    assert.equal(returnFocusRef.current, trigger)
    callbacks.onOpenChange(true)
    assert.equal(closed, 0)
    callbacks.onOpenChange(false)
    assert.equal(closed, 1)
    pending.current = true
    callbacks.onOpenChange(false)
    callbacks.onEscapeKeyDown({ preventDefault: () => prevented++ })
    callbacks.onPointerDownOutside({ preventDefault: () => prevented++ })
    assert.equal(closed, 1)
    assert.equal(prevented, 2)
    pending.current = false
    callbacks.onEscapeKeyDown({ preventDefault: () => prevented++ })
    callbacks.onPointerDownOutside({ preventDefault: () => prevented++ })
    assert.equal(prevented, 2)
    callbacks.onCloseAutoFocus({ preventDefault: () => prevented++ })
    assert.equal(restored, 1)
    assert.equal(prevented, 3)
  })
}


test('account refresh restores only lost focus to the requested account control', () => {
  const ast = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  let effectCode
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('!restoreAccountFocus')) effectCode = node.arguments[0].getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(effectCode)
  for (const target of ['detail', 'action', 'list']) {
    for (const [pageReady, movedFocus, expected] of [[false, false, 0], [true, false, 1], [true, true, 0]]) {
      const restoreAccountFocus = target === 'list' ? {target} : {target, accountId: 7}
      let restored = 0, selector = '', cleared = false
      const body = {}, document = {body, activeElement: movedFocus ? {} : body,
        querySelector: value => { selector = value; return {focus: () => restored++} }}
      const deps = {pageReady, restoreAccountFocus, document, setRestoreAccountFocus: value => { cleared = value === null }}
      const effect = new Function(...Object.keys(deps), compile('const effect = ' + effectCode) + '\nreturn effect')(...Object.values(deps))
      effect()
      assert.equal(restored, expected)
      assert.equal(cleared, pageReady)
      if (expected) assert.equal(selector, target === 'list' ? 'button[aria-label="刷新账号列表"]' : 'button[data-account-' + target + '-id="7"]')
    }
  }
})

test('clearing account search or status starts at page one', () => {
  const ast = ts.createSourceFile('Accounts.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  function findHandler(attribute, value) {
    let handler
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const props = node.attributes.properties
        const match = props.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(ast) === attribute
          && prop.initializer && ts.isStringLiteral(prop.initializer) && prop.initializer.text === value)
        if (match) {
          const change = props.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(ast) === 'onChange')
          handler = change.initializer.expression.getText(ast)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.ok(handler, value)
    return handler
  }
  for (const [attribute, label, type] of [['placeholder', '搜索账号邮箱...', 'search'], ['aria-label', '账号状态筛选', 'status']]) {
    const state = { search: type === 'search' ? 'fixture' : '', status: type === 'status' ? 'invalid' : '',
      pagination: { key: JSON.stringify(['chatgpt', '', '']), page: 2 } }
    const deps = { setSelectedIds() {}, setSearch: value => { state.search = value },
      setFilterStatus: value => { state.status = value }, setPagination: value => { state.pagination = value } }
    const handler = new Function(...Object.keys(deps), compile('const handler = ' + findHandler(attribute, label)) + '\nreturn handler')(...Object.values(deps))
    handler({ target: { value: '' } })
    const key = JSON.stringify(['chatgpt', state.search, state.status])
    assert.equal(state.pagination.key === key ? state.pagination.page : 1, 1, type)
  }
})


test('detail and action-result copy callbacks report clipboard denial without rejecting', async () => {
  for (const [component, variable, endMarker] of [
    ['DetailModal', 'copyText', '  const platformCredentials'],
    ['ActionResultModal', 'copyResult', '\n\n  return ('],
  ]) {
    const begin = source.indexOf('function ' + component + '(')
    const start = source.indexOf('  const ' + variable + ' = ', begin)
    const end = source.indexOf(endMarker, start)
    assert.ok(start >= 0 && end > start)
    for (const denied of [false, true]) {
      let notice = '', copied = ''
      const deps = { content: 'fixture-result', setCopyNotice: value => { notice = value },
        navigator: { clipboard: { writeText: async value => { if (denied) throw Error('Fixture denied'); copied = value } } } }
      const copy = new Function(...Object.keys(deps), compile(source.slice(start, end)) + '\nreturn ' + variable)(...Object.values(deps))
      await assert.doesNotReject(copy('fixture-result'))
      assert.match(notice, denied ? /复制失败/ : /已复制/)
      assert.equal(copied, denied ? '' : 'fixture-result')
    }
  }
})

function deleteHandler(fetcher, confirmed = true, running = null) {
  const start = source.indexOf('  const deleteAccount = ', source.indexOf('function ActionMenu('))
  const end = source.indexOf('  const runAction = ', start)
  assert.ok(start >= 0 && end > start)
  const state = { calls: 0, done: 0, toast: null, busy: null, confirmations: 0 }
  const deps = { acc: { id: 1, email: 'fixture@example.invalid' }, running,
    deletePendingRef: { current: false }, actionGenerationRef: { current: 0 }, setOpen() {},
    onActionStart: () => 1, onError: (_operation, error) => { state.toast = { type: 'error', text: error } },
    confirm: () => { state.confirmations++; return confirmed },
    setRunning: value => { state.busy = value }, setToast: value => { state.toast = value },
    onDelete: async () => { state.done++ }, apiFetch: (...args) => { state.calls++; return fetcher(...args) } }
  return { state, remove: new Function(...Object.keys(deps), compile(source.slice(start, end)) + '\nreturn deleteAccount')(...Object.values(deps)) }
}

test('row deletion handles cancellation, failure and active actions', async () => {
  const cancelled = deleteHandler(async () => ({}), false)
  await cancelled.remove()
  assert.equal(cancelled.state.calls, 0)
  const busy = deleteHandler(async () => ({}), true, 'refresh_token')
  await busy.remove()
  assert.equal(busy.state.confirmations, 0)
  const failed = deleteHandler(async () => { throw Error('Fixture deletion unavailable') })
  await assert.doesNotReject(failed.remove())
  assert.match(failed.state.toast.text, /Fixture deletion unavailable/)
  assert.equal(failed.state.done, 0)
  assert.equal(failed.state.busy, null)
})

test('row deletion cannot submit a second write while pending', async () => {
  let release
  const ui = deleteHandler(() => new Promise(resolve => { release = resolve }))
  const first = ui.remove(), second = ui.remove()
  assert.equal(ui.state.calls, 1)
  assert.equal(ui.state.confirmations, 1)
  release({ ok: true })
  await Promise.all([first, second])
  assert.equal(ui.state.done, 1)
  assert.equal(ui.state.busy, null)
})

function detailPatch(initial, draft) {
  const begin = source.indexOf('function DetailModal(')
  const start = source.indexOf('  const save = ', begin), end = source.indexOf('\n  return (', start)
  const state = { calls: [], saved: 0, error: '', busy: false }
  const deps = {
    form: draft, initialFormRef: { current: initial }, acc: { id: 7 },
    savePendingRef: { current: false },
    setSaving: value => { state.busy = value }, setError: value => { state.error = value },
    onSave: () => { state.saved++ },
    apiFetch: async (path, options) => { state.calls.push({ path, body: JSON.parse(options.body) }); return {} },
  }
  const save = new Function(...Object.keys(deps), compile(source.slice(start, end)) + '\nreturn save')(...Object.values(deps))
  return { save, state }
}

const originalDetail = { lifecycle_status: 'phone_required', primary_token: 'fixture-old', cashier_url: 'https://fixture.invalid/old' }

test('editing one detail field cannot write stale credential or lifecycle values', async () => {
  const ui = detailPatch(originalDetail, { ...originalDetail, cashier_url: 'https://fixture.invalid/user-choice' })
  await ui.save()
  assert.deepEqual(ui.state.calls, [{ path: '/accounts/7', body: { cashier_url: 'https://fixture.invalid/user-choice' } }])
  assert.equal(ui.state.saved, 1)
})

test('saving an unchanged detail form performs no write', async () => {
  const ui = detailPatch(originalDetail, { ...originalDetail })
  await ui.save()
  assert.deepEqual(ui.state.calls, [])
  assert.equal(ui.state.saved, 1)
  assert.equal(ui.state.busy, false)
})

test('intentionally clearing a detail field remains an explicit empty-string patch', async () => {
  const ui = detailPatch(originalDetail, { ...originalDetail, primary_token: '' })
  await ui.save()
  assert.deepEqual(ui.state.calls[0].body, { primary_token: '' })
})
