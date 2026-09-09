//! Local JSONL diagnostic for the exact desktop bridge, with no network listener.
//! No automatic executable selection, download, login, model invocation or deletion.
#[path = "../../../src-tauri/src/codex_runtime/mod.rs"]
mod codex_runtime;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
fn main() {
    let hub = codex_runtime::Hub::default();
    let mut input = io::BufReader::new(io::stdin());
    loop {
        let mut line = Vec::new();
        if !matches!(input.by_ref().take(32769).read_until(b'\n',&mut line),Ok(n) if n>0) {
            break;
        }
        if line.len() > 32768 || !line.ends_with(b"\n") {
            break;
        }
        let result=(||->Result<Value,String>{let value:Value=serde_json::from_slice(&line).map_err(|_|"INVALID_JSON")?;
            match value["op"].as_str(){
                Some("connect")=>hub.connect(serde_json::from_value(value["config"].clone()).map_err(|_|"INVALID_CONFIG")?),
                Some("status")=>Ok(hub.status()),
                Some("call")=>Ok(hub.call(value["name"].as_str().ok_or("NAME_REQUIRED")?,&value["args"])),
                Some("answer")=>hub.answer(value["question_id"].as_str().ok_or("QUESTION_REQUIRED")?,value["answers"].clone()),
                Some("digest")=>Ok(json!({"ok":true,"sha256":codex_runtime::executable_digest(std::path::Path::new(value["path"].as_str().ok_or("PATH_REQUIRED")?))?})),
                Some("disconnect")=>{hub.disconnect();Ok(hub.status())},
                _=>Err("UNKNOWN_OPERATION".into()),
            }
        })().unwrap_or_else(|error|json!({"ok":false,"error":{"code":error}}));
        if writeln!(io::stdout(), "{result}").is_err() {
            break;
        }
    }
    hub.disconnect();
}
