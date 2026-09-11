import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {get,writable} from 'svelte/store';

function harness() {
  const pending=[];
  const invoke=(command,args)=>new Promise((resolve,reject)=>pending.push({command,args,resolve,reject}));
  const text=fs.readFileSync('src/lib/control-center/state.ts','utf8');
  const code=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={};
  new Function('exports','require',code)(exports,(name)=>{
    if(name==='svelte/store')return {get,writable};
    if(name==='@tauri-apps/api/core')return {invoke};
    throw new Error('Unexpected runtime import '+name);
  });
  return {...exports,pending};
}
function snapshot(source,endpoint,id='fixture'){
  const url=new URL(endpoint); if(source==='paseo')url.pathname='/ws';
  return {source,endpoint:url.href,checked_at:123,read_only:true,items:[{id}],has_more:false,server_version:null};
}
test('reliability: cleared, retargeted, failed and mismatched integration reads cannot appear connected',async()=>{
  for(const source of ['paseo','anneal']){
    const h=harness(),a=get(h.endpoints)[source];
    const read=h.readIntegration(source,a,'synthetic-not-real');
    assert.equal(h.pending[0].command,'integration_read');
    h.clearIntegration(source);h.pending[0].resolve(snapshot(source,a));await read;
    assert.equal(get(h.snapshots)[source],undefined,'CLEARED_SNAPSHOT_RETURNED');
    assert.equal(get(h.integrationBusy)[source],false);

    const old=h.readIntegration(source,a,'');
    const b=a.replace(source==='paseo'?'6767':'3000',source==='paseo'?'6768':'3001');
    h.endpoints.update(v=>({...v,[source]:b}));
    const newer=h.readIntegration(source,b,'');
    assert.equal(h.pending.length,3,'Endpoint edit must allow a new read without waiting for the old endpoint');
    h.pending[1].reject(new Error('old server failed'));await old;
    assert.equal(get(h.integrationBusy)[source],true,'Old completion must not clear a newer busy state');
    assert.equal(get(h.integrationErrors)[source],'');
    h.pending[2].resolve(snapshot(source,b,'new'));await newer;
    assert.equal(get(h.snapshots)[source].items[0].id,'new');

    const failed=h.readIntegration(source,b,'');
    assert.equal(get(h.snapshots)[source],undefined,'A refresh must not leave a green stale snapshot');
    h.pending[3].reject(new Error('current server failed'));await failed;
    assert.equal(get(h.snapshots)[source],undefined);
    assert.ok(get(h.integrationErrors)[source]);

    const mismatched=h.readIntegration(source,b,'');
    h.pending[4].resolve(snapshot(source,a));await mismatched;
    assert.equal(get(h.snapshots)[source],undefined,'Wrong-endpoint response must be rejected');
    assert.ok(get(h.integrationErrors)[source]);

    const roundtrip=h.readIntegration(source,b,'');
    h.endpoints.update(v=>({...v,[source]:a}));h.endpoints.update(v=>({...v,[source]:b}));
    h.pending[5].resolve(snapshot(source,b,'stale-after-return'));await roundtrip;
    assert.equal(get(h.snapshots)[source],undefined,'Changing away and back must not revive an earlier read');
    assert.ok(h.pending.every(p=>p.command==='integration_read'),'Only observation IPC is exercised');
  }
  console.log('RELIABILITY_UI: real Svelte stores; actual state.ts; synthetic Tauri IPC; no provider or daemon invoked');
});
