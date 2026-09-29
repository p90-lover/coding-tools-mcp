use crate::execution::{book::*,model::*};
fn binding()->Binding {Binding{id:"binding-one".into(),workspace_id:"workspace-one".into(),root:"C:/approved/project".into(),roots_revision:"roots-one".into(),policy_stamp:"policy-one".into(),generation:"grant-one".into(),engine:Engine::Paseo,endpoint:"ws://127.0.0.1:6767/ws".into(),provider:"claude".into(),model:"configured".into(),mode:"default".into(),project_id:None,repo_id:None,assignee_id:None,max_duration_min:60,allow_codex:false,enabled:true}}
#[test]
fn book_contract_restart_scope_replay_and_writer_exclusion(){
 let mut book=Book::default();book.configure(binding(),0).unwrap();
 book.prepare("workspace-one","binding-one","board-one","mission-one","Implement scoped task","Do the task",1).unwrap();
 let e=book.find("workspace-one","mission-one").unwrap();assert_eq!(e.mission.phase,Phase::Draft);
 assert!(book.find("workspace-two","mission-one").is_err());
 let reservation=book.reserve("workspace-one","mission-one",0,"create","runtime-one",Action::Create).unwrap();assert!(reservation.dispatch);
 book.acknowledge("workspace-one","mission-one","create",Reply::Created{record_id:"agent-one".into()},2).unwrap();
 let before=book.find("workspace-one","mission-one").unwrap().mission.revision;
 book.reserve("workspace-one","mission-one",before,"start","runtime-one",Action::Start).unwrap();
 let bytes=serde_json::to_vec(&book).unwrap();let mut restored:Book=serde_json::from_slice(&bytes).unwrap();
 restored.recover("workspace-one","runtime-two",3).unwrap();
 let entry=restored.find("workspace-one","mission-one").unwrap();
 assert_eq!(entry.mission.phase,Phase::Unknown);assert!(entry.mission.pending.is_some());
 assert!(!restored.reserve("workspace-one","mission-one",before,"start","runtime-two",Action::Start).unwrap().dispatch);
 restored.prepare("workspace-one","binding-one","board-two","mission-two","Other task","Wait for existing writer",4).unwrap();
 assert!(restored.reserve("workspace-one","mission-two",0,"create-other","runtime-two",Action::Create).is_err());
 let original=serde_json::to_vec(&restored).unwrap();
 assert!(restored.prepare("workspace-two","binding-one","board-three","mission-three","bad","bad",5).is_err());
 assert_eq!(serde_json::to_vec(&restored).unwrap(),original);
 let id=restored.find("workspace-one","mission-one").unwrap().binding_id.clone();
 restored.disable("workspace-one",&id).unwrap();
 assert!(restored.binding("workspace-one",&id).is_err());
 assert_eq!(restored.find("workspace-one","mission-one").unwrap().mission.phase,Phase::Unknown,"Revoking admission must not claim remote work was stopped");
 let mut invalid=binding();invalid.provider="codex".into();
 assert!(invalid.validate().is_err(),"Model-capable Codex grant needs separate explicit consent");
 println!("MISSION_BOOK_PASS: serialized receipts retain unknown work, workspace scope, writer exclusion and revocation without fabricated stopping");
}
