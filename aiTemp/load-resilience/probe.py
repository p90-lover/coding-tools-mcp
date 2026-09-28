"""Actual MCP handler and recovery ownership branch with controlled I/O fixtures.
No model, desktop, token, tunnel or game is started. All artifacts stay in aiTemp.
"""
from pathlib import Path
import subprocess,sys
root=Path.cwd().resolve();out=root/'aiTemp/load-probe';(out/'src').mkdir(parents=True,exist_ok=True)
(out/'Cargo.toml').write_text('''[package]
name="load-resilience-probe"
version="0.0.0"
edition="2021"
[dependencies]
axum="0.8"
serde_json="1"
uuid={version="1",features=["v4"]}
tokio={version="1",features=["rt-multi-thread","macros","sync","time"]}
''')
listener=Path('src-tauri/src/mcp/listener.rs').read_text(encoding='utf-8')
handler=listener[listener.index('async fn mcp_post('):listener.index('\n#[cfg(test)]',listener.index('async fn mcp_post('))]
logger_path=root/'src-tauri/src/mcp/request_log.rs'
patched='use super::request_log::append_profile_log;' in listener
modules='pub mod mcp {\n'
for name in ['operation_store','tracked']:
 modules+='#[path="'+(root/f'src-tauri/src/mcp/{name}.rs').as_posix()+'"]pub mod '+name+';\n'
if patched:
 modules+='#[path="'+logger_path.as_posix()+'"]pub mod request_log;\n'
modules+='pub mod listener_fixture {\n'+('use super::request_log::append_profile_log;\n' if patched else 'use crate::tunnel::append_profile_log;\n')
modules+=r'''
use axum::{Json,extract::{State,Request,FromRequest},http::{HeaderMap,StatusCode},response::{Response,IntoResponse}};
use serde_json::{json,Value};use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
#[derive(Clone)]struct ListenerState{mcp:Arc<Context>,workspace_id:String}
struct Context{operations:Arc<super::operation_store::OperationStore>,workspace:Workspace}
struct Workspace;
impl Workspace{fn roots_revision(&self)->String{"fixture-roots".into()}}
impl Context{fn current_policy_revision(&self)->Result<u64,()>{Ok(0)}fn for_request(&self)->Result<&Self,()>{Ok(self)}}
fn require_mcp_auth(_: &ListenerState,h:&HeaderMap)->Option<Response>{if h.get("authorization").is_some_and(|v|v=="Bearer fixture"){None}else{Some(StatusCode::UNAUTHORIZED.into_response())}}
static EFFECTS:AtomicUsize=AtomicUsize::new(0);
fn handle_request(_: &Arc<Context>,body:&Value)->Value{if body["method"]=="tools/call"{EFFECTS.fetch_add(1,Ordering::SeqCst);}json!({"jsonrpc":"2.0","id":body["id"],"result":{}})}
mod transport{use super::*;pub fn validate_protocol_headers(_:&HeaderMap,_:&Value)->Option<Response>{None}pub fn early_response(_:&Value)->Option<Response>{None}}
#[tokio::test(flavor="current_thread")]
async fn resilience_slow_trace_does_not_block_control_or_runtime_timer(){
 let state=ListenerState{mcp:Arc::new(Context{operations:Arc::new(Default::default()),workspace:Workspace}),workspace_id:"synthetic".into()};
 let make=||Request::builder().method("POST").uri("/mcp").header("content-type","application/json").header("authorization","Bearer fixture").body(axum::body::Body::from(json!({"jsonrpc":"2.0","id":"read-only-ping","method":"ping"}).to_string())).unwrap();
 crate::tunnel::SLOW.store(true,Ordering::SeqCst);
 let began=std::time::Instant::now();
 let (response,timer_lag)=tokio::join!(mcp_post(State(state.clone()),make()),async{tokio::time::sleep(std::time::Duration::from_millis(20)).await;began.elapsed().as_millis()});
 let response_ms=began.elapsed().as_millis();
 crate::tunnel::SLOW.store(false,Ordering::SeqCst);
 assert_eq!(response.status(),StatusCode::OK);
 let denied=Request::builder().method("POST").uri("/mcp").header("content-type","application/json").body(axum::body::Body::from(json!({"jsonrpc":"2.0","id":"denied","method":"ping"}).to_string())).unwrap();
 assert_eq!(mcp_post(State(state),denied).await.status(),StatusCode::UNAUTHORIZED);
 assert_eq!(EFFECTS.load(Ordering::SeqCst),0);
 println!("LOAD_TIMING {}",json!({"slow_sink_ms":800,"timer_elapsed_ms":timer_lag,"response_ms":response_ms,"actual_handler":true,"fixture_context":true,"model_requests":0}));
 assert!(timer_lag<400,"SLOW_TRACE_BLOCKS_ASYNC_SCHEDULER");
 assert!(response_ms<400,"SLOW_TRACE_DELAYS_MCP_PING");
}
'''+handler+'\n}}\n'
# The exact released ownership decision is exercised, not a rewritten predicate.
supervisor=Path('src-tauri/src/tunnel/supervisor.rs').read_text(encoding='utf-8')
start=supervisor.index('            if platform().find_pid_listening_on_port(port)') if '            if platform().find_pid_listening_on_port(port)' in supervisor else supervisor.index('            match platform().find_pid_listening_on_port(port)')
end=supervisor.index('            // Keep the backoff ledger',start)
check=supervisor[start:end]
recovery='pub mod recovery_fixture {\n#[path="'+(root/'src-tauri/src/tunnel/recovery.rs').as_posix()+'"]mod recovery;\n'+r'''
use std::sync::Mutex;use serde_json::Value;use tokio::time::Instant;
static QUERY:Mutex<Result<Option<u32>,String>>=Mutex::new(Ok(None));
struct Platform;fn platform()->Platform{Platform}
impl Platform{fn find_pid_listening_on_port(&self,_:u16)->Result<Option<u32>,String>{QUERY.lock().unwrap().clone()}}
fn append_profile_log(_:&str,_:&str,_:&str){}
fn decision(query:Result<Option<u32>,String>)->(bool,Value){
 *QUERY.lock().unwrap()=query;let mut budget=recovery::Recovery::default();let port=28766;let key=("fixture".to_string(),());let mut allowed=false;
 for _ in 0..1 {
'''+check+r'''
 allowed=true;
 }
 (allowed,budget.summary(Instant::now(),false))
}
#[test]fn resilience_transient_owner_query_does_not_permanently_disable_reconnect(){
 let (allowed,state)=decision(Err("synthetic OS enumeration error".into()));
 assert!(!allowed,"Unknown ownership must never authorize restart");
 assert_eq!(state["requires_manual_start"],false,"TRANSIENT_OWNER_QUERY_PERMANENTLY_BLOCKS_RECOVERY");
 assert_eq!(state["attempts"],0);
 let (allowed,_)=decision(Ok(Some(std::process::id())));assert!(allowed);
 for query in [Ok(None),Ok(Some(std::process::id().saturating_add(1)))]{
  let (allowed,state)=decision(query);assert!(!allowed);assert_eq!(state["requires_manual_start"],true);
 }
 println!("OWNERSHIP_RECOVERY_PASS: transient query deferred; proven foreign/missing owner still blocked; no child started");
}
}
'''
lib=r'''
pub mod tunnel{
 use std::{sync::atomic::{AtomicBool,Ordering},path::PathBuf};
 pub static SLOW:AtomicBool=AtomicBool::new(false);
 pub fn log_dir_for_profile(_: &str)->PathBuf{std::env::current_dir().unwrap().join("aiTemp/unused-trace-path")}
 pub fn append_profile_log(_: &str,_:&str,_:&str){if SLOW.load(Ordering::SeqCst){std::thread::sleep(std::time::Duration::from_millis(800));}}
}
pub mod auth{pub mod http_security{
 use std::sync::{Arc,OnceLock};use axum::response::IntoResponse;
 pub fn acquire_tool_worker()->Result<tokio::sync::OwnedSemaphorePermit,Box<axum::response::Response>>{static S:OnceLock<Arc<tokio::sync::Semaphore>>=OnceLock::new();S.get_or_init(||Arc::new(tokio::sync::Semaphore::new(16))).clone().try_acquire_owned().map_err(|_|Box::new(axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response()))}
}}
'''+modules+recovery
(out/'src/lib.rs').write_text(lib,encoding='utf-8')
sys.exit(subprocess.run(['cargo','test','--manifest-path',str(out/'Cargo.toml'),'resilience_','--','--test-threads=1','--nocapture']).returncode)
