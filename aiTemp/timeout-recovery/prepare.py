"""Apply bounded integration points, preserving originals; no file deletion."""
from pathlib import Path
import os,shutil,subprocess
changed=set()
def replace(name,old,new,count=1):
    path=Path(name);s=path.read_text(encoding='utf-8')
    assert s.count(old)==count,(name,old[:100],s.count(old))
    dest=Path('aiTemp/Trash/timeout-before')/os.environ['GITHUB_RUN_ID']/name
    if not dest.exists():
        dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,dest)
    assert not path.is_symlink()
    path.write_text(s.replace(old,new),encoding='utf-8');changed.add(name)
replace('src-tauri/src/mcp/mod.rs','mod listener;','mod listener;\npub(crate) mod operation_store;\npub(crate) mod tracked;')
replace('src-tauri/src/tools/context.rs','    pub sessions: Arc<SessionStore>,','    pub sessions: Arc<SessionStore>,\n    pub(crate) operations: Arc<crate::mcp::operation_store::OperationStore>,')
replace('src-tauri/src/tools/context.rs','            sessions: Arc::new(SessionStore::new()),','            sessions: Arc::new(SessionStore::new()),\n            operations: Arc::new(crate::mcp::operation_store::OperationStore::default()),')
replace('src-tauri/src/tools/registry_definitions.rs','pub const P0_TOOLS: &[(&str, &str, &str, bool, bool, bool)] = &[','''pub const P0_TOOLS: &[(&str, &str, &str, bool, bool, bool)] = &[
    ("mcp_operation_status", "Inspect MCP operation without retry", "Read this listener's bounded runtime-local operation receipts after HTTP timeout. Query an operation_id or original request_id, or omit both for recent records. include_result requires an exact operation_id. Never reruns work; unknown/expired/restarted records are NOT proof of nonexecution. Completed means RPC dispatch returned, not that an owned command/process exited. Shared workspace authentication still applies.", true, false, false),''')
for constant in ['CORE_TOOLS','CORE_READ_ONLY_TOOLS','ALLOWED_TOOLS','READ_ONLY_TOOLS']:
    replace('src-tauri/src/tools/registry_definitions.rs',f'pub const {constant}: &[&str] = &[',f'pub const {constant}: &[&str] = &[\n    "mcp_operation_status",')
replace('src-tauri/src/tools/registry_definitions.rs','''                json!({
                    "name": name,''','''                let mut definition = json!({
                    "name": name,''')
replace('src-tauri/src/tools/registry_definitions.rs','''                })
            })
        })
        .collect()
}''','''                });
                if name == crate::mcp::operation_store::TOOL {
                    definition["outputSchema"] = crate::mcp::operation_store::output_schema();
                }
                definition
            })
        })
        .collect()
}''')
replace('src-tauri/src/tools/registry_definitions.rs','pub fn input_schema(name: &str) -> Value {','''pub fn input_schema(name: &str) -> Value {
    if name == crate::mcp::operation_store::TOOL {
        return crate::mcp::operation_store::input_schema();
    }''')
replace('src-tauri/src/tools/dispatch.rs','''    let result = match name {
        "workflow_list"''','''    let result = match name {
        "mcp_operation_status" => ctx.operations.query(&effective_args, ctx.policy_revision,
            &crate::tools::registry::exposed_tool_names(&ctx.tool_profile))
            .map_err(|message| WorkspaceError::Tool {code:"OPERATION_QUERY_REJECTED",message,category:"validation",retryable:false}),
        "workflow_list"''')
replace('src-tauri/src/mcp/server.rs','''    let auto_history = if canonical_name.starts_with("history_session_") {''','''    let auto_history = if canonical_name.starts_with("history_session_")
        || canonical_name == crate::mcp::operation_store::TOOL {''')
replace('src-tauri/src/mcp/server.rs','Use these tools only for local coding operations inside the configured workspace.','After an HTTP timeout, use mcp_operation_status with the returned operation_id (include_result=true), the original request_id, or no selector for recent records. Never rerun the original operation just to inspect it. Receipts/results are runtime-local and bounded; missing records are unknown, not proof of nonexecution. Completed means RPC dispatch returned; inspect any returned command/task handle separately. Use these tools only for local coding operations inside the configured workspace.')
p=Path('src-tauri/src/mcp/listener.rs');s=p.read_text()
start=s.index('    let mcp = state.mcp.clone();',s.index('async fn mcp_post('));end=s.index('\nfn require_mcp_auth(',start);old=s[start:end]
a=old.index('            if tool_name == "exec_command"');b=old.index('            Json(response).into_response()',a);logs=old[a:b]
new='''    let mcp = state.mcp.clone();
    if method == "tools/call" && tool_name == super::operation_store::TOOL {
        // Authentication/envelope checks above still apply. Recovery must not
        // queue behind occupied execution slots or create an automatic history.
        return super::tracked::query(move || handle_request(&mcp, &body)).await;
    }
    let revision = match mcp.current_policy_revision() {
        Ok(revision) => revision,
        Err(_) => return (StatusCode::SERVICE_UNAVAILABLE, "Live policy unavailable; operation not admitted").into_response(),
    };
    let permit = match crate::auth::http_security::acquire_tool_worker() {
        Ok(permit) => permit,
        Err(response) => return *response,
    };
    let store = mcp.operations.clone();
    let recorded_body = json!({"id":request_id,"method":method,"params":{"name":tool_name}});
    let profile_id = state.workspace_id.clone();
    let log_profile = profile_id.clone();
    let recorder: super::tracked::Recorder = Arc::new(move |line| {
        append_profile_log(&log_profile, "mcp-requests.log", line);
    });
    super::tracked::execute(store, recorded_body, revision, super::tracked::HTTP_WAIT, move || {
        let _permit = permit;
        let response = handle_request(&mcp, &body);
'''+logs+'''
        response
    }, recorder).await
}
'''
replace(str(p),old,new)
replace(str(p),'            request_id, method, tool_name\n','            request_id, json!(method), json!(tool_name)\n')
replace('src-tauri/src/tools/catalog.rs','assert_eq!(full["registered_count"], 70);','assert_eq!(full["registered_count"], 71);')
replace('src-tauri/src/tools/catalog.rs','assert_eq!(describe("core")["advertised_count"], 57);','assert_eq!(describe("core")["advertised_count"], 58);')
replace('src-tauri/src/tools/catalog.rs','assert_eq!(describe("read-only")["advertised_count"], 41);','assert_eq!(describe("read-only")["advertised_count"], 42);')
replace('aiTemp/oauth-popup/http_flow.rs','tools["result"]["tools"].as_array().unwrap().len(), 70','tools["result"]["tools"].as_array().unwrap().len(), 71')
replace('aiTemp/oauth-popup/http_flow.rs','authenticated 70-tool catalog','authenticated 71-tool catalog')
replace('aiTemp/origin-repair/browser_live.py',"len(json.loads(body)['result']['tools'])==70","len(json.loads(body)['result']['tools'])==71")
for name in ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','README.md','README.en.md']:
    text=Path(name).read_text();n=text.count('0.4.4-rc.1');assert n,name
    replace(name,'0.4.4-rc.1','0.4.4-rc.2',n)
replace('src-tauri/src/mcp/mod.rs','pub use listener::{spawn_listener, ShutdownSender};','''pub use listener::{spawn_listener, ShutdownSender};
#[cfg(test)]
#[path = "../../../aiTemp/timeout-recovery/contract.rs"]
mod recovery_contract;''')
replace('src-tauri/src/mcp/listener.rs','\nfn require_mcp_auth(','''\n#[cfg(test)]
#[path = "../../../aiTemp/timeout-recovery/http_contract.rs"]
mod recovery_http_contract;

fn require_mcp_auth(''')
for name in ['src-tauri/src/mcp/operation_store.rs','src-tauri/src/mcp/tracked.rs','aiTemp/timeout-recovery/contract.rs','aiTemp/timeout-recovery/http_contract.rs']:
    changed.add(name)
for name in sorted(changed):
    if name.endswith('.rs'): subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*sorted(changed)],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('Applied scoped timeout recovery. Existing auth/permission/native execution paths retained.')
