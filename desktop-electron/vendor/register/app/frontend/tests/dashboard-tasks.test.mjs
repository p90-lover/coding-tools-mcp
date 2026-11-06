import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
const dashboard=readFileSync(new URL('../src/pages/Dashboard.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n')
const history=readFileSync(new URL('../src/pages/TaskHistory.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n')
const compile=code=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText

function loader(source,fetcher,isDashboard=false) {
  const begin=source.indexOf('  const load = ')
  const end=source.indexOf('\n\n  useEffect',begin)
  const state={rows:[],stats:null,desktops:{},loading:false,error:'',total:0,pagination:null}
  const currentQueryRef={current:{platform:'grok',status:'',page:2,key:'grok-page-2',filterKey:'grok'}}
  const deps={useCallback:fn=>fn,mountedRef:{current:true},loadRequestRef:{current:0},
    currentQueryRef,platform:'grok',status:'',page:2,
    desktopPlatforms:['cursor','kiro','chatgpt'],
    getPlatforms:async()=>[{name:'chatgpt',display_name:'ChatGPT'}],apiFetch:fetcher,
    setLoading:value=>{state.loading=value},setError:value=>{state.error=value},
    setStats:value=>{state.stats=value},setDesktopStates:value=>{state.desktops=value},
    setTasks:value=>{state.rows=value},setTotal:value=>{state.total=value},
    setPagination:value=>{state.pagination=value}}
  const load=new Function(...Object.keys(deps),compile(source.slice(begin,end))+'\nreturn load')(...Object.values(deps))
  return {load,state,currentQueryRef}
}

test('dashboard failed statistics are reported and desktop probes can still finish',async()=>{
  const ui=loader(dashboard,async path=>{
    if(path==='/accounts/stats')throw new Error('Fixture statistics unavailable')
    return {available:true,installed:true}
  },true)
  await ui.load()
  assert.match(ui.state.error,/Fixture statistics unavailable/)
  assert.equal(ui.state.loading,false)
  assert.equal(ui.state.desktops.chatgpt.installed,true)
})

test('a late dashboard refresh cannot replace a newer statistics snapshot',async()=>{
  const pending=[]
  const ui=loader(dashboard,async path=>path==='/accounts/stats'
    ?new Promise(resolve=>pending.push(resolve)):{available:true},true)
  const old=ui.load(),fresh=ui.load()
  pending[1]({total:2});await fresh
  pending[0]({total:1});await old
  assert.equal(ui.state.stats.total,2)
})

test('dashboard expired and invalid card counts each display status once',()=>{
  const start=dashboard.indexOf('  const statCards = ')
  const end=dashboard.indexOf('  const platformEntries = ',start)
  const cards=new Function('stats','Users','Clock','CheckCircle','XCircle',
    compile(dashboard.slice(start,end))+'\nreturn statCards')(
      {total:1,by_display_status:{expired:1},by_validity_status:{invalid:1}},null,null,null,null)
  assert.equal(cards.find(card=>card.label==='已失效').value,1)
})


test('dashboard counters distinguish unavailable statistics from confirmed zero values', () => {
  const start = dashboard.indexOf('  const statCards = ')
  const end = dashboard.indexOf('  const platformEntries = ', start)
  const cards = new Function('stats', 'Users', 'Clock', 'CheckCircle', 'XCircle',
    compile(dashboard.slice(start, end)) + '\nreturn statCards')
  assert.deepEqual(cards(null, null, null, null, null).map(card => card.value), ['-', '-', '-', '-'])
  assert.deepEqual(cards({total: 0}, null, null, null, null).map(card => card.value), [0, 0, 0, 0])
  assert.deepEqual(cards({total: 7, by_plan_state: {trial: 2, subscribed: 3},
    by_display_status: {expired: 1, invalid: 1}}, null, null, null, null).map(card => card.value), [7, 2, 3, 2])
})

test('dashboard distributions report loading and unavailability before showing confirmed empty data', () => {
  const start = dashboard.indexOf('  const renderStatusGroup = ')
  const end = dashboard.indexOf('\n  return (', start)
  const code = ts.transpileModule(dashboard.slice(start, end), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React},
    fileName: 'Dashboard.tsx',
  }).outputText
  const React = {createElement: (type, props, ...children) => ({type, props, children})}
  const render = (stats, loading, values) => {
    const group = new Function('stats', 'loading', 'React', 'Badge', 'STATUS_VARIANT', 'STATUS_LABELS',
      code + '\nreturn renderStatusGroup')(stats, loading, React, 'badge', {}, {})
    const strings = node => Array.isArray(node) ? node.flatMap(strings)
      : node && typeof node === 'object' ? strings(node.children)
      : typeof node === 'string' || typeof node === 'number' ? [String(node)] : []
    return strings(group('Fixture group', values, 'Fixture confirmed empty'))
  }
  assert.deepEqual(render(null, true), ['Fixture group', '正在加载统计数据...'])
  assert.deepEqual(render(null, false), ['Fixture group', '统计数据不可用，请点击刷新重试'])
  assert.deepEqual(render({total: 0}, false), ['Fixture group', 'Fixture confirmed empty'])
  assert.deepEqual(render({total: 1}, false, {trial: 0}), ['Fixture group', 'trial', '0'])
})

test('history uses the chosen page and current filters in retained refresh handlers',async()=>{
  const requests=[]
  const ui=loader(history,async path=>{requests.push(path);return {total:135,items:[{id:'fixture'}]}})
  await ui.load()
  assert.equal(new URLSearchParams(requests[0].split('?')[1]).get('page'),'2')
  ui.currentQueryRef.current={platform:'chatgpt',status:'pending',page:1,key:'new',filterKey:'new'}
  await ui.load()
  const query=new URLSearchParams(requests.at(-1).split('?')[1])
  assert.equal(query.get('platform'),'chatgpt')
  assert.equal(query.get('status'),'pending')
})

test('history ignores obsolete responses without releasing a newer loading request',async()=>{
  const pending=[]
  const ui=loader(history,()=>new Promise(resolve=>pending.push(resolve)))
  const old=ui.load()
  ui.currentQueryRef.current={...ui.currentQueryRef.current,page:3,key:'grok-page-3'}
  const fresh=ui.load()
  pending[0]({total:135,items:[{id:'old'}]});await old
  assert.equal(ui.state.loading,true)
  pending[1]({total:135,items:[{id:'new'}]});await fresh
  assert.deepEqual(ui.state.rows,[{id:'new'}])
})

test('history failure is visible and an empty final page clamps to the remaining page',async()=>{
  const failed=loader(history,async()=>{throw new Error('Fixture history unavailable')})
  await failed.load()
  assert.equal(failed.state.error,'Fixture history unavailable')
  assert.equal(failed.state.loading,false)
  const clamped=loader(history,async()=>({items:[],total:50}))
  await clamped.load()
  assert.deepEqual(clamped.state.pagination,{key:'grok',page:1})
})

const formatTaskError = new Function(
  compile(history.slice(history.indexOf('function formatError'), history.indexOf('\n\nexport default')))
  + '\nreturn formatError'
)()

test('task history renders nested API errors as bounded text', () => {
  for (const [input, expected] of [
    [JSON.stringify({ error: { message: 'Fixture nested failure', code: 'fixture' } }), 'Fixture nested failure'],
    [JSON.stringify({ message: { text: 'Fixture object message' } }), '{"text":"Fixture object message"}'],
    [JSON.stringify({ detail: { message: 'Fixture detail' } }), '{"message":"Fixture detail"}'],
    [JSON.stringify({ errors: [null] }), '{"errors":[null]}'],
    ['Fixture plain failure', 'Fixture plain failure'],
    ['', ''],
  ]) {
    assert.equal(formatTaskError(input), expected)
  }
  const long = formatTaskError(JSON.stringify({ error: { message: 'x'.repeat(500) } }))
  assert.equal(typeof long, 'string')
  assert.equal(long.length, 103)
})

test('changing or clearing task filters never resurrects an old page', () => {
  const component = ts.transpileModule(history, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText
  for (const action of ['platform', 'status', 'clear']) {
    const states = [[], action === 'status' ? '' : 'chatgpt', action === 'platform' ? '' : 'failed',
      [], false, '', 115, { key: JSON.stringify(['', '']), page: 3 }]
    let hook = 0
    const react = {
      useState: () => {
        const index = hook++
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
      },
      useEffect() {}, useRef: current => ({ current }), useCallback: callback => callback,
    }
    const node = (type, props) => ({ type, props })
    const exported = {}
    const require = name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: node, jsxs: node }
      : name === '@/components/ui/button' ? { Button: 'button' }
      : name === '@/components/ui/badge' ? { Badge: 'span' }
      : name === '@/lib/utils' ? { apiFetch: () => assert.fail('render contacted backend') }
      : name === '@/lib/app-data' ? { getPlatforms: () => assert.fail('render loaded metadata') }
      : name === '@/lib/tasks' ? { TASK_STATUS_VARIANTS: {}, getTaskStatusText: value => value }
      : new Proxy({}, { get: (_, key) => String(key) })
    new Function('require', 'exports', component)(require, exported)
    const find = value => {
      if (!value || typeof value !== 'object') return null
      const props = value.props || {}
      if (action === 'clear' ? value.type === 'button' && props.children === '清除筛选'
        : props['aria-label'] === (action === 'platform' ? '任务平台筛选' : '任务状态筛选')) return value
      for (const child of [props.children].flat(Infinity)) { const result = find(child); if (result) return result }
      return null
    }
    const control = find(exported.default())
    assert.ok(control, action)
    if (action === 'clear') control.props.onClick()
    else control.props.onChange({ target: { value: '' } })
    const key = JSON.stringify([states[1], states[2]])
    const page = states[7].key === key ? states[7].page : 1
    assert.equal(page, 1, action)
  }
})


