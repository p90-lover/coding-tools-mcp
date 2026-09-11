"""Materialize scoped reviewed changes; preserve all replaced originals under aiTemp/Trash."""
from pathlib import Path
import os,shutil,subprocess
changed=set()
def once(text,old,new):
    assert text.count(old)==1,(old[:100],text.count(old))
    return text.replace(old,new,1)
def save(name,text):
    path=Path(name)
    if path.read_text(encoding='utf-8')==text:return
    backup=Path('aiTemp/Trash/quicktunnel-before')/os.environ['GITHUB_RUN_ID']/name
    backup.parent.mkdir(parents=True,exist_ok=True)
    assert not backup.exists() and not path.is_symlink()
    shutil.copy2(path,backup);path.write_text(text,encoding='utf-8');changed.add(name)
name='src-tauri/src/mcp/listener.rs';s=Path(name).read_text()
marker='    let mcp = state.mcp.clone();\n    if method == "tools/call" && tool_name == super::operation_store::TOOL {'
s=once(s,marker,'''    let mcp = state.mcp.clone();
    // Control availability must not depend on all ordinary execution slots being
    // free. This exact method allowlist cannot dispatch a tool or auto-bootstrap.
    // Auth, Origin, envelope and protocol-header validation above still apply.
    if matches!(method.as_str(), "ping" | "initialize" | "tools/list" | "server/discover") {
        static CONTROL: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
        let permit = CONTROL.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
            .clone().try_acquire_owned();
        let Ok(permit) = permit else {
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"jsonrpc":"2.0","id":request_id,
                "error":{"code":-32009,"message":"Protocol control capacity reached; no tool was executed"}}))).into_response();
        };
        let profile = state.workspace_id.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let response = handle_request(&mcp, &body);
            if method == "tools/list" {
                if let Some(tools) = response.pointer("/result/tools").and_then(Value::as_array) {
                    append_profile_log(&profile,"mcp-requests.log",&format!("[discovery] catalog_served tools_count={}",tools.len()));
                }
            }
            response
        });
        return match tokio::time::timeout(std::time::Duration::from_secs(3), worker).await {
            Ok(Ok(response)) => Json(response).into_response(),
            _ => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"jsonrpc":"2.0","id":request_id,
                "error":{"code":-32009,"message":"Protocol control unavailable; no tool was executed"}}))).into_response(),
        };
    }
    if method == "tools/call" && tool_name == super::operation_store::TOOL {''')
s+='\n#[cfg(test)]\n#[path = "../../../aiTemp/quicktunnel/http_contract.rs"]\nmod quick_control_contract;\n'
save(name,s)
name='src-tauri/src/tunnel/connection.rs';s=Path(name).read_text()
s=once(s,'fn client(settings: &AppSettings) -> AppResult<reqwest::Client> {','''struct PooledProbeClient {
    mode: String,
    url: String,
    created: std::time::Instant,
    client: reqwest::Client,
}
fn client(settings: &AppSettings) -> AppResult<reqwest::Client> {
    // Reuse TLS/HTTP pools, not health results. Key by proxy policy and never log
    // the URL (it may contain proxy credentials). System environment is reread
    // on a fresh client at most 60 seconds later; cached clients are bounded.
    static CLIENTS: std::sync::OnceLock<std::sync::Mutex<std::collections::VecDeque<PooledProbeClient>>> = std::sync::OnceLock::new();
    let mode = match settings.proxy.mode.as_str() { "manual" => "manual", "system" => "system", _ => "none" };
    let url = if mode == "manual" { settings.proxy.url.trim() } else { "" };
    let mut clients = CLIENTS.get_or_init(Default::default).lock()
        .map_err(|_| invalid("Discovery client pool unavailable"))?;
    clients.retain(|entry| entry.created.elapsed() < Duration::from_secs(60));
    if let Some(entry) = clients.iter().find(|entry| entry.mode == mode && entry.url == url) {
        return Ok(entry.client.clone());
    }
    let created = build_client(settings)?;
    if clients.len() >= 4 { clients.pop_front(); }
    clients.push_back(PooledProbeClient { mode: mode.into(), url: url.into(), created: std::time::Instant::now(), client: created.clone() });
    Ok(created)
}
fn build_client(settings: &AppSettings) -> AppResult<reqwest::Client> {''')
s=once(s,'.connect_timeout(Duration::from_secs(2));','''.connect_timeout(Duration::from_secs(2))
        .pool_idle_timeout(Duration::from_secs(20))
        .pool_max_idle_per_host(3)
        .tcp_keepalive(Duration::from_secs(30))
        .tcp_nodelay(true);''')
start=s.index('    match kind {',s.index('async fn probe_with_client('));end=s.index('\npub async fn probe_public_service(',start)
s=s[:start]+'''    // Three independent credential-free documents share one deadline rather
    // than paying three sequential round trips. Every identity check remains.
    let status = async {
        match kind {
            TunnelServiceKind::Mcp => validate_mcp(&document(client,&format!("{origin}/mcp")).await?),
            TunnelServiceKind::Actions => {
                let value = document(client,&format!("{origin}/health")).await?;
                if value["ok"] != true || value["service"] != "coding-tools-actions" || !value["tools_loaded"].is_u64() {
                    Err(invalid("Public address is not this app's Actions health endpoint"))
                } else { Ok(()) }
            }
        }
    };
    if !oauth { return status.await; }
    let auth_url = format!("{origin}/.well-known/oauth-authorization-server");
    match kind {
        TunnelServiceKind::Mcp => {
            let resource_url = format!("{origin}/.well-known/oauth-protected-resource");
            let (_,auth,resource) = tokio::try_join!(status,document(client,&auth_url),document(client,&resource_url))?;
            validate_oauth(origin,&auth,&resource)
        }
        TunnelServiceKind::Actions => {
            let (_,auth) = tokio::try_join!(status,document(client,&auth_url))?;
            validate_authorization(origin,&auth)
        }
    }
}
'''+s[end:]
s=once(s,'''    let origin = public_origin(base)?;
    probe_with_client(&origin, kind, oauth, &client(settings)?).await''','''    let origin = public_origin(base)?;
    // At most two public probes (six metadata requests) can be active. Busy
    // diagnostics never restart a tunnel, replay a tool or manufacture success.
    static PROBES: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let _permit = PROBES.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)))
        .clone().try_acquire_owned().map_err(|_| invalid("Public discovery busy; existing tunnel left unchanged"))?;
    let client = client(settings)?;
    tokio::time::timeout(Duration::from_secs(5),probe_with_client(&origin,kind,oauth,&client)).await
        .map_err(|_| invalid("Public discovery deadline exceeded; existing tunnel left unchanged"))?''')
s+='\n#[cfg(test)]\n#[path = "../../../aiTemp/quicktunnel/probe_contract.rs"]\nmod quick_probe_contract;\n'
save(name,s)
name='src-tauri/src/tools/registry_definitions.rs';s=Path(name).read_text()
s=once(s,'                if name == "list_task_events" {','''                if let Some(schema) = crate::tools::recovered_output_schema::for_tool(name) {
                    definition["outputSchema"] = schema;
                }
                if name == "list_task_events" {''');save(name,s)
name='src-tauri/src/tools/mod.rs';s=Path(name).read_text()
s+='\npub(crate) mod recovered_output_schema;\n#[cfg(test)]\ninclude!(concat!(env!("CARGO_MANIFEST_DIR"), "/../aiTemp/quicktunnel/schema_contract.rs"));\n';save(name,s)
for name in ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','README.md','README.en.md']:
 s=Path(name).read_text(encoding='utf-8');assert '0.4.4-rc.3' in s,name
 s=s.replace('0.4.4-rc.3','0.4.4-rc.4')
 if name=='README.en.md':s=s.replace('and the unverified native command sandbox.','and the retired upstream-derived native command sandbox. The separately opted-in AppContainer snapshot executor is included.')
 save(name,s)
changed.update(['src-tauri/src/tools/recovered_output_schema.rs','aiTemp/quicktunnel/http_contract.rs','aiTemp/quicktunnel/probe_contract.rs','aiTemp/quicktunnel/schema_contract.rs'])
for name in sorted(changed):
 if name.endswith('.rs'):subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*sorted(changed)],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('QUICK_PATCH: scoped control availability and credential-free probe speed; auth, actual tool execution and Stop code unchanged')
