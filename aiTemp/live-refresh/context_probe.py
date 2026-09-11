"""Focused Rust fixture for the real task_context function; no desktop or model."""
from pathlib import Path
import subprocess,sys
root=Path.cwd().resolve();baseline='--baseline' in sys.argv
out=root/'aiTemp'/('context-red' if baseline else 'context-green');(out/'src').mkdir(parents=True,exist_ok=True)
ref='df473181ed46d764f4f54de4f597fe71c550b9a7'
def content(path):
 return subprocess.check_output(['git','show',ref+':'+path]).decode() if baseline else (root/path).read_text(encoding='utf-8')
(out/'Cargo.toml').write_text('[package]\nname="context-limit-fixture"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nuuid={version="1",features=["v4"]}\nserde={version="1",features=["derive"]}\nserde_json="1"\nthiserror="2"\nsha2="0.10"\nwalkdir="2"\ndirs="6"\ntempfile="3"\n')
code='pub mod harness {\n'
for name in ['model','store','state']:
 p=out/(name+'.rs');p.write_text(content('src-tauri/src/harness/'+name+'.rs'))
 code+='#[path="'+p.as_posix()+'"]pub mod '+name+';\n'
for name in ['bounded_scan','context_view']:
 p=root/('src-tauri/src/harness/'+name+'.rs')
 if not baseline and p.exists():code+='#[path="'+p.as_posix()+'"]pub mod '+name+';\n'
code+='pub use state::Harness;}\n'
text=content('src-tauri/src/harness/tools.rs');function=text[text.index('fn task_context('):text.index('\nfn list_task_events(')]
code+='''use serde_json::{json,Value};
use harness::store::HarnessError;
type WorkspaceError=String;
struct ToolContext{harness:harness::Harness}
fn map_error(e:HarnessError)->String{e.to_string()}
fn tool_error(_: &str, message: impl Into<String>)->String{message.into()}
'''+function+'''
#[test]fn refresh_contract_task_context_obeys_byte_limit(){
 let base=std::env::current_dir().unwrap().join("aiTemp/context-limit-fixture").join(uuid::Uuid::new_v4().to_string());
 std::fs::create_dir_all(base.join("workspace")).unwrap();
 let ctx=ToolContext{harness:harness::Harness::new(base.join("workspace"),base.join("store")).unwrap()};
 let task=ctx.harness.start_task("Synthetic context bound; no model or process").unwrap();
 let large="繁體中文".repeat(16000);
 let event=ctx.harness.record_event(&task.id,"fixture",Some("read_file"),json!({"large":large}),json!({"ok":true})).unwrap();
 // record_event deliberately wraps caller data in input_summary.payload.
 // Preserve the entire stored representation, not a guessed field location.
 let events_before=serde_json::to_vec(&ctx.harness.list_events(&task.id,0,100).unwrap()).unwrap();
 let task_before=serde_json::to_vec(&ctx.harness.task(&task.id).unwrap()).unwrap();
 let result=task_context(&ctx,&json!({"task_id":task.id,"max_bytes":8192})).unwrap();
 let response_bytes=serde_json::to_vec(&result).unwrap().len();
 assert!(response_bytes<=8192,"TASK_CONTEXT_IGNORES_MAX_BYTES");
 assert_eq!(result["truncated"],true);
 assert_eq!(result["task"]["id"],task.id);
 let retained=ctx.harness.list_events(&task.id,0,100).unwrap();
 assert_eq!(serde_json::to_vec(&retained).unwrap(),events_before,"Stored events changed");
 assert_eq!(serde_json::to_vec(&ctx.harness.task(&task.id).unwrap()).unwrap(),task_before,"Stored task changed");
 let original=retained.iter().find(|e|e.id==event.id).unwrap();
 assert_eq!(original.input_summary["payload"]["large"].as_str().unwrap().as_bytes(),large.as_bytes(),"Original payload changed");
 let cursor=result["next_event_cursor"].as_u64().unwrap() as usize;
 assert!(ctx.harness.list_events(&task.id,cursor,100).unwrap().iter().any(|e|e.id==event.id),"Omitted event must remain reachable by returned cursor");
 println!("LIVE_CONTEXT: actual task_context body honors 8192-byte budget; original oversized event retained; response_bytes={response_bytes}");
}
'''
(out/'src/lib.rs').write_text(code)
result=subprocess.run(['cargo','test','--manifest-path',str(out/'Cargo.toml'),'refresh_contract_task_context_','--','--test-threads=1','--nocapture'])
sys.exit(result.returncode)
