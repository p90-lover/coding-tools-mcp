import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
const source=readFileSync(new URL('../src/pages/Authenticator.tsx',import.meta.url),'utf8')
const js=ts.transpileModule(source,{compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText

function renderAt(timestamp,expiresAt,write=async()=>{}) {
  let clock=timestamp
  const notices=[]
  const entry={id:'fixture',issuer:'Fixture',label:'fixture@example.invalid',code:'0000000',
    period:30,remaining:1,expires_at:expiresAt,source:'vault',verified:null}
  const data={native:{status:'ready',message:'Fixture'},entries:[entry],fetched_at:expiresAt-1}
  const node=(type,props)=>({type,props})
  const exports={}
  const navigator={clipboard:{writeText:write}}
  const react={useEffect:()=>{},useState:initial=>[
    initial===null?data:typeof initial==='boolean'?false:typeof initial==='function'?initial():initial,
    value=>{if(typeof value==='string')notices.push(value)}]}
  const require=name=>name==='react'?react:name==='react/jsx-runtime'?{jsx:node,jsxs:node}:
    name==='@/components/ui/button'?{Button:'button'}:
    name==='@/lib/utils'?{cn:(...args)=>args.filter(Boolean).join(' '),apiFetch:()=>assert.fail('render contacted backend')}:
    new Proxy({},{get:(_,key)=>String(key)})
  new Function('require','exports','Date','navigator',js)(require,exports,{now:()=>clock},navigator)
  const tree=exports.default()
  const find=value=>{
    if(!value||typeof value!=='object')return null
    if(value.type==='button'&&value.props['aria-label']?.startsWith('复制 '))return value
    for(const child of [value.props?.children].flat(Infinity)){const result=find(child);if(result)return result}
    return null
  }
  return {button:find(tree),notices,advance:time=>{clock=time}}
}

test('a delayed near-expiry authenticator response cannot re-enable an expired code',()=>{
  const ui=renderAt(102000,101)
  assert.equal(ui.button.props.disabled,true)
})

test('copy rechecks actual expiry after a suspended countdown timer',async()=>{
  const writes=[]
  const ui=renderAt(100000,110,async code=>writes.push(code))
  assert.equal(ui.button.props.disabled,false)
  ui.advance(111000)
  ui.button.props.onClick()
  await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(writes,[])
  assert.ok(ui.notices.some(message=>message.includes('过期')))
})

test('a fresh authenticator snapshot permits copy and keeps denial feedback visible',async()=>{
  const writes=[]
  const fresh=renderAt(100000,125,async code=>writes.push(code))
  assert.equal(fresh.button.props.disabled,false)
  fresh.button.props.onClick()
  await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(writes,['0000000'])
  assert.ok(fresh.notices.some(message=>message.includes('已复制')))
  const denied=renderAt(100000,125,async()=>{throw new Error('Denied')})
  denied.button.props.onClick()
  await new Promise(resolve=>setImmediate(resolve))
  assert.ok(denied.notices.some(message=>message.includes('复制失败')))
})
