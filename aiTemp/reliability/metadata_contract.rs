#[test]
fn reliability_task_events_schema_and_capability_discovery() {
    use serde_json::json;
    use crate::tools::{ToolContext,registry};
    use crate::tools::dispatch::call_tool_mcp;
    let directory=std::env::current_dir().unwrap().join("aiTemp/reliability-metadata").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(directory.join("workspace")).unwrap();
    let mut ctx=ToolContext::for_test(directory.join("workspace"),directory.join("harness")).unwrap();
    ctx.tool_profile="advanced".into();
    let definition=registry::list_tools().into_iter().find(|v|v["name"]=="list_task_events").unwrap();
    assert!(definition["outputSchema"].is_object(),"TASK_EVENTS_OUTPUT_SCHEMA_MISSING");
    let task=ctx.harness.start_task("Synthetic schema fixture; no agent or provider request").unwrap();
    ctx.harness.record_event(&task.id,"fixture",Some("read_file"),json!({"path":"fixture.txt"}),json!({"ok":true})).unwrap();
    let first=call_tool_mcp(&ctx,"list_task_events",&json!({"task_id":task.id,"limit":1}));
    assert_eq!(first["ok"],true);
    assert_eq!(first["events"].as_array().unwrap().len(),1);
    let next=call_tool_mcp(&ctx,"list_task_events",&json!({"task_id":task.id,"cursor":first["next_cursor"],"limit":200}));
    assert_eq!(next["ok"],true);
    let empty=call_tool_mcp(&ctx,"list_task_events",&json!({"task_id":task.id,"cursor":10000,"limit":1}));
    assert_eq!(empty["ok"],true);assert_eq!(empty["events"],json!([]));
    let invalid=call_tool_mcp(&ctx,"list_task_events",&json!({}));
    assert_eq!(invalid["ok"],false);
    for profile in ["advanced","core","read-only"] {
        ctx.tool_profile=profile.into();
        let status=call_tool_mcp(&ctx,"codex_tools_status",&json!({}));
        assert_eq!(status["ok"],true);
        let reported=status["tools"].as_array().unwrap();
        let exposed=registry::exposed_tool_names(profile);
        for name in ["sandbox_status","sandbox_exec","mcp_operation_status"] {
            assert_eq!(reported.contains(&json!(name)),exposed.contains(&name),"CAPABILITY_REPORT_OMITS_RELEASED_TOOL {profile}/{name}");
        }
        assert_eq!(status["codex_invoked"],false);
        assert_eq!(status["inference_client_in_this_path"],false);
    }
    println!("RELIABILITY_SCHEMA_EVIDENCE {}",json!({"definition":definition,"samples":[first,next,empty,invalid]}));
    println!("RELIABILITY_METADATA: actual shared-dispatch event pages/errors and profile-filtered sandbox/recovery discovery; no model invoked");
}
