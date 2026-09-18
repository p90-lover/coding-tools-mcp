use execution::{model::*,protocol::*};
use serde_json::json;
fn spec(engine:Engine)->Spec {Spec {engine,mission_id:"mission-fixture-0001".into(),workspace_id:"workspace-one".into(),task_id:"board-task-one".into(),cwd:"C:/approved/project".into(),provider:"claude".into(),model:"configured-model".into(),mode:"default".into(),project_id:Some("project-one".into()),repo_id:Some("repo-one".into()),assignee_id:Some("worker-one".into()),title:"Implement verified change".into(),brief:"Do only the assigned task; preserve files.".into(),max_duration_min:30}}
#[test]
fn execution_lifecycle_reviews_and_no_replay(){
 let mut m=Mission::new(spec(Engine::Paseo)).unwrap();
 let first=m.reserve(0,"create-key-0001",Action::Create).unwrap();assert!(first.dispatch);
 let retry=m.reserve(0,"create-key-0001",Action::Create).unwrap();assert!(!retry.dispatch);
 assert!(m.reserve(1,"another-key-0002",Action::Create).is_err());
 let reply=Reply::Created{record_id:"agent-one".into()};m.settle("create-key-0001",reply).unwrap();
 assert_eq!(m.phase,Phase::Ready);
 let r=m.revision;m.reserve(r,"start-key-0001",Action::Start).unwrap();m.uncertain("start-key-0001").unwrap();
 assert_eq!(m.phase,Phase::Unknown);assert!(!m.reserve(r,"start-key-0001",Action::Start).unwrap().dispatch);
 let saved=serde_json::to_vec(&m).unwrap();let mut m:Mission=serde_json::from_slice(&saved).unwrap();
 assert_eq!(serde_json::to_vec(&m).unwrap(),saved);
 assert!(m.reserve(m.revision,"start-key-0002",Action::Start).is_err());
 assert!(m.observe(Observation{record_id:"foreign-agent".into(),status:"running".into(),run_id:None,quiescent:false}).is_err());
 m.observe(Observation{record_id:"agent-one".into(),status:"running".into(),run_id:None,quiescent:false}).unwrap();
 assert_eq!(m.phase,Phase::Running);
 m.reserve(m.revision,"hold-key-0001",Action::Hold).unwrap();
 assert_eq!(m.phase,Phase::HoldRequested);
 m.settle("hold-key-0001",Reply::HoldAcknowledged{worker_stopped:false}).unwrap();
 assert_eq!(m.phase,Phase::SchedulingHeld,"A scheduler hold is not an interrupted worker");
 assert!(m.review("agent-one","note",&["artifact:one".into()],true).is_err());
 m.observe(Observation{record_id:"agent-one".into(),status:"idle".into(),run_id:None,quiescent:true}).unwrap();
 assert_eq!(m.phase,Phase::Held);
 m.reserve(m.revision,"resume-key-0001",Action::Resume).unwrap();m.settle("resume-key-0001",Reply::Started{run_id:None}).unwrap();
 m.observe(Observation{record_id:"agent-one".into(),status:"idle".into(),run_id:None,quiescent:true}).unwrap();
 assert_eq!(m.phase,Phase::ReviewRequired);
 assert!(m.review("agent-one","self approval",&["artifact:one".into()],true).is_err());
 assert!(m.review("reviewer-two","review",&[],true).is_err());
 m.review("reviewer-two","Independent review found an issue",&["artifact:review-one".into()],false).unwrap();
 assert_eq!(m.phase,Phase::ChangesRequested);
 m.reserve(m.revision,"start-key-0003",Action::Start).unwrap();m.settle("start-key-0003",Reply::Started{run_id:None}).unwrap();
 m.observe(Observation{record_id:"agent-one".into(),status:"idle".into(),run_id:None,quiescent:true}).unwrap();
 m.review("reviewer-two","Reviewed corrected result",&["artifact:review-two".into()],true).unwrap();
 assert_eq!(m.phase,Phase::Accepted);
 m.reserve(m.revision,"close-key-0001",Action::Close).unwrap();assert_eq!(m.phase,Phase::CloseRequested);
 m.settle("close-key-0001",Reply::Closed).unwrap();assert_eq!(m.phase,Phase::Closed);
 assert_eq!(m.reviews.len(),2);assert!(m.reserve(m.revision,"start-key-0004",Action::Start).is_err());
 println!("EXECUTION_LIFECYCLE_PASS: persisted receipts, no replay, scoped observations, requested versus observed hold, independent review and explicit close");
}
#[test]
fn execution_source_requests_are_bounded_and_non_destructive(){
 let p=spec(Engine::Paseo);
 let c=build(&p,None,None,Action::Create,"request-one").unwrap();
 let Wire::Socket{message,..}=c.wire else{panic!()};
 assert_eq!(message["type"],"create_agent_request");assert_eq!(message["idempotencyKey"],"mission-fixture-0001");
 assert!(message.get("initialPrompt").is_none());assert_eq!(message["autoArchive"],false);
 assert_eq!(message["config"]["cwd"],p.cwd);assert!(message.get("env").is_none());assert!(message.get("git").is_none());
 for engine in [Engine::Paseo,Engine::Anneal]{
  let s=spec(engine);
  assert!(build(&s,None,None,Action::Start,"request-two").is_err());
  for action in [Action::Create,Action::Start,Action::Inspect,Action::Events,Action::Hold,Action::Resume,Action::Cancel,Action::Close]{
   let request=build(&s,Some("record-one"),Some("run-one"),action,"request-two").unwrap();
   assert!(!serde_json::to_string(&request).unwrap().contains("delete"));
   if let Wire::Http{method,..}=request.wire {assert!(matches!(method.as_str(),"GET"|"POST"|"PATCH"));}
  }
 }
 let a=build(&spec(Engine::Anneal),None,None,Action::Create,"request-three").unwrap();
 let Wire::Http{body,path,method}=a.wire else {panic!()};
 assert_eq!(method,"POST");assert_eq!(path,"/projects/project-one/tasks");
 assert_eq!(body["status"],"BACKLOG");assert_eq!(body["approvalGate"],true);assert_eq!(body["opensPullRequest"],false);
 assert_eq!(body["maxSessionsPerTask"],1);assert_eq!(body["chainIndex"],0);
 let hold=build(&spec(Engine::Anneal),Some("record-one"),None,Action::Hold,"hold-key-one").unwrap();
 assert!(serde_json::to_string(&hold).unwrap().contains("chain/hold"));
 let mut bad=spec(Engine::Anneal);bad.project_id=Some("../outside".into());assert!(build(&bad,None,None,Action::Create,"key").is_err());
 let mut bad=spec(Engine::Paseo);bad.brief="x".repeat(32769);assert!(Mission::new(bad).is_err());
 for u in ["http://example.com:3000/","http://127.0.0.1:3000/?token=secret","http://user:secret@127.0.0.1:3000/","http://127.0.0.2:3000/"]{assert!(endpoint(Engine::Anneal,u).is_err());}
 assert!(endpoint(Engine::Paseo,"ws://127.0.0.1:6767/ws").is_ok());
 println!("EXECUTION_PROTOCOL_PASS: separate create/start, explicit review gates, no delete route, exact owned IDs and loopback/bounds");
}
#[tokio::test]
async fn execution_transport_correlates_real_local_servers(){
 use axum::{Json,Router,routing::post,extract::State};use std::sync::{Arc,Mutex};use futures_util::{SinkExt,StreamExt};
 let seen=Arc::new(Mutex::new(Vec::new()));
 async fn create(State(seen):State<Arc<Mutex<Vec<serde_json::Value>>>>,h:axum::http::HeaderMap,Json(v):Json<serde_json::Value>)->Json<serde_json::Value>{assert_eq!(h["authorization"],"Bearer synthetic-token");seen.lock().unwrap().push(v);Json(json!({"id":"anneal-task-one","status":"BACKLOG","projectId":"project-one"}))}
 let socket=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}/",socket.local_addr().unwrap());
 let (end,rx)=tokio::sync::oneshot::channel();let app=Router::new().route("/projects/project-one/tasks",post(create)).with_state(seen.clone());
 let server=tokio::spawn(async move {axum::serve(socket,app).with_graceful_shutdown(async{let _=rx.await;}).await.unwrap();});
 let req=build(&spec(Engine::Anneal),None,None,Action::Create,"http-one").unwrap();
 let reply=execution::transport::send(Engine::Anneal,&url,"synthetic-token",&req).await.unwrap();
 assert_eq!(reply.body["id"],"anneal-task-one");assert_eq!(seen.lock().unwrap().len(),1);let _=end.send(());server.await.unwrap();
 let socket=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("ws://{}/ws",socket.local_addr().unwrap());
 let server=tokio::spawn(async move {
  let (stream,_)=socket.accept().await.unwrap();let mut ws=tokio_tungstenite::accept_async(stream).await.unwrap();
  let hello=ws.next().await.unwrap().unwrap();assert!(hello.to_text().unwrap().contains("hello"));
  ws.send(tokio_tungstenite::tungstenite::Message::text(json!({"type":"session","message":{"type":"status","payload":{"status":"server_info","serverId":"fixture-server"}}}).to_string())).await.unwrap();
  let wire:serde_json::Value=serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
  assert_eq!(wire["message"]["type"],"send_agent_message_request");assert_eq!(wire["message"]["agentId"],"owned-agent");
  for (key,id) in [("foreign-request","foreign-agent"),("socket-one","owned-agent")]{
   ws.send(tokio_tungstenite::tungstenite::Message::text(json!({"type":"session","message":{"type":"send_agent_message_response","payload":{"requestId":key,"agentId":id,"accepted":true,"error":null}}}).to_string())).await.unwrap();
  }
 });
 let request=build(&spec(Engine::Paseo),Some("owned-agent"),None,Action::Start,"socket-one").unwrap();
 let reply=execution::transport::send(Engine::Paseo,&url,"",&request).await.unwrap();
 assert_eq!(reply.body["agentId"],"owned-agent");assert_eq!(reply.body["requestId"],"socket-one");server.await.unwrap();
 println!("EXECUTION_TRANSPORT_PASS: actual HTTP and WebSocket requests to fixtures, credential header, handshake and exact response correlation; no agent/model used");
}
