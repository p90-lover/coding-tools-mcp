#[test]
fn execution_desktop_scoped_mission_roundtrip_and_no_replay(){
 use crate::{data::DataStore,integrations::execution::{service,model::Engine},tools::{ToolContext,dispatch::call_tool_mcp}};
 use serde_json::{json,Value};use std::{sync::{Arc,Mutex,atomic::{AtomicUsize,Ordering}},time::Duration};
 use futures_util::{SinkExt,StreamExt};
 let root=std::env::current_dir().unwrap().join("aiTemp/execution-desktop").join(uuid::Uuid::new_v4().to_string());
 let workspace=root.join("workspace");std::fs::create_dir_all(&workspace).unwrap();let data_file=root.join("app/data/profiles.json");
 crate::data::with_test_file(data_file.clone(),||{
  tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async{
   let source=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("ws://{}/ws",source.local_addr().unwrap());
   let snapshot=Arc::new(Mutex::new(Value::Null));let sent=Arc::new(AtomicUsize::new(0));let requests=Arc::new(AtomicUsize::new(0));
   let (done,mut end)=tokio::sync::oneshot::channel();let s=snapshot.clone();let start_count=sent.clone();let count=requests.clone();
   let server=tokio::spawn(async move{
    loop {tokio::select!{_=&mut end=>break,accepted=source.accept()=>{
     let(stream,_)=accepted.unwrap();let s=s.clone();let started=start_count.clone();let requests=count.clone();
     tokio::spawn(async move{
      let mut ws=tokio_tungstenite::accept_async(stream).await.unwrap();let _hello=ws.next().await.unwrap().unwrap();
      ws.send(tokio_tungstenite::tungstenite::Message::text(json!({"type":"session","message":{"type":"status","payload":{"status":"server_info","serverId":"owned-test-source"}}}).to_string())).await.unwrap();
      let raw=ws.next().await.unwrap().unwrap();let value:Value=serde_json::from_str(raw.to_text().unwrap()).unwrap();let message=&value["message"];
      requests.fetch_add(1,Ordering::SeqCst);let key=message["requestId"].clone();
      let response=match message["type"].as_str().unwrap(){
       "create_agent_request"=>{
        assert!(message.get("initialPrompt").is_none());
        let agent=json!({"id":"owned-agent","provider":message["config"]["provider"],"cwd":message["config"]["cwd"],"status":"idle","activeTurn":null,"pendingPermissions":[],"updatedAt":"2026-09-12T00:00:00Z","labels":message["labels"]});
        *s.lock().unwrap()=agent.clone();json!({"type":"status","payload":{"status":"agent_created","requestId":key,"agentId":"owned-agent","agent":agent}})
       },
       "fetch_agent_request"=>json!({"type":"fetch_agent_response","payload":{"requestId":key,"agent":s.lock().unwrap().clone(),"error":null}}),
       "send_agent_message_request"=>{started.fetch_add(1,Ordering::SeqCst);json!({"type":"send_agent_message_response","payload":{"requestId":key,"agentId":"owned-agent","accepted":true,"error":null}})},
       _=>panic!("Unexpected source operation {message}"),
      };
      ws.send(tokio_tungstenite::tungstenite::Message::text(json!({"type":"session","message":response}).to_string())).await.unwrap();
     });
    }}}
   });
   let profile=crate::workspace::WorkspaceProfile::new(workspace.to_string_lossy().into_owned(),Some("fixture".into()));
   DataStore::update_file(|d|{d.profiles.push(profile.clone());Ok(())}).unwrap();
   let mut ctx=ToolContext::for_test(workspace.clone(),root.join("harness")).unwrap();ctx.auth.auth_type="bearer".into();ctx.workspace_id=Some(profile.id.clone());ctx.tool_profile="advanced".into();let ctx=Arc::new(ctx);
   let created=call_tool_mcp(&ctx,"workflow_update",&json!({"expected_revision":0,"change":{"operation":"create","title":"Owned source task","description":"Only a synthetic transport fixture"}}));
   assert_eq!(created["ok"],true,"{created}");let task=created["task"]["id"].as_str().unwrap().to_string();
   let configured=service::configure(&ctx.for_request().unwrap(),0,service::Settings{id:Some("binding-one".into()),engine:Engine::Paseo,endpoint,provider:"claude".into(),model:"fixture-model".into(),mode:"default".into(),project_id:None,repo_id:None,assignee_id:None,max_duration_min:60,allow_codex:false,confirm_external_execution:true},"".into()).unwrap();
   assert_eq!(configured["bindings"][0]["connected"],true);
   let prepared=call_tool_mcp(&ctx,"workflow_update",&json!({"expected_revision":1,"change":{"operation":"agent_prepare","binding_id":"binding-one","task_id":task,"mission_id":"mission-one"}}));
   assert_eq!(prepared["ok"],true,"{prepared}");
   fn approve(ctx:&ToolContext,mut args:Value)->Value{
    let first=call_tool_mcp(ctx,"workflow_update",&args);
    if first.pointer("/error/code").and_then(Value::as_str)!=Some("APPROVAL_REQUIRED"){return first}
    let id=first["error"]["details"]["request_id"].as_str().unwrap();
    let grant=call_tool_mcp(ctx,"request_permissions",&json!({"request_id":id,"scope":"once","confirm":true}));
    assert_eq!(grant["ok"],true,"{grant}");args["approval_token"]=grant["approval_token"].clone();call_tool_mcp(ctx,"workflow_update",&args)
   }
   async fn wait_phase(ctx:&ToolContext,phase:&str)->Value{
    tokio::time::timeout(Duration::from_secs(8),async{loop{
     let value=call_tool_mcp(ctx,"workflow_list",&json!({"mission_id":"mission-one"}));
     assert_eq!(value["ok"],true,"{value}");
     if value["execution"]["missions"][0]["mission"]["phase"]==phase{return value}
     tokio::time::sleep(Duration::from_millis(10)).await;
    }}).await.unwrap()
   }
   let create=approve(&ctx,json!({"expected_revision":0,"change":{"operation":"agent_control","mission_id":"mission-one","request_key":"create","action":"create"}}));
   assert_eq!(create["ok"],true,"{create}");let ready=wait_phase(&ctx,"ready").await;
   let revision=ready["execution"]["missions"][0]["mission"]["revision"].as_u64().unwrap();
   let input=json!({"expected_revision":revision,"change":{"operation":"agent_control","mission_id":"mission-one","request_key":"start","action":"start"}});
   let start=approve(&ctx,input.clone());assert_eq!(start["ok"],true,"{start}");wait_phase(&ctx,"running").await;
   let count=requests.load(Ordering::SeqCst);let retry=approve(&ctx,input);assert_eq!(retry["ok"],true,"{retry}");
   assert_eq!(requests.load(Ordering::SeqCst),count);assert_eq!(sent.load(Ordering::SeqCst),1,"A repeat request key must not redispatch a prompt");
   let refresh=call_tool_mcp(&ctx,"workflow_list",&json!({"mission_id":"mission-one","refresh_source":true}));assert_eq!(refresh["ok"],true,"{refresh}");
   let review=wait_phase(&ctx,"review_required").await;let rev=review["execution"]["missions"][0]["mission"]["revision"].as_u64().unwrap();
   let reviewed=approve(&ctx,json!({"expected_revision":rev,"change":{"operation":"agent_review","mission_id":"mission-one","note":"Fixture evidence reviewed","evidence":["fixture:result"],"accepted":true}}));
   assert_eq!(reviewed["ok"],true,"{reviewed}");
   let saved=std::fs::read_to_string(&data_file).unwrap();assert!(saved.contains("mission-one"));assert!(!saved.contains("credential"));
   let mut policy=ctx.for_request().unwrap().policy;policy.permission_mode="read-only".into();crate::tools::live_policy::commit_updates(vec![(ctx.clone(),policy,"read-only".into())],||Ok(())).unwrap();
   let denied=call_tool_mcp(&ctx,"workflow_update",&json!({"expected_revision":0,"change":{"operation":"agent_control","mission_id":"mission-one","request_key":"new-write","action":"start"}}));assert_eq!(denied["ok"],false);
   assert_eq!(sent.load(Ordering::SeqCst),1);
   let _=done.send(());server.await.unwrap();
   println!("EXECUTION_DESKTOP_PASS: actual AppData and workflow dispatcher reserve before real fixture IO, enforce scoped approvals, persist review, deny replay and respect live read-only revocation; no inference used");
  });
 });
}
