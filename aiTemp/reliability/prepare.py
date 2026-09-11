"""Materialize scoped reliability fixes after baseline failures; preserve originals."""
from pathlib import Path
import os, shutil, subprocess
changed=set()
def save(name,text):
    p=Path(name)
    if p.read_text(encoding='utf-8')==text:return
    backup=Path('aiTemp/Trash/reliability-before')/os.environ['GITHUB_RUN_ID']/name
    backup.parent.mkdir(parents=True,exist_ok=True)
    assert not backup.exists() and not p.is_symlink()
    shutil.copy2(p,backup);p.write_text(text,encoding='utf-8');changed.add(name)
def once(text,old,new):
    assert text.count(old)==1,(old[:100],text.count(old))
    return text.replace(old,new,1)
name='src-tauri/src/tools/sandbox_snapshot.rs';s=Path(name).read_text()
block='''    let id = uuid::Uuid::new_v4().to_string();
    let directory = runs.join(&id);
    fs::create_dir(&directory)?;
    let input = directory.join("input");
    let work = directory.join("work");
    fs::create_dir(&input)?;
    fs::create_dir(&work)?;
'''
s=once(s,block,'    // Validate and read the bounded input set before allocating a retained run.\n    let mut inputs = Vec::new();\n')
s=once(s,'''        if !seen.insert(name.to_lowercase()) {
            return Err(err("Duplicate input path"));
        }
''','')
s=once(s,'''        if !resolved.starts_with(root) {
            return Err(err("Input escaped the workspace"));
        }
''','''        if !resolved.starts_with(root) {
            return Err(err("Input escaped the workspace"));
        }
        if !seen.insert(resolved.to_string_lossy().to_lowercase()) {
            return Err(err("Duplicate input path"));
        }
''')
s=once(s,'''        let destination = input.join(relative);''','''        inputs.push((relative, content));
    }
'''+block+'''    // Never reopen an input after validation. All copies come from these
    // bounded buffers. A later destination-I/O failure remains retained evidence.
    for (relative, content) in inputs {
        let destination = input.join(relative);''')
save(name,s)
name='src/lib/control-center/state.ts';s=Path(name).read_text()
start=s.index('export async function readIntegration(');end=s.index('\nlet boardRefreshing',start)
s=s[:start]+'''// Each source owns a generation; discarded reads may finish but cannot publish.
const integrationGeneration:Record<Source,number>={paseo:0,anneal:0};
function snapshotEndpoint(source:Source,value:string):string {
 const u=new URL(value);
 if(source==='paseo'&&(u.pathname===''||u.pathname==='/'))u.pathname='/ws';
 return u.href;
}
export function clearIntegration(source:Source) {
 integrationGeneration[source]++;
 snapshots.update(v=>{const {[source]:_discarded,...next}=v;return next;});
 integrationErrors.update(v=>({...v,[source]:''}));
 integrationBusy.update(v=>({...v,[source]:false}));
}
let observedEndpoints=get(endpoints);
endpoints.subscribe(next=>{
 for(const source of ['paseo','anneal'] as const) {
  if(next[source]!==observedEndpoints[source])clearIntegration(source);
 }
 observedEndpoints={...next};
});
export async function readIntegration(source:Source,endpoint:string,credential:string) {
 if(get(integrationBusy)[source]||get(endpoints)[source]!==endpoint)return;
 const ticket=++integrationGeneration[source];
 const current=()=>ticket===integrationGeneration[source]&&get(endpoints)[source]===endpoint;
 snapshots.update(v=>{const {[source]:_discarded,...next}=v;return next;});
 integrationBusy.update(v=>({...v,[source]:true}));
 integrationErrors.update(v=>({...v,[source]:''}));
 try {
  const result=await invoke<Snapshot>('integration_read',{source,endpoint,credential:credential||null});
  if(!current())return;
  if(result.source!==source||result.read_only!==true||snapshotEndpoint(source,result.endpoint)!==snapshotEndpoint(source,endpoint)) {
   throw new Error('Integration response does not match this source/endpoint. / 整合回應與目前來源／端點不相符。');
  }
  snapshots.update(v=>({...v,[source]:result}));
 } catch(e) { if(current())integrationErrors.update(v=>({...v,[source]:String(e)})); }
 finally {if(current())integrationBusy.update(v=>({...v,[source]:false}));}
}
'''+s[end:]
save(name,s)
name='src/routes/integrations/+page.svelte';s=Path(name).read_text()
s=once(s,'{#if $snapshots[source]}<button type="button" class="cc-button ghost" disabled={$integrationBusy[source]} onclick={()=>clearIntegration(source)}','{#if $snapshots[source]||$integrationBusy[source]}<button type="button" class="cc-button ghost" onclick={()=>clearIntegration(source)}')
save(name,s)
name='src-tauri/src/tools/local_tools.rs';s=Path(name).read_text()
s=once(s,'                "workflow_list",','                "sandbox_status",\n                "sandbox_exec",\n                "mcp_operation_status",\n                "workflow_list",')
s=once(s,'"command_execution_boundary":"exec_command:policy_only; codex_command_exec:explicit_native_read_only_profile_no_model"','"command_execution_boundary":"exec_command:policy_only; codex_command_exec:explicit_native_read_only_profile_no_model; sandbox_exec:opt_in_offline_snapshot_appcontainer"')
save(name,s)
name='src-tauri/src/tools/registry_definitions.rs';s=Path(name).read_text()
s=once(s,'''                if name == crate::mcp::operation_store::TOOL {''','''                if name == "list_task_events" {
                    definition["outputSchema"] = crate::tools::event_output_schema::schema();
                }
                if name == crate::mcp::operation_store::TOOL {''')
save(name,s)
name='src-tauri/src/tools/mod.rs';s=Path(name).read_text()
s+='\npub(crate) mod event_output_schema;\n#[cfg(test)]\ninclude!(concat!(env!("CARGO_MANIFEST_DIR"), "/../aiTemp/reliability/metadata_contract.rs"));\n'
save(name,s)
name='src-tauri/src/tools/native_sandbox.rs';s=Path(name).read_text()
s+='\n#[cfg(test)]\ninclude!(concat!(env!("CARGO_MANIFEST_DIR"), "/../aiTemp/reliability/snapshot_contract.rs"));\n'
save(name,s)
for name in ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','README.md','README.en.md']:
 s=Path(name).read_text(encoding='utf-8');assert '0.4.4-rc.2' in s,name
 save(name,s.replace('0.4.4-rc.2','0.4.4-rc.3'))
changed.update(['src-tauri/src/tools/event_output_schema.rs','aiTemp/reliability/metadata_contract.rs','aiTemp/reliability/snapshot_contract.rs'])
for name in sorted(changed):
 if name.endswith('.rs'):subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*sorted(changed)],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('Scoped reliability patch applied; source validation, native isolation and timeout-recovery code retained.')
