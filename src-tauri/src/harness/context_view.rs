//! A bounded view, never a mutation of retained task/history evidence.
use serde_json::{json, Value};
use std::io::{self, Write};
struct Budget { remaining: usize }
impl Write for Budget {
    fn write(&mut self, bytes:&[u8])->io::Result<usize>{
        if bytes.len()>self.remaining{return Err(io::Error::other("context byte budget"));}
        self.remaining-=bytes.len();Ok(bytes.len())
    }
    fn flush(&mut self)->io::Result<()>{Ok(())}
}
fn fits(value:&Value,limit:usize)->bool{serde_json::to_writer(&mut Budget{remaining:limit},value).is_ok()}
pub fn render(task:Value,events:Value,max_bytes:usize)->Value{
    let limit=max_bytes.clamp(8192,131072);
    let fetched=events.as_array().map_or(0,Vec::len);
    let mut view=json!({"task":task,"events":events,"truncated":false,"max_bytes":limit,
        "max_bytes_scope":"task_context payload; shared project instructions and transport metadata are additional",
        "next_event_cursor":fetched,"event_page_limit":100,"event_history_complete":fetched<100});
    if fits(&view,limit-64){return view;}
    view["truncated"]=json!(true);
    view["note"]=json!("Bounded view only. Stored evidence is unchanged. Use list_task_events with next_event_cursor for further events; an omitted baseline must not be treated as a verified complete baseline.");
    let mut omitted=serde_json::Map::new();
    if let Some(entries)=view.pointer_mut("/task/baseline/entries").and_then(Value::as_array_mut){
        omitted.insert("baseline_entries".into(),json!(entries.len()));entries.clear();
    }
    for key in ["completed_steps","pending_steps"]{
        if let Some(steps)=view["task"].get_mut(key).and_then(Value::as_array_mut){
            if steps.len()>16 {omitted.insert(key.into(),json!(steps.len()-16));steps.truncate(16);}
        }
    }
    // Caller-controlled text may itself exceed the budget. Mark every shortened
    // field so a summary cannot be confused with the original task instruction.
    let mut shortened=Vec::new();
    for key in ["objective","completed_steps","pending_steps"] {
        if let Some(value)=view["task"].get_mut(key){
            let values:Vec<&mut Value>=match value{Value::Array(items)=>items.iter_mut().collect(),other=>vec![other]};
            for value in values{
                if let Some(text)=value.as_str(){
                    if text.len()>512{
                        let mut end=512;while !text.is_char_boundary(end){end-=1;}
                        *value=json!(format!("{} [view truncated]",&text[..end]));shortened.push(key);
                    }
                }
            }
        }
    }
    shortened.sort_unstable();shortened.dedup();
    view["shortened_task_fields"]=json!(shortened);
    view["omitted"]=json!(omitted);
    loop{
        let shown=view["events"].as_array().map_or(0,Vec::len);
        view["next_event_cursor"]=json!(shown);
        view["omitted"]["events_in_first_page"]=json!(fetched-shown);
        view["event_history_complete"]=json!(false);
        if fits(&view,limit-64){return view;}
        if shown>0{view["events"].as_array_mut().unwrap().pop();continue;}
        // Preserve exact identifiers/status; never fabricate a completion flag.
        // The original full task remains available in the retained store.
        let task=&view["task"];
        let summary=json!({"id":task["id"],"workspace_id":task["workspace_id"],"status":task["status"],
            "expected_fingerprint":task["expected_fingerprint"],"updated_at":task["updated_at"]});
        view["task"]=summary;view["task_summary_only"]=json!(true);
        if fits(&view,limit-64){return view;}
        return json!({"task":null,"events":[],"truncated":true,"next_event_cursor":0,
            "status":"context_metadata_too_large","message":"Stored context cannot fit this response budget; evidence was preserved, not deleted.","max_bytes":limit});
    }
}
