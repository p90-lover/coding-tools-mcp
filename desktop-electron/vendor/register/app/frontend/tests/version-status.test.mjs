import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
const settings=readFileSync(new URL('../src/pages/SettingsPage.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n')
const banner=readFileSync(new URL('../src/components/UpdateBanner.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n')
const compile=code=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
function aboutFetch(response) {
  const start=settings.indexOf('  const fetchVersion = ',settings.indexOf('function AboutTab'))
  const end=settings.indexOf('\n\n  useEffect',start)
  const state={info:null,error:'',checking:false,paths:[]}
  const dependencies={setChecking:value=>{state.checking=value},setInfo:value=>{state.info=value},
    setError:value=>{state.error=value},apiFetch:async path=>{state.paths.push(path);return response()}}
  const fetch=new Function(...Object.keys(dependencies),compile(settings.slice(start,end))+'\nreturn fetchVersion')(...Object.values(dependencies))
  return {fetch,state}
}
test('About uses the actual version API and reports an unavailable release lookup',async()=>{
  const ui=aboutFetch(async()=>({current:'1.0',latest:null,has_update:false}))
  await ui.fetch()
  assert.deepEqual(ui.state.paths,['/version'])
  assert.ok(ui.state.error)
  assert.equal(ui.state.checking,false)
})
test('About fetch failures are visible rather than fabricated as current',async()=>{
  const ui=aboutFetch(async()=>{throw new Error('Fixture offline')})
  await ui.fetch()
  assert.ok(ui.state.error)
  assert.equal(ui.state.info,null)
})
test('a new version can appear after an earlier release was dismissed',async()=>{
  const start=banner.indexOf('  useEffect(() => {')
  const end=banner.indexOf('  }, [])',start)+'  }, [])'.length
  const state={dismissed:false,info:null,paths:[]}
  let tick,cleanup
  const replies=[{current:'1',latest:{tag:'2'},has_update:true},{current:'1',latest:{tag:'3'},has_update:true}]
  const deps={useEffect:effect=>{cleanup=effect()},DISMISS_KEY:'fixture-key',
    localStorage:{getItem:()=> '2'},setInterval:callback=>{tick=callback;return 1},clearInterval:()=>{},
    apiFetch:async path=>{state.paths.push(path);return replies.shift()},
    setDismissed:value=>{state.dismissed=value},setInfo:value=>{state.info=value}}
  new Function(...Object.keys(deps),compile(banner.slice(start,end)))(...Object.values(deps))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(state.dismissed,true)
  await tick()
  assert.equal(state.info.latest.tag,'3')
  assert.equal(state.dismissed,false)
  assert.ok(state.paths.every(path=>path==='/version'))
  cleanup()
})
