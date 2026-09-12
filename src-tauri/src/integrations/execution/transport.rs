//! Single-attempt source IO. Callers must durably reserve and authorize the
//! action before entering here. A lost acknowledgement is never retried.
use super::{model::{Action,Engine,identifier},protocol::{endpoint,Request,Wire}};
use futures_util::{SinkExt,StreamExt};
use serde::Serialize;
use serde_json::{json,Value};
use std::{sync::{Arc,atomic::{AtomicBool,Ordering}},time::Duration};
use tokio_tungstenite::{connect_async_with_config,tungstenite::{client::IntoClientRequest,protocol::{Message,WebSocketConfig}}};
const BYTES:usize=2*1024*1024;
#[derive(Debug,Clone,Serialize)]
pub struct Failure {pub stage:String,pub request_may_have_been_sent:bool,pub automatic_retry:bool}
#[derive(Debug,Clone,Serialize)]
pub struct Response {pub body:Value,pub server_id:Option<String>}
fn fail(stage:&str,sent:bool)->Failure{Failure{stage:stage.into(),request_may_have_been_sent:sent,automatic_retry:false}}
impl std::fmt::Display for Failure {fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{write!(f,"{}; sent_or_unknown={}; do not automatically retry",self.stage,self.request_may_have_been_sent)}}
impl std::error::Error for Failure {}
pub async fn send(engine:Engine,raw:&str,credential:&str,request:&Request)->Result<Response,Failure>{
 if request.engine!=engine{return Err(fail("source_mismatch",false))}
 let u=endpoint(engine,raw).map_err(|_|fail("invalid_endpoint",false))?;
 if credential.len()>4096||credential.chars().any(char::is_control){return Err(fail("invalid_credential",false))}
 identifier(&request.request_id).map_err(|_|fail("invalid_request_id",false))?;
 let sent=Arc::new(AtomicBool::new(false));
 let outcome=tokio::time::timeout(Duration::from_secs(8),async{
  match (&request.wire,engine){
   (Wire::Http{method,path,body},Engine::Anneal)=>http(u,credential,request,method,path,body,&sent).await,
   (Wire::Socket{message,response,status},Engine::Paseo)=>socket(u,credential,request,message,response,status.as_deref(),&sent).await,
   _=>Err(fail("transport_mismatch",false)),
  }
 }).await;
 outcome.map_err(|_|fail("response_deadline",sent.load(Ordering::SeqCst)))?
}
async fn http(mut u:url::Url,credential:&str,request:&Request,method:&str,path:&str,body:&Value,sent:&AtomicBool)->Result<Response,Failure>{
 // The builder owns these paths; do not turn this internal API into a generic
 // HTTP proxy even when another internal caller constructs a Request.
 if !matches!(method,"GET"|"POST"|"PATCH")||!path.starts_with('/')||path.contains("..")||path.contains(['?','#','\\']){return Err(fail("invalid_route",false))}
 u.set_path(path);
 let c=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(6)).build().map_err(|_|fail("client_initialization",false))?;
 let method=reqwest::Method::from_bytes(method.as_bytes()).map_err(|_|fail("invalid_method",false))?;
 let mut call=c.request(method,u).header("Accept","application/json");
 if !credential.is_empty(){call=call.bearer_auth(credential)}
 if !body.is_null(){call=call.json(body)}
 sent.store(true,Ordering::SeqCst);
 let mut response=call.send().await.map_err(|_|fail("http_transport",true))?;
 if !response.status().is_success(){return Err(fail(&format!("http_status_{}",response.status().as_u16()),true))}
 if response.content_length().is_some_and(|n|n>BYTES as u64){return Err(fail("response_size_limit",true))}
 let mut bytes=Vec::new();
 while let Some(chunk)=response.chunk().await.map_err(|_|fail("interrupted_body",true))?{
  if bytes.len().saturating_add(chunk.len())>BYTES{return Err(fail("response_size_limit",true))}bytes.extend_from_slice(&chunk);
 }
 let value:Value=serde_json::from_slice(&bytes).map_err(|_|fail("invalid_json_response",true))?;
 match request.action {
  Action::Create=>{
   let id=value["id"].as_str().ok_or_else(||fail("missing_created_record",true))?;identifier(id).map_err(|_|fail("invalid_created_record",true))?;
   if value["status"]!="BACKLOG"{return Err(fail("create_was_not_held",true))}
   let expected=path.split('/').nth(2).unwrap_or("");
   if value["projectId"]!=expected{return Err(fail("created_project_mismatch",true))}
  },
  Action::Inspect=>if value["id"].as_str()!=request.record_id.as_deref(){return Err(fail("record_identity_mismatch",true))},
  Action::Start=>{let id=value["runId"].as_str().ok_or_else(||fail("missing_run_receipt",true))?;identifier(id).map_err(|_|fail("invalid_run_receipt",true))?;},
  Action::Cancel=>if value["runId"].as_str()!=request.run_id.as_deref()||value["requestId"]!=request.request_id{return Err(fail("cancellation_identity_mismatch",true))},
  Action::Close=>if value["task"]["id"].as_str()!=request.record_id.as_deref()||!value["task"]["archivedAt"].is_string(){return Err(fail("archive_not_confirmed",true))},
  Action::Hold|Action::Resume|Action::Events=>{},
 }
 Ok(Response{body:value,server_id:None})
}
async fn socket(u:url::Url,credential:&str,request:&Request,message:&Value,expected:&str,status:Option<&str>,sent:&AtomicBool)->Result<Response,Failure>{
 let mut handshake=u.as_str().into_client_request().map_err(|_|fail("websocket_request",false))?;
 if !credential.is_empty(){
  if !credential.bytes().all(|b|b.is_ascii_alphanumeric()||b"!#$%&'*+-.^_`|~".contains(&b)){return Err(fail("invalid_websocket_credential",false))}
  handshake.headers_mut().insert("Sec-WebSocket-Protocol",format!("paseo.bearer.{credential}").parse().map_err(|_|fail("invalid_websocket_credential",false))?);
 }
 let mut cfg=WebSocketConfig::default();cfg.max_message_size=Some(BYTES);cfg.max_frame_size=Some(BYTES);
 let (mut ws,_)=connect_async_with_config(handshake,Some(cfg),true).await.map_err(|_|fail("websocket_connect",false))?;
 ws.send(Message::Text(json!({"type":"hello","clientId":format!("coding-tools-controller-{}",request.request_id),"clientType":"cli","protocolVersion":1,"capabilities":{"voice":false,"pushNotifications":false,"explicit_event_subscriptions":true,"selective_agent_timeline":true,"all_providers":true}}).to_string().into())).await.map_err(|_|fail("websocket_hello",false))?;
 let mut server_id=None;let mut total=0usize;
 for _ in 0..64 {
  let frame=ws.next().await.ok_or_else(||fail("websocket_closed",sent.load(Ordering::SeqCst)))?.map_err(|_|fail("websocket_frame",sent.load(Ordering::SeqCst)))?;
  match frame {
   Message::Ping(bytes)=>ws.send(Message::Pong(bytes)).await.map_err(|_|fail("websocket_ping",sent.load(Ordering::SeqCst)))?,
   Message::Text(raw)=>{
    total=total.saturating_add(raw.len());if total>BYTES*2{return Err(fail("traffic_limit",sent.load(Ordering::SeqCst)))}
    let envelope:Value=serde_json::from_str(&raw).map_err(|_|fail("invalid_socket_json",sent.load(Ordering::SeqCst)))?;
    if envelope["type"]!="session"{continue}
    let m=&envelope["message"];let p=&m["payload"];
    if server_id.is_none()&&p["status"]=="server_info"{
     let id=p["serverId"].as_str().filter(|id|!id.is_empty()&&id.len()<=200).ok_or_else(||fail("missing_server_identity",false))?;
     server_id=Some(id.to_owned());
     if message["requestId"]!=request.request_id{return Err(fail("local_request_identity_mismatch",false))}
     sent.store(true,Ordering::SeqCst);
     ws.send(Message::Text(json!({"type":"session","message":message}).to_string().into())).await.map_err(|_|fail("socket_submission",true))?;
     continue;
    }
    if !sent.load(Ordering::SeqCst)||p["requestId"]!=request.request_id{continue}
    if m["type"]=="rpc_error"||p["status"]=="agent_create_failed"||p["error"].as_str().is_some_and(|s|!s.is_empty()){return Err(fail("upstream_refused",true))}
    if m["type"]!=expected||status.is_some_and(|s|p["status"]!=s){continue}
    match request.action {
     Action::Create=>{
      let id=p["agentId"].as_str().ok_or_else(||fail("missing_agent_identity",true))?;identifier(id).map_err(|_|fail("invalid_agent_identity",true))?;
      if p["agent"]["id"]!=id||p["agent"]["cwd"]!=message["config"]["cwd"]||p["agent"]["provider"]!=message["config"]["provider"]{return Err(fail("created_agent_binding_mismatch",true))}
     },
     Action::Start|Action::Resume=>if p["agentId"].as_str()!=request.record_id.as_deref()||p["accepted"]!=true{return Err(fail("prompt_not_accepted",true))},
     Action::Hold|Action::Cancel|Action::Events=>if p["agentId"].as_str()!=request.record_id.as_deref(){return Err(fail("agent_identity_mismatch",true))},
     Action::Inspect=>if p["agent"]["id"].as_str()!=request.record_id.as_deref(){return Err(fail("agent_identity_mismatch",true))},
     Action::Close=>{
      let agents=p["agents"].as_array().ok_or_else(||fail("missing_close_receipt",true))?;
      if agents.len()!=1||agents[0]["agentId"].as_str()!=request.record_id.as_deref()||!agents[0]["archivedAt"].is_string(){return Err(fail("close_not_confirmed",true))}
     },
    }
    return Ok(Response{body:p.clone(),server_id});
   },
   Message::Close(_)=>return Err(fail("websocket_closed",sent.load(Ordering::SeqCst))),
   _=>{},
  }
 }
 Err(fail("frame_limit",sent.load(Ordering::SeqCst)))
}
