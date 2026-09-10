//! Coverage is deliberately split: fixture execution is not live provider/desktop acceptance.
use crate::tools::{dispatch::call_tool_mcp, registry, wrap_mcp_tool_result, ToolContext};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, fs, path::PathBuf, process::Command};

fn retained_fixture() -> (PathBuf, ToolContext) {
    let base = std::env::current_dir().unwrap().join("aiTemp/tool-contracts")
        .join(uuid::Uuid::new_v4().to_string());
    let root = base.join("workspace");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("hello.txt"), "fixture line one\nfixture line two\n").unwrap();
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    fs::copy(repo.join("src-tauri/icons/32x32.png"), root.join("fixture-icon.png")).unwrap();
    // A retained, synthetic repository: no user source or credentials are used.
    for args in [vec!["init","-q"],vec!["config","gc.auto","0"],
                 vec!["add","--","hello.txt","fixture-icon.png"],
                 vec!["-c","user.name=Fixture","-c","user.email=fixture@example.invalid",
                     "commit","-q","-m","retained contract fixture"]] {
        assert!(Command::new("git").current_dir(&root).args(args).status().unwrap().success());
    }
    let ctx = ToolContext::for_test(root, base.join("harness")).unwrap();
    (base,ctx)
}
fn sample(ctx: &ToolContext, name: &str, args: Value, rows: &mut Vec<Value>, require_ok: bool, mode: &str) -> Value {
    let result = call_tool_mcp(ctx, name, &args);
    if require_ok { assert_eq!(result["ok"],true,"{name}: {result}"); }
    assert!(result["ok"].is_boolean(),"MISSING_RESULT_ENVELOPE {name}: {result}");
    let wire = wrap_mcp_tool_result(name, &args, result.clone());
    assert_eq!(wire["isError"], result["ok"]==false, "{name}");
    let texts: Vec<_> = wire["content"].as_array().unwrap().iter()
        .filter(|v|v["type"]=="text").collect();
    assert_eq!(texts.len(),1,"{name}");
    let compatibility:Value = serde_json::from_str(texts[0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(compatibility,wire["structuredContent"],"TEXT_AND_STRUCTURED_DIVERGED {name}");
    rows.push(json!({"tool":name,"scope":mode,"args":args,"wire":wire}));
    result
}
#[test]
fn integration_contract_catalog_and_actual_safe_wire_results() {
    let (base,ctx) = retained_fixture();
    let catalog = registry::list_tools();
    let names: BTreeSet<_> = catalog.iter().map(|v|v["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names.len(),70);
    for profile in ["core","read-only","advanced","full","compat-readonly-all"] {
        for definition in registry::list_tools_for_profile(profile) {
            assert_eq!(definition["outputSchema"]["type"],"object","OUTPUT_SCHEMA_MISSING {}",definition["name"]);
            assert_eq!(definition["outputSchema"]["properties"]["ok"]["type"],"boolean");
        }
    }
    let mut rows = Vec::new();
    for (name,args) in [
        ("server_info",json!({})),("codex_tools_status",json!({})),
        ("get_current_time",json!({})),("tool_search",json!({"query":"list_task_events"})),
        ("get_plan",json!({})),("update_plan",json!({"expected_revision":0,"plan":[{"step":"Inspect metadata","status":"in_progress"}]})),
        ("get_default_cwd",json!({})),("set_default_cwd",json!({"path":"."})),
        ("check_exec_environment",json!({})),("vision_status",json!({})),
        ("read_file",json!({"path":"hello.txt","max_bytes":24})),
        ("list_dir",json!({"path":"."})),("list_files",json!({"glob":"*.txt"})),
        ("search_text",json!({"query":"fixture","path":"hello.txt"})),
        ("grep_text",json!({"query":"fixture","path":"hello.txt"})),
        ("git_status",json!({})),("git_diff",json!({})),("git_log",json!({"max_count":1})),
        ("git_show",json!({"ref":"HEAD","path":"hello.txt"})),("git_blame",json!({"path":"hello.txt"})),
        ("image_info",json!({"path":"fixture-icon.png"})),("view_image",json!({"path":"fixture-icon.png"})),
        ("compare_images",json!({"before_path":"fixture-icon.png","after_path":"fixture-icon.png"})),
    ] { sample(&ctx,name,args,&mut rows,true,"actual_retained_fixture"); }
    // Exercise additive patching only. No remove-file patch or deletion command.
    let patch = "*** Begin Patch\n*** Add File: added.txt\n+created in a retained fixture\n*** End Patch";
    sample(&ctx,"patch_check",json!({"patch":patch}),&mut rows,true,"actual_retained_fixture");
    sample(&ctx,"apply_patch",json!({"patch":patch}),&mut rows,true,"actual_retained_fixture");
    assert!(ctx.workspace.root().join("added.txt").is_file());
    let history = sample(&ctx,"history_session_bootstrap",json!({"session_key":"contract-fixture","initial_user_input":"synthetic request"}),&mut rows,true,"actual_retained_fixture");
    let path=history["current_path"].as_str().expect("history current path");
    sample(&ctx,"history_session_checkpoint",json!({"session_key":"contract-fixture","expected_path":path,"turn_id":"fixture-turn","raw_user_input":"synthetic request","findings":["retained test evidence"]}),&mut rows,true,"actual_retained_fixture");
    for (name,args) in [("history_session_validate",json!({"repair":false})),
        ("history_session_search",json!({"query":"synthetic"})),("history_session_read",json!({"path":path}))] {
        sample(&ctx,name,args,&mut rows,true,"actual_retained_fixture");
    }
    let task = sample(&ctx,"start_task",json!({"objective":"Verify structured result contracts"}),&mut rows,true,"actual_retained_fixture");
    let id=task["task"]["id"].as_str().unwrap();
    for (name,args) in [("harness_status",json!({})),("project_state",json!({})),
        ("update_task",json!({"task_id":id,"completed_steps":["Metadata inspected"]})),
        ("pause_task",json!({"task_id":id})),("resume_task",json!({"task_id":id})),
        ("task_context",json!({"task_id":id})),("list_task_events",json!({"task_id":id,"limit":2})),
        ("change_summary",json!({"task_id":id})),("operation_log",json!({"limit":5})),
        ("finish_task",json!({"task_id":id,"allow_unverified":true}))] {
        sample(&ctx,name,args,&mut rows,true,"actual_retained_fixture");
    }
    // Successful local status reads never start a native App Server.
    let mut authenticated=ctx.clone();
    authenticated.auth.auth_type="bearer".into();
    sample(&authenticated,"codex_runtime_status",json!({}),&mut rows,true,"disconnected_local_status");
    // Every remaining catalog function receives a safe rejection/status probe.
    // This is not reported as successful GUI input or paid provider execution.
    let covered: BTreeSet<String>=rows.iter().map(|v|v["tool"].as_str().unwrap().into()).collect();
    for name in names.difference(&covered) {
        let args = match name.as_str() {
            "exec_command" => json!({"cmd":"__nonexistent_contract_command__"}),
            "exec_health_check" => json!({}), // fixed echo-only native health probe
            "codex_agent_control" => json!({"operation":"start","request_id":"blocked-contract","text":"synthetic; must not submit"}),
            "codex_agent_read" => json!({"thread_id":"not-owned"}),
            "codex_command_exec" => json!({"request_id":"blocked-command","argv":["__nonexistent_contract_command__"]}),
            "sandbox_exec" => json!({"argv":["__nonexistent_contract_command__"]}),
            "workflow_update" => json!({"expected_revision":0,"change":{"operation":"create","title":"blocked-noauth"}}),
            "computer_route" => json!({"intent":"inspect"}),
            _ => json!({}),
        };
        sample(&ctx,name,args,&mut rows,false,"guard_or_status_only_not_live_acceptance");
    }
    // Existing read errors must remain valid under the same outputSchema.
    sample(&ctx,"read_file",json!({"path":"missing.txt"}),&mut rows,false,"negative_fixture");
    sample(&ctx,"list_task_events",json!({}),&mut rows,false,"negative_fixture");
    // Model operations stay denied even with an authenticated but disabled bridge.
    for operation in ["start","send","review","compact","interrupt","close"] {
        let v=sample(&authenticated,"codex_agent_control",json!({"operation":operation,
            "request_id":format!("disabled-{operation}"),"thread_id":"not-owned","text":"synthetic boundary check"}),
            &mut rows,false,"disabled_bridge_permission_boundary");
        assert_eq!(v["ok"],false,"DISABLED_BRIDGE_SUBMITTED_MODEL_REQUEST {operation}");
    }
    let mut coverage:BTreeMap<String,Vec<String>>=BTreeMap::new();
    for row in &rows {coverage.entry(row["tool"].as_str().unwrap().into()).or_default().push(row["scope"].as_str().unwrap().into());}
    assert_eq!(coverage.keys().cloned().collect::<BTreeSet<_>>(),names);
    let report=json!({"source":std::env::var("SOURCE").unwrap_or_else(|_|"local".into()),
        "catalog":catalog,"samples":rows,"coverage":coverage,"catalog_tools":70,
        "model_requests":0,"live_user_acceptance":false,"test_fixture":base});
    let repo=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    fs::create_dir_all(repo.join("aiTemp/evidence")).unwrap();
    fs::write(repo.join("aiTemp/evidence/tool-contracts.json"),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("PASS: all 70 registered tools have result schemas and recorded fixture/boundary coverage; no model session or user desktop acceptance claimed");
}
