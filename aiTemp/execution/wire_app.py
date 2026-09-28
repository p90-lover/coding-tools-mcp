"""Integrate new execution modules without changing transport/auth/computer grants."""
from pathlib import Path
import os,shutil,subprocess
changed=[]
def save(name,text):
 p=Path(name)
 if p.read_text(encoding='utf-8')==text:return
 if name not in changed:
  backup=Path('aiTemp/Trash/execution-wire')/os.environ['GITHUB_RUN_ID']/name
  backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists() and not p.is_symlink();shutil.copy2(p,backup);changed.append(name)
 p.write_text(text,encoding='utf-8')
def once(name,old,new):
 text=Path(name).read_text(encoding='utf-8')
 if new in text:return
 assert text.count(old)==1,(name,old[:100],text.count(old));save(name,text.replace(old,new,1))
once('src-tauri/src/integrations/mod.rs','pub mod board;','pub mod execution;\npub mod board;')
p='src-tauri/src/integrations/execution/mod.rs';text=Path(p).read_text()
for name in ['book','observation','service','schema']:
 if f'pub mod {name};' not in text:text+=f'\npub mod {name};\n'
save(p,text)
once('src-tauri/src/data/model.rs','pub struct AppData {','pub struct AppData {\n    #[serde(default)]\n    pub execution_book: crate::integrations::execution::book::Book,')
once('src-tauri/src/data/migrate.rs','fn suspend_recovered_permissions(data: &mut AppData) {','fn suspend_recovered_permissions(data: &mut AppData) {\n    data.execution_book.suspend_recovered();')
p='src-tauri/src/data/migrate.rs';text=Path(p).read_text()
if 'fn current_test_file()' not in text:save(p,text+'\n#[cfg(test)]\npub(crate) fn current_test_file()->Option<PathBuf>{ TEST_DATA_FILE.with(|v|v.borrow().clone()) }\n')
once('src-tauri/src/data/mod.rs','pub(crate) use migrate::with_test_file;','pub(crate) use migrate::{with_test_file,current_test_file};')
p='src-tauri/src/tools/workflow.rs'
once(p,'    include_archived: bool,','    include_archived: bool,\n    mission_id: Option<String>,\n    refresh_source: bool,')
once(p,'            include_archived: false,','            include_archived: false,\n            mission_id: None,\n            refresh_source: false,')
once(p,'pub fn input_schema(name: &str) -> Value {','fn base_input_schema(name: &str) -> Value {')
once(p,'pub fn call(ctx: &ToolContext, name: &str, args: &Value)', '''pub fn input_schema(name:&str)->Value {
    crate::integrations::execution::schema::extend(name,base_input_schema(name))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionWrite {expected_revision:u64,change:crate::integrations::execution::service::Change}
pub fn call(ctx: &ToolContext, name: &str, args: &Value)''')
once(p,'''                    r.include_archived,
                )
            })''','''                    r.include_archived,
                )
            }).and_then(|mut view| {
                let execution = if r.refresh_source {
                    let mission=r.mission_id.as_deref().ok_or_else(||AppError::Message("Source refresh requires a mission ID".into()))?;
                    crate::integrations::execution::service::refresh(ctx,mission)?
                } else {
                    crate::integrations::execution::service::view(ctx,r.mission_id.as_deref())?
                };
                view["execution"]=execution;Ok(view)
            })''')
once(p,'''            let r: Write = serde_json::from_value(clean).map_err(|_| {''','''            if clean.pointer("/change/operation").and_then(Value::as_str).is_some_and(|v|v.starts_with("agent_")) {
                let request:ExecutionWrite=serde_json::from_value(clean).map_err(|_|WorkspaceError::invalid_argument("Invalid scoped agent operation"))?;
                return crate::integrations::execution::service::change(ctx,request.expected_revision,request.change)
                    .map(|value|tool_ok(json!({"execution":value})))
                    .map_err(|e|WorkspaceError::Tool {code:"AGENT_CONTROL_REJECTED",message:e.to_string(),category:"execution",retryable:false});
            }
            let r: Write = serde_json::from_value(clean).map_err(|_| {''')
p='src-tauri/src/tools/approval.rs'
once(p,'        "exec_command" => {','''        "workflow_update" if args.pointer("/change/operation").and_then(Value::as_str)==Some("agent_control")
            && matches!(args.pointer("/change/action").and_then(Value::as_str),Some("create"|"start"|"resume")) => Some(ApprovalRisk::Network),
        "exec_command" => {''')
p='src-tauri/src/tools/registry_definitions.rs'
once(p,'Read paged local board tasks for this listener\'s workspace, including human attestations and distinct MCP observations. No model calls.', 'Read this workspace\'s board and durable agent missions. Optional refresh_source performs observation only; it never resubmits a mission. Credentials and provider consent are configured locally.')
once(p,'Create, move, edit, archive, restore or observe a task at an expected board revision. Cannot complete human review steps or access other workspaces; no model calls.", false, false, false', 'Update scoped board records, prepare a mission, control its owned Paseo or Anneal record, or attest an independent review. Agent create/start/resume can invoke a separately approved external provider and consume quota. Local provider consent is required; no credential or endpoint is accepted from MCP. Uncertain operations are never automatically replayed.", false, false, true')
once('src-tauri/src/commands/mod.rs','mod task_monitor;','mod execution;\npub use execution::{execution_local_read,execution_local_provider,execution_local_update};\nmod task_monitor;')
once('src-tauri/src/lib.rs','use commands::{','use commands::{\n    execution_local_read,execution_local_provider,execution_local_update,')
once('src-tauri/src/lib.rs','            task_monitor_read,','            task_monitor_read,\n            execution_local_read,execution_local_provider,execution_local_update,')
p='src/lib/components/AppShell.svelte'
once(p,"{path:'/sessions',en:'Agent sessions'","{path:'/missions',en:'Mission control',zh:'任務協調',icon:Layers},{path:'/sessions',en:'Agent sessions'")
once(p,"translated($locale,'Local tools only','僅本機工具')","translated($locale,'Local permission boundaries','本機權限邊界')")
once(p,"translated($locale,'No provider-agent launch','不啟動供應商 Agent')","translated($locale,'Provider execution needs consent','供應商執行須明確批准')")
# The isolated core fixture intentionally excludes service.rs, which is covered
# through the real AppData/dispatcher in Desktop tests rather than fake types.
p='aiTemp/execution/probe.py';text=Path(p).read_text();start=text.index("(out/'src/lib.rs').write_text(");end=text.index('\nresult=subprocess.run',start)
text=text[:start]+'''modules='pub mod execution {\\n'
for name in ['model','protocol','transport','book','observation']:
 p=root/('src-tauri/src/integrations/execution/'+name+'.rs')
 if p.exists():modules+='#[path="'+p.as_posix()+'"]pub mod '+name+';\\n'
modules+='}\\n#[cfg(test)]mod contracts {use crate::execution;include!("'+(root/'aiTemp/execution/contracts.rs').as_posix()+'");}\\n'
(out/'src/lib.rs').write_text(modules)
'''+text[end:];save(p,text)
for name in changed:
 if name.endswith('.rs'):subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*changed],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('EXECUTION_WIRED: durable AppData, local-only provider consent and shared workflow dispatch; ordinary 71-tool catalog retained')
