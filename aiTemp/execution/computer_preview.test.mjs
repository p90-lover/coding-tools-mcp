import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
// Execute the actual component function with synthetic IPC, never produce pixels.
const source=fs.readFileSync('src/lib/components/ComputerOverlay.svelte','utf8');
const code=source.slice(source.indexOf('  async function preview()'),source.indexOf('  async function stop()'));
assert(code.includes('computer_local_preview'));
const run=new Function('invoke','status','mode','document',`let liveFrame=null,message='',previewEpoch=0,disposed=false; ${code}; return preview();`);
test('longrun: exact-agent view, hidden monitor and active input do not compete for screenshots',async()=>{
 for(const [mode,hidden,state,action,expected] of [['agent',false,'active',null,0],['live',true,'active',null,0],['live',false,'active','click',0],['live',false,'paused',null,0],['live',false,'active',null,1]]){
  let calls=0;
  await run(async name=>{assert.equal(name,'computer_local_preview');calls++;return {fixture:'not an image'};},{state,action,session_id:'owned'},mode,{hidden});
  assert.equal(calls,expected,'UNNECESSARY_COMPUTER_PREVIEW_CAPTURE '+JSON.stringify({mode,hidden,state,action}));
 }
 console.log('COMPUTER_PREVIEW_PASS: actual overlay preview function skips non-live/hidden/busy/paused capture; no native input or screenshot used');
});
