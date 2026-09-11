use super::*;
use std::time::{Duration,Instant};
#[test]
fn quick_live_control_under_load_keeps_auth_and_execution_limits(){
    let root=std::env::current_dir().unwrap().join("aiTemp/quick-http").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(root.join("workspace")).unwrap();
    crate::data::with_test_file(root.join("config/profiles.json"),||{
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(check(root));
    });
}
async fn check(root:PathBuf){
    let mut ctx=crate::tools::ToolContext::for_test(root.join("workspace"),root.join("harness")).unwrap();
    ctx.auth.auth_type="bearer".into();ctx.tool_profile="read-only".into();let ctx=Arc::new(ctx);
    let state=ListenerState{mcp:ctx.clone(),auth:ctx.auth.clone(),workspace_id:root.join("logs").to_string_lossy().into_owned(),bind_port:28769,configured_public_url:String::new(),bearer_token:Some("synthetic-control-token".into()),oauth:None,oauth_client_secret:None};
    let socket=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let port=socket.local_addr().unwrap().port();
    let (end,rx)=oneshot::channel();let server=tokio::spawn(async move{serve(socket,port,state,rx).await.unwrap();});
    let url=format!("http://127.0.0.1:{port}/mcp");let client=reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
    let mut slots=Vec::new();for _ in 0..16{slots.push(crate::auth::http_security::acquire_tool_worker().unwrap());}
    let mut latencies=Vec::new();
    for method in ["ping","initialize","tools/list"] {
        let body=json!({"jsonrpc":"2.0","id":method,"method":method,"params":{"protocolVersion":"2025-11-25"}});
        assert_eq!(client.post(&url).json(&body).send().await.unwrap().status(),401);
        assert_eq!(client.post(&url).bearer_auth("synthetic-control-token").header("Origin","https://attacker.invalid").json(&body).send().await.unwrap().status(),403);
        let start=Instant::now();let response=client.post(&url).bearer_auth("synthetic-control-token").json(&body).send().await.unwrap();
        assert_eq!(response.status(),200,"CONTROL_BLOCKED_BY_BUSY_TOOL_WORKERS");
        let value:Value=response.json().await.unwrap();assert_eq!(value["id"],method);assert!(value.get("error").is_none());
        latencies.push(json!({"method":method,"milliseconds":start.elapsed().as_micros() as f64/1000.0}));
        if method=="tools/list"{
            let names=value["result"]["tools"].as_array().unwrap().iter().map(|v|v["name"].as_str().unwrap()).collect::<Vec<_>>();
            assert!(!names.contains(&"exec_command")&&!names.contains(&"sandbox_exec"));
            assert!(names.contains(&"mcp_operation_status"));
        }
    }
    let modern=json!({"jsonrpc":"2.0","id":"modern","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}});
    let modern_response=client.post(&url).bearer_auth("synthetic-control-token").header("mcp-protocol-version","2026-07-28").header("mcp-method","server/discover").json(&modern).send().await.unwrap();
    assert_eq!(modern_response.status(),200);assert!(modern_response.json::<Value>().await.unwrap().get("error").is_none());
    assert_eq!(client.post(&url).bearer_auth("synthetic-control-token").header("mcp-protocol-version","2026-07-28").header("mcp-method","tools/call").json(&modern).send().await.unwrap().status(),400);
    for tool in ["server_info","ping"]{
        let call=json!({"jsonrpc":"2.0","id":"not-control","method":"tools/call","params":{"name":tool,"arguments":{}}});
        assert_eq!(client.post(&url).bearer_auth("synthetic-control-token").json(&call).send().await.unwrap().status(),503,"A tool name must not bypass execution admission");
    }
    let status=json!({"jsonrpc":"2.0","id":"recovery","method":"tools/call","params":{"name":"mcp_operation_status","arguments":{}}});
    let status=client.post(&url).bearer_auth("synthetic-control-token").json(&status).send().await.unwrap().json::<Value>().await.unwrap();
    assert_eq!(status["result"]["structuredContent"]["operations"],json!([]));
    assert!(!root.join("workspace/docs/history-session").exists());
    drop(slots);let _=end.send(());server.await.unwrap();
    println!("QUICK_HTTP_EVIDENCE {}",json!({"latencies":latencies,"occupied_execution_slots":16,"auth_origin_protocol_checked":true,"read_only_profile_retained":true,"tool_execution_not_retried":true,"public_network_measured":false}));
}
