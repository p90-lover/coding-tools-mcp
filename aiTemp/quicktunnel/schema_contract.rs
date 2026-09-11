#[test]
fn quick_recovered_schema_real_results(){
    use serde_json::json;
    use crate::tools::{ToolContext,registry,dispatch::call_tool_mcp};
    let base=std::env::current_dir().unwrap().join("aiTemp/quick-schema").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(base.join("workspace")).unwrap();
    std::fs::write(base.join("workspace/fixture.txt"),"繁體中文\nsecond line\n").unwrap();
    let ctx=ToolContext::for_test(base.join("workspace"),base.join("harness")).unwrap();
    let mut evidence=Vec::new();
    for name in ["read_file","operation_log"]{
        let definition=registry::list_tools().into_iter().find(|v|v["name"]==name).unwrap();
        assert!(definition["outputSchema"].is_object(),"RECOVERABLE_SCHEMA_NOT_WIRED");
        let args=if name=="read_file"{json!({"path":"fixture.txt","max_bytes":7})}else{json!({"limit":1})};
        let good=call_tool_mcp(&ctx,name,&args);assert_eq!(good["ok"],true);
        let second=if name=="read_file"{call_tool_mcp(&ctx,name,&json!({"path":"fixture.txt","start_line":999}))}else{call_tool_mcp(&ctx,name,&json!({"cursor":10000}))};
        assert_eq!(second["ok"],true);
        let mut samples=vec![good,second];
        if name=="read_file"{let bad=call_tool_mcp(&ctx,name,&json!({"path":"missing.txt"}));assert_eq!(bad["ok"],false);samples.push(bad);}
        evidence.push(json!({"definition":definition,"samples":samples}));
    }
    assert_eq!(std::fs::read_to_string(base.join("workspace/fixture.txt")).unwrap(),"繁體中文\nsecond line\n");
    println!("QUICK_SCHEMA_EVIDENCE {}",json!({"tools":evidence,"recovered_from":"42ba28765cd54ccc3d84982aa27dec82db083d2f","model_requests":0}));
}
