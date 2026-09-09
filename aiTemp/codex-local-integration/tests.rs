use super::*;
use crate::tools::{call_tool, live_policy::commit_updates, registry};
use std::sync::Arc;
fn context() -> Arc<ToolContext> {
    let root = std::env::current_dir()
        .unwrap()
        .join("aiTemp/codex-local-tests")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&root).unwrap();
    let mut ctx = ToolContext::for_test(root.clone(), root.join("harness")).unwrap();
    ctx.auth.auth_type = "bearer".into();
    Arc::new(ctx)
}
fn questions(id: &str) -> Value {
    json!({"request_id":id,"questions":[{"id":"review","header":"Review","question":"Which change should be reviewed?","options":[{"label":"Connection","description":"Review MCP transport."},{"label":"Resources","description":"Review resource boundaries."}]}]})
}
fn nonce(ctx: &ToolContext, id: &str) -> String {
    let list = ctx
        .human_inputs
        .pending(ctx.current_policy_revision().unwrap())
        .unwrap();
    list.as_array()
        .unwrap()
        .iter()
        .find(|v| v["request_id"] == id)
        .unwrap()["answer_nonce"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
fn codex_local_resources_have_schemas_real_content_and_listener_boundaries() {
    let ctx = context();

    for profile in [
        "core",
        "read-only",
        "advanced",
        "compat-readonly-all",
        "full",
        "unknown",
    ] {
        let catalog = registry::list_tools_for_profile(profile);
        assert!(!catalog.is_empty());
        for name in [
            "update_plan",
            "get_plan",
            "tool_search",
            "get_current_time",
            "codex_tools_status",
        ] {
            assert!(
                catalog.iter().any(|t| t["name"] == name),
                "{profile} omits {name}"
            );
        }
    }
    for name in NAMES {
        let catalog = registry::list_tools_for_profile("core");
        let schema = catalog
            .iter()
            .find(|t| t["name"] == *name)
            .expect("registered tool");
        assert_eq!(schema["inputSchema"]["type"], "object");
        assert_eq!(schema["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            schema["annotations"]["readOnlyHint"],
            *name != "request_user_input"
        );
    }
    let advanced = registry::list_tools_for_profile("advanced");
    assert_eq!(
        advanced,
        registry::list_tools_for_profile("compat-readonly-all")
    );
    let owned = tauri::async_runtime::block_on(async {
        #[cfg(windows)]
        let mut command = {
            let mut c = tokio::process::Command::new("cmd.exe");
            c.args(["/D", "/C", "echo owned-resource-output"]);
            c
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut c = tokio::process::Command::new("/bin/sh");
            c.args(["-c", "printf owned-resource-output"]);
            c
        };
        let child = command
            .current_dir(ctx.workspace.root())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let session = ctx.sessions.insert(session::ExecSession::new(child));
        session.spawn_readers().await;
        session.child.lock().await.wait().await.unwrap();
        session.wait_for_readers().await;
        session.session_id.clone()
    });
    let uri = format!("coding-tools://command/{owned}/stdout?limit=4096");
    let read = call_tool(
        &ctx,
        "read_mcp_resource",
        &json!({"server":SERVER,"uri":uri}),
    );
    assert_eq!(read["ok"], true, "{read}");
    let data: Value = serde_json::from_str(read["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert!(data["content"]
        .as_str()
        .unwrap()
        .contains("owned-resource-output"));
    let unrelated = context();
    assert_eq!(
        call_tool(
            &unrelated,
            "read_mcp_resource",
            &json!({"server":SERVER,"uri":uri})
        )["ok"],
        false
    );
    let plan = call_tool(
        &ctx,
        "update_plan",
        &json!({"plan":[{"step":"Verify resource content","status":"in_progress"}]}),
    );
    assert_eq!(plan["ok"], true, "{plan}");
    let list = call_tool(&ctx, "list_mcp_resources", &json!({}));
    assert_eq!(list["resources"].as_array().unwrap().len(), 2);
    for item in list["resources"].as_array().unwrap() {
        let r = call_tool(
            &ctx,
            "read_mcp_resource",
            &json!({"server":item["server"],"uri":item["uri"]}),
        );
        assert_eq!(r["ok"], true, "{r}");
        let contents: Value =
            serde_json::from_str(r["contents"][0]["text"].as_str().unwrap()).unwrap();
        if item["uri"] == "coding-tools://workspace/plan" {
            assert_eq!(contents["plan"][0]["step"], "Verify resource content");
        }
    }
    for uri in [
        "file:///etc/passwd",
        "https://example.com/",
        "coding-tools://command/unknown/stdout",
        "coding-tools://command/unknown/stdout?limit=99999",
        "coding-tools://command/unknown/stdout?limit=1&limit=2",
    ] {
        assert_eq!(
            call_tool(
                &ctx,
                "read_mcp_resource",
                &json!({"server":SERVER,"uri":uri})
            )["ok"],
            false,
            "{uri}"
        );
    }
    assert_eq!(
        call_tool(&ctx, "list_mcp_resources", &json!({"server":"other"}))["ok"],
        false
    );
    for (method, key) in [
        ("resources/list", "resources"),
        ("resources/templates/list", "resourceTemplates"),
        ("resources/read", "contents"),
    ] {
        let params = if method == "resources/read" {
            json!({"uri":"coding-tools://workspace/environment"})
        } else {
            json!({})
        };
        let r = crate::mcp::server::handle_request(
            &ctx,
            &json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}),
        );
        assert!(r["result"][key].is_array(), "{r}");
    }
    let status = call_tool(&ctx, "codex_tools_status", &json!({}));
    assert_eq!(status["all_upstream_tools_integrated"], false);
    assert_eq!(status["upstream_commit"], UPSTREAM);
    assert!(status["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == "request_user_input"));
}
#[test]
fn codex_local_human_answers_are_real_local_bound_and_revoked() {
    let ctx = context();
    let other = context();
    let args = questions("review-1");
    let first = call_tool(&ctx, "request_user_input", &args);
    assert_eq!(first["status"], "pending");
    assert_eq!(first["grants_permissions"], false);
    assert!(first.get("answer_nonce").is_none());
    assert_eq!(
        call_tool(&other, "read_user_input", &json!({"request_id":"review-1"}))["ok"],
        false
    );
    assert_eq!(
        call_tool(&ctx, "request_user_input", &args)["request_id"],
        first["request_id"]
    );
    let mut wrong = args.clone();
    wrong["questions"][0]["question"] = json!("Different");
    assert_eq!(call_tool(&ctx, "request_user_input", &wrong)["ok"], false);
    let answer = json!({"review":{"answers":["Connection"]}});
    assert!(ctx
        .human_inputs
        .answer("review-1", "stale-form", answer.clone(), false, 0)
        .is_err());
    assert_eq!(
        call_tool(
            &ctx,
            "request_user_input",
            &json!({"questions":args["questions"],"answers":answer})
        )["ok"],
        false
    );
    let stamp = nonce(&ctx, "review-1");
    ctx.human_inputs
        .answer("review-1", &stamp, answer.clone(), false, 0)
        .unwrap();
    let read = call_tool(&ctx, "read_user_input", &json!({"request_id":"review-1"}));
    assert_eq!(read["status"], "answered");
    assert_eq!(read["answers"], answer);
    call_tool(&ctx, "request_user_input", &questions("review-2"));
    let stamp2 = nonce(&ctx, "review-2");
    let mut policy = ctx.for_request().unwrap().policy;
    policy.permission_mode = "read-only".into();
    commit_updates(vec![(ctx.clone(), policy, "core".into())], || Ok(())).unwrap();
    assert_eq!(
        call_tool(&ctx, "read_user_input", &json!({"request_id":"review-2"}))["status"],
        "cancelled"
    );
    assert!(ctx
        .human_inputs
        .answer("review-2", &stamp2, json!({}), true, 1)
        .is_err());
    assert_eq!(
        call_tool(&ctx, "read_user_input", &json!({"request_id":"review-1"}))["answers"],
        Value::Null
    );
    call_tool(&ctx, "request_user_input", &questions("expired"));
    ctx.human_inputs
        .lock()
        .unwrap()
        .get_mut("expired")
        .unwrap()
        .created = Instant::now() - TTL - Duration::from_secs(1);
    assert_eq!(
        call_tool(&ctx, "read_user_input", &json!({"request_id":"expired"}))["ok"],
        false
    );
}
#[test]
fn codex_local_waits_are_bounded_check_first_and_permission_interruptible() {
    let ctx = context();
    let ready = call_tool(&ctx, "wait_for_environment", &json!({"timeout_ms":0}));
    assert_eq!(ready["ready"], true, "{ready}");
    assert_eq!(ready["network_used"], false);
    for args in [
        json!({"duration_ms":0}),
        json!({"duration_ms":5001}),
        json!({"duration_ms":-1}),
        json!({"duration_ms":1,"command":"no"}),
    ] {
        assert_eq!(call_tool(&ctx, "clock_sleep", &args)["ok"], false);
    }
    let short = call_tool(&ctx, "clock_sleep", &json!({"duration_ms":1}));
    assert_eq!(short["ok"], true);
    assert!(short["elapsed_ms"].as_u64().unwrap() >= 1);
    let active = ctx.for_request().unwrap();
    let updating = ctx.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let task = std::thread::spawn(move || {
        tx.send(()).unwrap();
        call(&active, "clock_sleep", &json!({"duration_ms":5000}))
    });
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let mut policy = updating.for_request().unwrap().policy;
    policy.permission_mode = "read-only".into();
    commit_updates(vec![(updating, policy, "core".into())], || Ok(())).unwrap();
    assert!(task.join().unwrap().is_err());
    assert!(!crate::tools::live_policy::fence_entire_call("clock_sleep"));
    assert!(!crate::tools::live_policy::fence_entire_call(
        "wait_for_environment"
    ));
}
