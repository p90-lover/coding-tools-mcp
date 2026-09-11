from pathlib import Path
root=Path.cwd().resolve();path=root/'aiTemp/quick-unit/src/lib.rs'
text='\npub mod tools {\n'
for name in ['workflow','codex_runtime','local_tools','native_sandbox']:
 text+='pub mod '+name+' {pub const NAMES:&[&str]=&[];pub fn input_schema(_: &str)->serde_json::Value{serde_json::json!({})}pub fn input(_: &str)->serde_json::Value{serde_json::json!({})}}\n'
text+='pub mod computer {pub mod schema {pub const NAMES:&[&str]=&[];pub const WRITES:&[&str]=&[];pub fn input(_: &str)->serde_json::Value{serde_json::json!({})}}}\n'
for name in ['event_output_schema','recovered_output_schema','registry_definitions']:
 p=root/('src-tauri/src/tools/'+name+'.rs')
 if p.exists():text+='#[path="'+p.as_posix()+'"]pub mod '+name+';\n'
text+='}\n#[test] fn quick_recovered_contracts_are_advertised(){for name in ["read_file","operation_log"]{let d=tools::registry_definitions::list_tools().into_iter().find(|d|d["name"]==name).unwrap();assert!(d["outputSchema"].is_object(),"RECOVERABLE_SCHEMA_NOT_WIRED {name}");}}\n'
with path.open('a') as f:f.write(text)
