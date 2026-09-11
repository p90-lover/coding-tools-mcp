//! Schema for the existing task-event result, including shared structured errors.
//! Additional project-instruction/forward-compatible fields remain allowed.
use serde_json::{json, Value};
pub fn schema() -> Value {
    let file_change = json!({"type":"object","required":["path","status","before_sha256","after_sha256"],"properties":{
        "path":{"type":"string"},"status":{"type":"string"},
        "before_sha256":{"type":["string","null"]},"after_sha256":{"type":["string","null"]}
    }});
    let event = json!({"type":"object","required":["id","task_id","operation_id","kind","tool_name","input_summary","result_summary","reason","affected_files","created_at"],"properties":{
        "id":{"type":"string"},"task_id":{"type":"string"},"operation_id":{"type":"string"},"kind":{"type":"string"},
        "tool_name":{"type":["string","null"]},"input_summary":{},"result_summary":{},
        "reason":{"anyOf":[{"type":"null"},{"type":"object","required":["text","source"],"properties":{"text":{"type":"string"},"source":{"type":"string"}}}]},
        "affected_files":{"type":"array","items":file_change},"created_at":{"type":"string"}
    }});
    json!({"type":"object","required":["ok"],"properties":{
        "ok":{"type":"boolean"},"events":{"type":"array","maxItems":200,"items":event},
        "next_cursor":{"type":"integer","minimum":0},"error":{"type":"object"},
        "summary":{"type":"string"},"status":{"type":"string"}
    },"allOf":[{"if":{"properties":{"ok":{"const":true}}},"then":{"required":["events","next_cursor"]}}]})
}
