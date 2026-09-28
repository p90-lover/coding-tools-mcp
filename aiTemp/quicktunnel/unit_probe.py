"""Production handler/probe code; minimal surrounding context, no desktop or inference."""
from pathlib import Path
import sys
root=Path.cwd().resolve();out=root/'aiTemp/quick-unit';(out/'src').mkdir(parents=True,exist_ok=True)
(out/'Cargo.toml').write_text('''[package]
name="quick-control-unit"
version="0.0.0"
edition="2021"
[dependencies]
axum="0.8"
serde_json="1"
thiserror="2"
uuid={version="1",features=["v4"]}
url="2"
tokio={version="1",features=["rt-multi-thread","macros","net","sync","time"]}
reqwest={version="0.12",default-features=false,features=["json","rustls-tls"]}
''')
# Existing connection.rs tests belong to the full application; attach the focused
# contract separately. Every non-test production byte is otherwise retained.
connection=(root/'src-tauri/src/tunnel/connection.rs').read_text().split('#[cfg(test)]')[0]
connection+='\ninclude!("'+(root/'aiTemp/quicktunnel/probe_contract.rs').as_posix()+'");\n'
# The contract's `use super::*` needs its own module, not the production scope.
connection=connection.replace('\ninclude!(', '\n#[cfg(test)] mod contract { include!(').rstrip()+'\n}\n'
(out/'connection.rs').write_text(connection)
listener=(root/'src-tauri/src/mcp/listener.rs').read_text()
start=listener.index('async fn mcp_post(');end=listener.index('\n#[cfg(test)]',start)
handler=listener[start:end]
if '\nfn require_mcp_auth(' in handler:handler=handler.split('\nfn require_mcp_auth(')[0]
fixture=r'''
use axum::{Json,extract::{State,Request,FromRequest},http::{HeaderMap,StatusCode},response::{Response,IntoResponse}};
use serde_json::{json,Value}; use std::sync::{Arc,OnceLock};
#[derive(Clone)]struct ListenerState{mcp:Arc<FixtureContext>,workspace_id:String}
struct FixtureContext{operations:Arc<super::operation_store::OperationStore>}
impl FixtureContext{fn current_policy_revision(&self)->Result<u64,()>{Ok(0)}}
fn require_mcp_auth(_: &ListenerState,h:&HeaderMap)->Option<Response>{if h.get("authorization").is_some_and(|v|v=="Bearer fixture"){None}else{Some(StatusCode::UNAUTHORIZED.into_response())}}
fn append_profile_log(_: &str,_:&str,_:&str){}
fn handle_request(_: &Arc<FixtureContext>,body:&Value)->Value{json!({"jsonrpc":"2.0","id":body["id"],"result":{}})}
mod transport{
 use super::*;
 pub fn validate_protocol_headers(_:&HeaderMap,_:&Value)->Option<Response>{None}
 pub fn early_response(_:&Value)->Option<Response>{None}
}
#[tokio::test]
async fn quick_control_survives_ordinary_worker_saturation(){
 let state=ListenerState{mcp:Arc::new(FixtureContext{operations:Arc::new(Default::default())}),workspace_id:"synthetic".into()};
 let mut slots=Vec::new();for _ in 0..16{slots.push(crate::auth::http_security::acquire_tool_worker().unwrap());}
 let mut results=Vec::new();
 for method in ["ping","initialize","tools/list","server/discover"]{
  let body=json!({"jsonrpc":"2.0","id":method,"method":method});
  let request=Request::builder().method("POST").uri("/mcp").header("authorization","Bearer fixture").header("content-type","application/json").body(axum::body::Body::from(body.to_string())).unwrap();
  let status=mcp_post(State(state.clone()),request).await.status();results.push((method,status.as_u16()));
 }
 println!("QUICK_CONTROL_BASELINE {:?}",results);
 assert!(results.iter().all(|(_,status)|*status==200),"CONTROL_BLOCKED_BY_BUSY_TOOL_WORKERS");
}
'''
# The fixture uses real task spawning/receipt logic, but auth/protocol stubs only
# isolate admission here. The Windows HTTP test verifies real authentication.
modules='pub mod mcp {\n'
for name in ['operation_store','tracked']:
 modules+='#[path="'+(root/f'src-tauri/src/mcp/{name}.rs').as_posix()+'"] pub mod '+name+';\n'
modules+='pub mod listener_fixture {\n'+fixture+'\n'+handler+'\n}}\n'
lib='''pub mod error { use thiserror::Error; #[derive(Debug,Error)] pub enum AppError { #[error("{0}")] Message(String) } pub type AppResult<T> = Result<T,AppError>; }
pub mod settings { #[derive(Default,Clone)] pub struct Proxy {pub mode:String,pub url:String} #[derive(Default,Clone)] pub struct AppSettings{pub proxy:Proxy} }
pub mod auth {pub mod http_security {use std::sync::{Arc,OnceLock};use axum::response::IntoResponse;pub fn acquire_tool_worker()->Result<tokio::sync::OwnedSemaphorePermit,Box<axum::response::Response>>{static S:OnceLock<Arc<tokio::sync::Semaphore>>=OnceLock::new();S.get_or_init(||Arc::new(tokio::sync::Semaphore::new(16))).clone().try_acquire_owned().map_err(|_|Box::new(axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response()))}}}
pub mod tunnel {#[derive(Clone,Copy,PartialEq,Eq)]pub enum TunnelServiceKind{Mcp,Actions}
'''
lib+='#[path="'+(out/'connection.rs').as_posix()+'"] pub mod connection; }\n'+modules
(out/'src/lib.rs').write_text(lib)
print(out/'Cargo.toml')
