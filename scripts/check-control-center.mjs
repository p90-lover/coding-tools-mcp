import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';
// Evaluate only pure modules; no agent/runtime packages are loaded.
const modules = new Map();
function load(path){
 path=resolve(path);
 if(modules.has(path))return modules.get(path);
 const exports={};const context={exports,require:(specifier)=>load(resolve(dirname(path),specifier+'.ts'))};
 const out=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
 vm.runInNewContext(out.outputText,context,{filename:path});modules.set(path,exports);return exports;
}
const model=load(resolve('src/lib/control-center/model.ts'));
const row={id:'a',title:'Existing agent',status:'idle',provider:'codex',workspace:'x',pending_permissions:0,requires_attention:false,attention_reason:'permission',chain_index:null,chain_layer:null,chain_name:null,chain_id:null};
assert.equal(model.agentBucket(row),'needs_input');assert.equal(model.attention(row),true);
assert.equal(model.agentBucket({...row,status:'new-unknown-state'}),'unknown');
assert.equal(model.stateTone('idle'),'neutral');
assert.equal(model.sortAgents([{...row,id:'b',status:'running',attention_reason:null},row])[0].id,'a');
const chain=model.sortChain([{...row,id:'z',chain_id:'x',chain_index:1,chain_layer:3},{...row,id:'a',chain_id:'x',chain_index:9,chain_layer:0}]);
assert.equal(chain[0].id,'a');assert.equal(model.STEPS.length,12);assert.equal(model.stepLabel(12,'zh-Hant'),'已完成');
const backend=fs.readFileSync('src-tauri/src/integrations/mod.rs','utf8').split('#[cfg(test)]')[0];
assert.equal(/Command::|\.post\(|\.put\(|\.delete\(|create_agent|send_message|resume_agent/.test(backend),false);
const state=fs.readFileSync('src/lib/control-center/state.ts','utf8');
assert.equal(state.match(/localStorage.setItem\([^;]+/g).length,1);assert.ok(state.includes("'control-center-locale'"));
console.log('PASS: upstream status/ordering semantics; explicit checklist states; read-only adapter and memory-only credential paths');
