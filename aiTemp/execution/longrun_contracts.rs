use crate::execution::{model::*,protocol::*};
use serde_json::json;
fn spec(engine:Engine)->Spec {Spec{engine,mission_id:"mission-recovery".into(),workspace_id:"workspace-one".into(),task_id:"board-one".into(),cwd:"C:/approved/project".into(),provider:"claude".into(),model:"configured-model".into(),mode:"default".into(),project_id:Some("project-one".into()),repo_id:Some("repo-one".into()),assignee_id:Some("worker-one".into()),title:"Reviewed task".into(),brief:"Preserve all files".into(),max_duration_min:30}}
#[test]
fn longrun_contract_lost_start_cannot_become_a_fresh_mission(){
 let mut m=Mission::new(spec(Engine::Paseo)).unwrap();
 m.reserve(0,"create",Action::Create).unwrap();m.settle("create",Reply::Created{record_id:"agent-one".into()}).unwrap();
 let r=m.revision;m.reserve(r,"start",Action::Start).unwrap();m.uncertain("start").unwrap();
 let saved=serde_json::to_vec(&m).unwrap();let mut m:Mission=serde_json::from_slice(&saved).unwrap();
 m.observe(Observation{record_id:"agent-one".into(),status:"idle".into(),run_id:None,quiescent:true}).unwrap();
 assert_eq!(m.phase,Phase::ReviewRequired,"LOST_START_MUST_REQUIRE_REVIEW_NOT_READY");
 assert!(!m.reserve(r,"start",Action::Start).unwrap().dispatch);
 assert!(m.reserve(m.revision,"new-start",Action::Start).is_err());
 m.review("coordinator","Reviewed stored output",&["artifact:result".into()],true).unwrap();
 m.observe(Observation{record_id:"agent-one".into(),status:"running".into(),run_id:None,quiescent:false}).unwrap();
 assert_ne!(m.phase,Phase::Accepted,"RUNNING_WORKER_CANNOT_KEEP_OLD_ACCEPTANCE");
 assert!(m.reserve(m.revision,"close-running",Action::Close).is_err());
 println!("LONGRUN_LIFECYCLE_PASS: restart/deserialization preserves unresolved attempts; idle requires review; live work invalidates old acceptance");
}
#[tokio::test]
async fn longrun_contract_anneal_archive_uses_actual_task_response(){
 use axum::{Router,Json,routing::post};
 let socket=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/",socket.local_addr().unwrap());
 let app=Router::new().route("/tasks/owned-task/archive",post(||async{Json(json!({"id":"owned-task","archivedAt":"2026-09-12T00:00:00Z"}))}));
 let (done,rx)=tokio::sync::oneshot::channel();
 let server=tokio::spawn(async move{axum::serve(socket,app).with_graceful_shutdown(async{let _=rx.await;}).await.unwrap();});
 let request=build(&spec(Engine::Anneal),Some("owned-task"),None,Action::Close,"archive-request").unwrap();
 let result=crate::execution::transport::send(Engine::Anneal,&endpoint,"",&request).await;
 let _=done.send(());server.await.unwrap();
 assert!(result.is_ok(),"ANNEAL_ARCHIVE_RETURNS_TASK_DIRECTLY {result:?}");
 assert_eq!(result.unwrap().body["id"],"owned-task");
 println!("LONGRUN_ARCHIVE_PASS: actual upstream task-shaped acknowledgement accepted; only an owned task archive was requested");
}
