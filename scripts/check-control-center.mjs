import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';
import * as stores from 'svelte/store';
// Evaluate only pure modules; no agent/runtime packages are loaded.
const modules = new Map();
function load(path,mocks,globals={}){
 path=resolve(path);
 if(!mocks&&modules.has(path))return modules.get(path);
 const exports={};const context={exports,URL,...globals,require:(specifier)=>mocks&&Object.hasOwn(mocks,specifier)?mocks[specifier]:load(resolve(dirname(path),specifier+'.ts'))};
 const out=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
 vm.runInNewContext(out.outputText,context,{filename:path});if(!mocks)modules.set(path,exports);return exports;
}
const model=load(resolve('src/lib/control-center/model.ts'));
const row={id:'a',title:'Existing agent',status:'idle',provider:'codex',workspace:'x',pending_permissions:0,requires_attention:false,attention_reason:'permission',chain_index:null,chain_layer:null,chain_name:null,chain_id:null};
assert.equal(model.agentBucket(row),'needs_input');assert.equal(model.attention(row),true);
assert.equal(model.agentBucket({...row,status:'new-unknown-state'}),'unknown');
assert.equal(model.stateTone('idle'),'neutral');
assert.equal(model.stateTone('DOING'),'blue');
assert.equal(model.stateTone('REVIEW'),'amber');
assert.equal(model.stateTone('DONE'),'green');
assert.equal(model.attention({...row,status:'REVIEW',attention_reason:null}),true);
assert.equal(model.sortAgents([{...row,id:'b',status:'running',attention_reason:null},row])[0].id,'a');
const chain=model.sortChain([{...row,id:'z',chain_id:'x',chain_index:1,chain_layer:3},{...row,id:'a',chain_id:'x',chain_index:9,chain_layer:0}]);
assert.equal(chain[0].id,'a');assert.equal(model.STEPS.length,12);assert.equal(model.stepLabel(12,'zh-Hant'),'已完成');

// Exercise the actual state module with real Svelte stores and deferred IPC only.
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function stateModule(invoke){
 let writes=0;
 const state=load(resolve('src/lib/control-center/state.ts'),{'svelte/store':stores,'@tauri-apps/api/core':{invoke}},
  {localStorage:{getItem:()=>null,setItem:()=>{writes++;}}});
 return {state,writes:()=>writes};
}
const endpoint='ws://127.0.0.1:6768/ws';
function liveRow(label,address=endpoint,source='paseo'){return {
 source,endpoint:address,web_ui:'http://127.0.0.1:6768/',status:'connected',keep_alive:false,stale:false,
 last_ok_at:1,last_error:null,reconnect_attempts:0,web_ui_reachable:true,banner:null,health:null,model_count:null,owned_process:false,credential_needed:false,
 snapshot:{source,endpoint:address,checked_at:1,read_only:true,items:[],has_more:false,server_version:label},
};}
{
 let reads=0;const rows=[liveRow('normal'),{...liveRow('other'),source:'commandcode',snapshot:null}];
 const fixture=stateModule(async command=>{assert.equal(command,'integration_live_status');reads++;return rows;});
 for(let index=0;index<10;index++)await fixture.state.refreshLive();
 assert.equal(stores.get(fixture.state.liveStatus),rows);
 assert.equal(stores.get(fixture.state.snapshots).paseo,rows[0].snapshot);
 assert.equal(reads,10);assert.equal(fixture.writes(),0);
 fixture.state.changeLanguage();assert.equal(fixture.writes(),1);
}
{
 const old=deferred();const commands=[];let reads=0;
 const {state}=stateModule(async command=>{
  commands.push(command);
  if(command==='integration_live_status')return ++reads===1?old.promise:[];
  assert.equal(command,'integration_live_disconnect');
 });
 const pending=state.refreshLive();
 await state.disconnectLive('paseo');
 assert.equal(stores.get(state.liveStatus).length,0);
 old.resolve([liveRow('before-disconnect')]);await pending;
 assert.equal(stores.get(state.liveStatus).length,0,'late poll must not revive a disconnected owner');
 assert.equal(stores.get(state.snapshots).paseo,undefined);
 assert.deepEqual(commands,['integration_live_status','integration_live_disconnect','integration_live_status']);
}
for(const action of ['connect','disconnect']){
 const transition=deferred(),during=deferred(),after=deferred(),afterIssued=deferred();let reads=0;
 const current=liveRow('after-transition');
 const {state}=stateModule(command=>{
  if(command===`integration_live_${action}`)return transition.promise;
  assert.equal(command,'integration_live_status');
  if(++reads===1)return during.promise;
  afterIssued.resolve();return after.promise;
 });
 const changing=action==='connect'?state.connectLive('paseo',endpoint,'http://127.0.0.1:6768/','',false,false):state.disconnectLive('paseo');
 const polling=state.refreshLive();
 transition.resolve();await afterIssued.promise;
 during.resolve([liveRow('before-transition')]);await polling;
 assert.equal(stores.get(state.liveStatus).length,0,`a poll admitted during ${action} must not publish after the transition completes`);
 assert.equal(stores.get(state.snapshots).paseo,undefined);
 after.resolve(action==='connect'?[current]:[]);await changing;
 assert.equal(stores.get(state.liveStatus).length,action==='connect'?1:0);
 assert.equal(stores.get(state.snapshots).paseo,action==='connect'?current.snapshot:undefined);
 assert.equal(reads,2);
}
{
 const polls=[deferred(),deferred(),deferred()];let reads=0;
 const {state}=stateModule(command=>{assert.equal(command,'integration_live_status');return polls[reads++].promise;});
 const pending=[state.refreshLive(),state.refreshLive(),state.refreshLive()];
 for(let index=0;index<polls.length;index++){
  const current=liveRow(`slow-poll-${index}`);polls[index].resolve([current]);await pending[index];
  assert.equal(stores.get(state.liveStatus)[0],current,'a completed current-owner poll must publish while later polls are pending');
  assert.equal(stores.get(state.snapshots).paseo,current.snapshot);
 }
 assert.equal(reads,3);
}
{
 const older=deferred(),newer=deferred();const polls=[older,newer];
 const {state}=stateModule(command=>{assert.equal(command,'integration_live_status');return polls.shift().promise;});
 const first=state.refreshLive(),second=state.refreshLive();const current=liveRow('newer-poll');
 newer.resolve([current]);await second;older.resolve([liveRow('older-poll')]);await first;
 assert.equal(stores.get(state.liveStatus)[0],current);
 assert.equal(stores.get(state.snapshots).paseo,current.snapshot);
}
{
 const older=deferred();let reads=0;const current=liveRow('new-A-owner');
 const {state}=stateModule(command=>{assert.equal(command,'integration_live_status');return ++reads===1?older.promise:Promise.resolve([current]);});
 const pending=state.refreshLive();
 state.endpoints.update(value=>({...value,paseo:'ws://127.0.0.1:7777/ws'}));
 state.endpoints.update(value=>({...value,paseo:endpoint}));
 await state.refreshLive();older.resolve([liveRow('old-A-owner')]);await pending;
 assert.equal(stores.get(state.liveStatus)[0],current,'A/B/A must retain the new connection intent');
 assert.equal(stores.get(state.snapshots).paseo,current.snapshot);
}
for(const outcome of ['resolve','reject']){
 const older=deferred(),newer=deferred();const connects=[older,newer];let reads=0;
 const current=liveRow('reconnected');
 const {state}=stateModule(command=>{
  if(command==='integration_live_connect')return connects.shift().promise;
  assert.equal(command,'integration_live_status');reads++;return Promise.resolve([current]);
 });
 const first=state.connectLive('paseo',endpoint,'http://127.0.0.1:6768/','',false,false);
 const second=state.connectLive('paseo',endpoint,'http://127.0.0.1:6768/','',false,false);
 if(outcome==='resolve')older.resolve();else older.reject(new Error('obsolete connection failure'));
 await first;
 assert.equal(stores.get(state.integrationBusy).paseo,true,'obsolete completion must not clear the newer busy state');
 assert.equal(stores.get(state.integrationErrors).paseo,'');assert.equal(reads,0);
 newer.resolve();await second;
 assert.equal(stores.get(state.liveStatus)[0],current);assert.equal(stores.get(state.integrationBusy).paseo,false);assert.equal(reads,1);
}
{
 const connect=deferred();let reads=0;
 const {state}=stateModule(command=>{
  if(command==='integration_live_connect')return connect.promise;
  if(command==='integration_live_disconnect')return Promise.resolve();
  assert.equal(command,'integration_live_status');reads++;return Promise.resolve([]);
 });
 const pending=state.connectLive('paseo',endpoint,'http://127.0.0.1:6768/','',false,false);
 await state.disconnectLive('paseo');connect.resolve();await pending;
 assert.equal(stores.get(state.liveStatus).length,0);assert.equal(stores.get(state.snapshots).paseo,undefined);
 assert.equal(stores.get(state.integrationBusy).paseo,false);assert.equal(reads,1);
}
{
 const fixture=stateModule(async command=>{assert.equal(command,'integration_live_connect');throw new Error('current connection failure');});
 await fixture.state.connectLive('paseo',endpoint,'http://127.0.0.1:6768/','',false,false);
 assert.match(stores.get(fixture.state.integrationErrors).paseo,/current connection failure/);
 assert.equal(stores.get(fixture.state.integrationBusy).paseo,false);assert.equal(fixture.writes(),0);
}
{
 const {state}=stateModule(async command=>{assert.equal(command,'integration_live_status');return [liveRow('other-endpoint')];});
 state.endpoints.update(value=>({...value,paseo:'ws://127.0.0.1:7777/ws'}));
 await state.refreshLive();
 assert.equal(stores.get(state.snapshots).paseo,undefined,'a live connection must not replace another endpoint draft snapshot');
}
{
 const valid=liveRow('valid-anneal','http://127.0.0.1:3000/','anneal');
 const {state}=stateModule(async command=>{assert.equal(command,'integration_live_status');return [liveRow('paseo-old'),valid];});
 state.endpoints.update(value=>({...value,paseo:'an endpoint still being edited'}));
 await state.refreshLive();
 assert.equal(stores.get(state.snapshots).paseo,undefined);
 assert.equal(stores.get(state.snapshots).anneal,valid.snapshot,'an invalid draft must not suppress another source snapshot');
}
const backend=fs.readFileSync('src-tauri/src/integrations/mod.rs','utf8').split('#[cfg(test)]')[0];
assert.equal(/Command::|\.post\(|\.put\(|\.delete\(|create_agent|send_message|resume_agent/.test(backend),false);
const actions=fs.readFileSync('src-tauri/src/integrations/actions.rs','utf8');
assert.ok(actions.includes('send_agent_message_request'));
assert.ok(actions.includes('/tasks/{id}/start'));
assert.ok(actions.includes('/inbox/messages/{id}/decision'));
assert.equal(actions.includes('shutdown_server_request'), false);
assert.equal(actions.includes('merge-tail'), false);
const page=fs.readFileSync('src/routes/integrations/+page.svelte','utf8');
assert.ok(page.includes('PaseoPanel'));
assert.ok(page.includes('AnnealPanel'));
assert.equal(page.includes('Read-only adapters'), false);
assert.ok(fs.readFileSync('src/lib/components/control-center/PaseoPanel.svelte','utf8').includes('/sessions'));
assert.ok(fs.readFileSync('src/lib/components/control-center/AnnealPanel.svelte','utf8').includes('#/tasks'));
assert.ok(page.includes('CommandCode login is in CPA Accounts'));
assert.equal(page.includes('CommandCodeProxyPanel'),false);
assert.equal(fs.existsSync('src/lib/components/control-center/CommandCodeProxyPanel.svelte'),false);
assert.ok(fs.readFileSync('src-tauri/src/integrations/lease.rs','utf8').includes('PASEO_STALE_SECS'));
const state=fs.readFileSync('src/lib/control-center/state.ts','utf8');
assert.equal(state.match(/localStorage.setItem\([^;]+/g).length,1);assert.ok(state.includes("'control-center-locale'"));
assert.ok(state.includes('refreshLive'));
console.log('PASS: live reply/connection ownership; passive refresh storage; upstream status/ordering; allowlist; keep-alive contracts');
