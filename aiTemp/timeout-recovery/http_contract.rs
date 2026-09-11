use super::*;
use std::time::Duration;

#[test]
fn recovery_contract_authenticated_lookup_works_when_execution_slots_are_full() {
    let root=std::env::current_dir().unwrap().join("aiTemp/timeout-http").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(root.join("workspace")).unwrap();
    crate::data::with_test_file(root.join("config/profiles.json"),||{
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(check(root));
    });
}
async fn check(root: PathBuf) {
    let mut ctx=crate::tools::ToolContext::for_test(root.join("workspace"),root.join("harness")).unwrap();
    ctx.auth.auth_type="bearer".into();ctx.tool_profile="advanced".into();
    let ctx=Arc::new(ctx);
    let state=ListenerState{mcp:ctx.clone(),auth:ctx.auth.clone(),workspace_id:root.join("logs").to_string_lossy().into_owned(),
        bind_port:28767,configured_public_url:String::new(),bearer_token:Some("synthetic-recovery-bearer".into()),oauth:None,oauth_client_secret:None};
    let socket=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port=socket.local_addr().unwrap().port();let (shutdown,rx)=oneshot::channel();
    let server=tokio::spawn(async move{serve(socket,port,state,rx).await.unwrap();});
    let url=format!("http://127.0.0.1:{port}/mcp");
    let client=reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
    let request=json!({"jsonrpc":"2.0","id":"original","method":"tools/call","params":{"name":"server_info","arguments":{}}});
    let response=client.post(&url).bearer_auth("synthetic-recovery-bearer").json(&request).send().await.unwrap();
    assert_eq!(response.status(),200);
    let operation=response.headers()["x-mcp-operation-id"].to_str().unwrap().to_string();
    let original:Value=response.json().await.unwrap();assert_eq!(original["result"]["isError"],false);
    assert_eq!(original["result"]["_meta"]["coding-tools-mcp/operation"]["operation_id"],operation);
    let lookup=json!({"jsonrpc":"2.0","id":"poll","method":"tools/call","params":{"name":"mcp_operation_status","arguments":{"operation_id":operation,"include_result":true},"_meta":{"openai/session":"query-must-not-bootstrap-history"}}});
    assert_eq!(client.post(&url).json(&lookup).send().await.unwrap().status(),401);
    let mut slots=Vec::new();
    for _ in 0..16 { slots.push(crate::auth::http_security::acquire_tool_worker().unwrap()); }
    let polled=client.post(&url).bearer_auth("synthetic-recovery-bearer").json(&lookup).send().await.unwrap();
    assert_eq!(polled.status(),200);let polled:Value=polled.json().await.unwrap();
    let structured=&polled["result"]["structuredContent"];
    assert_eq!(structured["operations"][0]["state"],"completed");
    assert_eq!(structured["operations"][0]["rpc_response"],original);
    assert_eq!(structured["safe_to_retry"],false);
    assert_eq!(client.post(&url).bearer_auth("synthetic-recovery-bearer").json(&request).send().await.unwrap().status(),503);
    assert_eq!(ctx.operations.query(&json!({}),0,&["server_info"]).unwrap()["operations"].as_array().unwrap().len(),1,"Lookup/capacity rejection must not dispatch another tracked operation");
    assert!(!root.join("workspace/docs/history-session").exists(),"Read-only lookup must not create history");
    let other=crate::tools::ToolContext::for_test(root.join("workspace"),root.join("other-harness")).unwrap();
    assert_eq!(other.operations.query(&json!({"operation_id":operation}),0,&["server_info"]).unwrap()["found"],false,"Same directory is not same listener authority");
    let definition=crate::tools::registry::list_tools().into_iter().find(|d|d["name"]=="mcp_operation_status").unwrap();
    assert_eq!(definition["annotations"]["readOnlyHint"],true);
    assert_eq!(definition["annotations"]["destructiveHint"],false);
    assert!(definition["outputSchema"].is_object());
    println!("RECOVERY_SCHEMA_EVIDENCE {}",json!({"definition":definition,"success":structured}));
    drop(slots);let _=shutdown.send(());server.await.unwrap();
    println!("RECOVERY_CONTRACT: real authenticated HTTP lookup bypasses busy worker slots without bootstrap or redispatch; result schema exported");
}
