import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
const source=readFileSync(new URL('../src/pages/Proxies.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n')
const taskSource=readFileSync(new URL('../src/lib/tasks.ts',import.meta.url),'utf8')
const helperJs=ts.transpileModule(taskSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const helpers=new Function('exports',helperJs+'\nreturn exports')({})

function actions(fetch, initial=null) {
  const state={task:initial,busy:false,error:'',calls:[]}
  const mountedRef={current:true},checkTaskIdRef={current:initial?.id||null}
  const code=ts.transpileModule(source.slice(source.indexOf('  const runMutation = '),source.indexOf('  const activeCount = ')),
    {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  const dependencies={
    mountedRef,checkTaskIdRef,mutatingRef:{current:false},checking:Boolean(initial),
    setMutating:value=>{state.busy=value},setError:value=>{state.error=value},
    setCheckTask:value=>{state.task=typeof value==='function'?value(state.task):value},
    newProxy:'',region:'',setNewProxy:()=>{},load:async()=>{},
    isTerminalTaskStatus:helpers.isTerminalTaskStatus,
    apiFetch:async(path,opts)=>{state.calls.push(path);return fetch(path,opts)},
  }
  const handlers=new Function(...Object.keys(dependencies),code+'\nreturn {check,cancelCheck}')(...Object.values(dependencies))
  return {...handlers,state,mountedRef,checkTaskIdRef}
}

test('duplicate proxy check clicks create one pending request and preserve authoritative task identity', async()=>{
  let release
  const ui=actions(()=>new Promise(resolve=>{release=resolve}))
  const first=ui.check(),second=ui.check()
  assert.equal(ui.state.calls.length,1)
  assert.equal(ui.state.busy,true)
  release({task_id:'fixture-proxy',status:'pending'})
  await Promise.all([first,second])
  assert.deepEqual(ui.state.task,{id:'fixture-proxy',status:'pending'})
  assert.equal(ui.state.busy,false)
})

test('a delayed proxy cancellation cannot downgrade terminal task state', async()=>{
  let release
  const ui=actions(()=>new Promise(resolve=>{release=resolve}),{id:'fixture-proxy',status:'running'})
  const pending=ui.cancelCheck()
  ui.state.task={id:'fixture-proxy',status:'cancelled'}
  release({status:'cancel_requested'})
  await pending
  assert.equal(ui.state.task.status,'cancelled')
})

test('proxy request failures release the button and remain visible', async()=>{
  const ui=actions(async()=>{throw new Error('Fixture unavailable')})
  await ui.check()
  assert.equal(ui.state.error,'Fixture unavailable')
  assert.equal(ui.state.busy,false)
  assert.equal(ui.state.task,null)
})

test('closed proxy page ignores delayed task creation without losing the server task', async()=>{
  let release
  const ui=actions(()=>new Promise(resolve=>{release=resolve}))
  const pending=ui.check()
  ui.mountedRef.current=false
  release({task_id:'fixture-proxy',status:'pending'})
  await pending
  assert.equal(ui.state.task,null)
  assert.equal(ui.checkTaskIdRef.current,null)
})
