"""Close the root-result cache and UI publication races found during source review."""
from pathlib import Path
import os,shutil,subprocess
changed=[]
def once(s,old,new):
 assert s.count(old)==1,(old[:100],s.count(old))
 return s.replace(old,new,1)
def save(name,s):
 p=Path(name)
 if p.read_text(encoding='utf-8')==s:return
 backup=Path('aiTemp/Trash/refresh-review-before')/os.environ['GITHUB_RUN_ID']/name
 backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists() and not p.is_symlink()
 shutil.copy2(p,backup);p.write_text(s,encoding='utf-8');changed.append(name)
p='src-tauri/src/mcp/operation_store.rs';s=Path(p).read_text()
s=once(s,'    revision: u64,','    revision: u64,\n    roots_revision: Option<String>,')
s=once(s,'        let mut records = self','''        let roots_revision = match body.get("_workspace_roots_revision") {
            None => None,
            Some(value) => Some(value.as_str().filter(|s| s.len()==64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or("Invalid internal root revision")?.to_string()),
        };
        let mut records = self''') if s.count('        let mut records = self')==1 else s
# The admission lock is also used later; scope the insertion to admission only.
if 'let roots_revision = match' not in s:
 marker='        let mut records = self.records.lock().map_err(|_| "Operation store is unavailable")?;'
 if marker not in s:
  marker='''        let mut records = self
            .records
            .lock()
            .map_err(|_| "Operation store is unavailable")?;'''
 start=s.index('    pub fn admit(');end=s.index('    pub fn started(',start)
 part=s[start:end]
 part=once(part,marker,'''        let roots_revision = match body.get("_workspace_roots_revision") {
            None => None,
            Some(value) => Some(value.as_str().filter(|s| s.len()==64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or("Invalid internal root revision")?.to_string()),
        };
'''+marker)
 s=s[:start]+part+s[end:]
s=once(s,'            revision,','            revision,\n            roots_revision,')
start=s.index('    pub fn query(');body=s.index('        let object =',start)
s=s[:body]+'''        self.query_scoped(args,revision,permitted,None)
    }
    pub fn query_in_scope(&self,args:&Value,revision:u64,permitted:&[&str],roots_revision:&str)->Result<Value,String>{
        self.query_scoped(args,revision,permitted,Some(roots_revision))
    }
    fn query_scoped(&self,args:&Value,revision:u64,permitted:&[&str],roots_revision:Option<&str>)->Result<Value,String>{
'''+s[body:]
s=once(s,'r.revision == revision','r.revision == revision\n                    && roots_revision.is_none_or(|expected| r.roots_revision.as_deref()==Some(expected))')
save(p,s)
p='src-tauri/src/mcp/listener.rs';s=Path(p).read_text()
s=once(s,'    let revision = match mcp.current_policy_revision() {','    let revision = match mcp.current_policy_revision() {')
marker='    let recorded_body = json!({"id":request_id,"method":method,"params":{"name":tool_name}});'
s=once(s,marker,'''    let roots_revision = match mcp.for_request() {
        Ok(snapshot) => snapshot.workspace.roots_revision(),
        Err(_) => return (StatusCode::SERVICE_UNAVAILABLE,"Workspace roots unavailable; operation not admitted").into_response(),
    };
    let recorded_body = json!({"id":request_id,"method":method,"params":{"name":tool_name},"_workspace_roots_revision":roots_revision});''')
save(p,s)
p='src-tauri/src/tools/dispatch.rs';s=Path(p).read_text()
start=s.index('        "mcp_operation_status" =>');end=s.index('        "workflow_list"',start)
part=s[start:end]
assert '.query(' in part
part=part.replace('.query(','.query_in_scope(',1)
marker='&crate::tools::registry::exposed_tool_names(&ctx.tool_profile),'
if marker in part:part=once(part,marker,marker+'\n                &ctx.workspace.roots_revision(),')
else:part=once(part,'&crate::tools::registry::exposed_tool_names(&ctx.tool_profile))','&crate::tools::registry::exposed_tool_names(&ctx.tool_profile), &ctx.workspace.roots_revision())')
s=s[:start]+part+s[end:];save(p,s)
p='src/lib/components/RuntimePolicyForm.svelte';s=Path(p).read_text()
s=once(s,'Not applied; previous permissions remain. / 未套用，保留原有權限。','Save not confirmed; check current settings before retrying. / 儲存未確認，重試前先查看目前設定。')
save(p,s)
p='src/routes/+layout.svelte';s=Path(p).read_text()
start=s.index('  async function refreshWorkspaces()');status=s.index('    const mcpStates:',start);end=s.index('\n  async function addWorkspace()',status)
status_body=s[status:end]
# One writer owns workspace metadata. Runtime status is sampled initially, not every polling tick.
s=s[:start]+'''  let registryRefresh: ((invalidate?:boolean)=>Promise<void>) | null = null;
  async function refreshWorkspaces(){ await registryRefresh?.(true); }
  async function refreshInitialRuntimeStatus(){
    const items=$workspaces;
'''+status_body+s[end:]
s=once(s,'      workspaces.set(value.items);linkedProjectsByWorkspace.set(Object.fromEntries(value.linked));','      workspaces.set(value.items);linkedProjectsByWorkspace.set(Object.fromEntries(value.linked));\n      workspaceLoaded.set(true);workspaceLoadError.set("");')
s=once(s,'    const refresh=()=>{void registry.run(true);};','    registryRefresh=registry.run;\n    const refresh=()=>{void registry.run(true);};')
s=once(s,'try { await refreshWorkspaces(); workspaceLoaded.set(true); workspaceLoadError.set(""); }','try { await refreshWorkspaces(); await refreshInitialRuntimeStatus(); }')
s=once(s,'      registry.stop();clearInterval(poll);','      registryRefresh=null;registry.stop();clearInterval(poll);')
save(p,s)
for p in changed:
 if p.endswith('.rs'):subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',p],check=True)
subprocess.run(['git','add','--',*changed],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
print('REFRESH_REVIEW: root-scoped recovery results and a single metadata publisher; no extra permissions or replay')
