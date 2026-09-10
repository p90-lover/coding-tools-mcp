// Production state.ts; only Tauri IPC and minimal reactive-store boundaries are synthetic.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
function load() {
  const waiting=[];
  const writable=value=>{const listeners=new Set();const set=v=>{value=v;for(const fn of listeners)fn(v)};return {set,update:fn=>set(fn(value)),subscribe:fn=>{listeners.add(fn);fn(value);return ()=>listeners.delete(fn)}}};
  const get=store=>{let v;store.subscribe(x=>v=x)();return v};
  const exports={};
  const javascript=ts.transpileModule(fs.readFileSync('src/lib/control-center/state.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(javascript,{exports,require:name=>name==='svelte/store'?{writable,get}:{invoke:(command,args)=>new Promise((resolve,reject)=>waiting.push({command,args,resolve,reject}))},console});
  return {api:exports,waiting,get};
}
const result=(source,endpoint)=>({source,endpoint,checked_at:1,read_only:true,items:[],has_more:false,server_version:null});
test('each integration discards stale completions and errors after endpoint change or clear',async()=>{
  for(const source of ['paseo','anneal']) {
    const {api,waiting,get}=load();
    const old=get(api.endpoints)[source];
    const pending=api.readIntegration(source,old,'synthetic-credential');
    const next=source==='paseo'?'ws://127.0.0.1:6768/ws':'http://127.0.0.1:3001/';
    api.endpoints.update(v=>({...v,[source]:next}));
    waiting[0].resolve(result(source,old));await pending;
    assert.equal(get(api.snapshots)[source],undefined,'STALE_ENDPOINT_RESPONSE_WAS_PUBLISHED: '+source);
    const first=api.readIntegration(source,next,'');
    api.clearIntegration(source);
    const second=api.readIntegration(source,next,'');
    assert.equal(waiting.length,3,'clear should invalidate old request without blocking a fresh read');
    waiting[1].reject(new Error('old endpoint error'));await first;
    assert.equal(get(api.integrationBusy)[source],true,'old finally must not unset new request busy');
    assert.equal(get(api.integrationErrors)[source],'');
    waiting[2].resolve(result(source,next));await second;
    assert.equal(get(api.snapshots)[source].endpoint,next);
    const failed=api.readIntegration(source,next,'');waiting[3].reject(new Error('service offline'));await failed;
    assert.equal(get(api.snapshots)[source],undefined,'failed refresh must not show old success as connected');
    assert.match(get(api.integrationErrors)[source],/service offline/);
  }
});
