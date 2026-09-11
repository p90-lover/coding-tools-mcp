use super::*;
use std::time::Duration;
#[test]
fn refresh_contract_same_listener_permission_and_project_changes(){
 let root=std::env::current_dir().unwrap().join("aiTemp/live-refresh-http").join(uuid::Uuid::new_v4().to_string());
 std::fs::create_dir_all(root.join("workspace")).unwrap();std::fs::create_dir_all(root.join("project-two")).unwrap();
 crate::data::with_test_file(root.join("config/profiles.json"),||{tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(check(root));});
}
async fn call(client:&reqwest::Client,url:&str,name:&str,args:Value)->Value{
 let response=client.post(url).bearer_auth("synthetic-refresh-token").json(&json!({"jsonrpc":"2.0","id":name,"method":"tools/call","params":{"name":name,"arguments":args}})).send().await.unwrap();
 assert_eq!(response.status(),200);response.json::<Value>().await.unwrap()["result"]["structuredContent"].clone()
}
async fn check(root:PathBuf){
 let mut context=crate::tools::ToolContext::for_test(root.join("workspace"),root.join("harness")).unwrap();
 context.auth.auth_type="bearer".into();context.tool_profile="advanced".into();let ctx=Arc::new(context);
 let state=ListenerState{mcp:ctx.clone(),auth:ctx.auth.clone(),workspace_id:root.join("logs").to_string_lossy().into_owned(),bind_port:28771,configured_public_url:String::new(),bearer_token:Some("synthetic-refresh-token".into()),oauth:None,oauth_client_secret:None};
 let socket=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let port=socket.local_addr().unwrap().port();
 let (end,rx)=oneshot::channel();let server=tokio::spawn(async move{serve(socket,port,state,rx).await.unwrap();});
 let url=format!("http://127.0.0.1:{port}/mcp");let client=reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
 let first=call(&client,&url,"server_info",json!({})).await;assert_eq!(first["ok"],true);
 let stale=ctx.for_request().unwrap();
 let linked=crate::workspace::linked_projects::quick_add_linked_project_for_root(ctx.workspace.root(),&root.join("project-two"),Some("second")).unwrap();
 let second=call(&client,&url,"server_info",json!({})).await;
 assert!(second["workspace_refresh"]["roots_revision"].is_string(),"ROOT_REFRESH_STATUS_MISSING");
 assert_ne!(first["workspace_refresh"]["roots_revision"],second["workspace_refresh"]["roots_revision"]);
 assert!(stale.workspace.resolve_for_write("@second/not-authorized-by-old-request.txt").is_err(),"STALE_ROOT_SNAPSHOT_GAINED_ACCESS");
 let write=json!({"patch":"*** Begin Patch\n*** Add File: @second/fresh.txt\n+written through existing listener\n*** End Patch\n"});
 let applied=call(&client,&url,"apply_patch",write.clone()).await;assert_eq!(applied["ok"],true,"{applied}");
 let read=call(&client,&url,"read_file",json!({"path":"@second/fresh.txt"})).await;assert_eq!(read["ok"],true);
 let mut policy=ctx.for_request().unwrap().policy;policy.permission_mode="read-only".into();
 crate::tools::live_policy::commit_updates(vec![(ctx.clone(),policy,"advanced".into())],||Ok(())).unwrap();
 let rejected=call(&client,&url,"apply_patch",json!({"patch":"*** Begin Patch\n*** Add File: @second/rejected.txt\n+no\n*** End Patch\n"})).await;
 assert_eq!(rejected["ok"],false);assert!(!root.join("project-two/rejected.txt").exists());
 let status=call(&client,&url,"server_info",json!({})).await;assert_eq!(status["live_permissions"]["revision"],1);
 let active=ctx.for_request().unwrap();
 std::fs::create_dir_all(root.join("Trash")).unwrap();
 std::fs::rename(ctx.workspace.root().join(".mcp-paths").join(format!("{}.txt",linked.alias)),root.join("Trash/second.txt")).unwrap();
 assert!(active.workspace.resolve_for_write("@second/stale.txt").is_err());
 assert_eq!(call(&client,&url,"read_file",json!({"path":"@second/fresh.txt"})).await["ok"],false);
 let mut policy=ctx.for_request().unwrap().policy;policy.permission_mode="workspace-write".into();
 crate::tools::live_policy::commit_updates(vec![(ctx.clone(),policy,"advanced".into())],||Ok(())).unwrap();
 let restored=call(&client,&url,"server_info",json!({})).await;assert_eq!(restored["live_permissions"]["revision"],2);
 assert_eq!(restored["workspace_refresh"]["reconnect_required"],false);
 assert!(root.join("project-two/fresh.txt").is_file());
 let _=end.send(());server.await.unwrap();
 println!("LIVE_REFRESH_HTTP: same bearer listener and shared runtime; add/read/write, read-only revoke, mapping retirement and stale request rejection; no model or delete command");
}
