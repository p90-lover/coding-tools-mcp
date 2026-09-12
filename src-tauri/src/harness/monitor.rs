//! Read-only, bounded projection of existing task records. Never scans a project,
//! creates a harness, truncates history or treats an RPC receipt as job completion.
use std::{collections::HashSet, fs::{self, File}, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use super::{model::TaskStatus, state::workspace_id, store::{HarnessError, HarnessResult}};

const INDEX_BYTES: usize = 64 * 1024;
const TASK_BYTES: usize = 8 * 1024 * 1024;
const TOTAL_BYTES: usize = 32 * 1024 * 1024;
const EVENT_WINDOW: usize = 512 * 1024;
const EVENT_BYTES: usize = 64 * 1024;
const RECENT: usize = 20;
const PAGE: usize = 50;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Cursor { pub workspace_id: String, pub task_id: String, pub before: u64 }

#[derive(Deserialize)]
struct Index { #[serde(default)] active_task_id: Option<String>, #[serde(default)] recent_task_ids: Vec<String> }
#[derive(Deserialize)]
struct Task {
    id: String, workspace_id: String, objective: String, status: TaskStatus,
    #[serde(default)] completed_steps: Vec<String>, #[serde(default)] pending_steps: Vec<String>,
    latest_change_id: Option<String>, latest_verification_id: Option<String>,
    created_at: String, updated_at: String,
}
fn error(code: &'static str, text: &str) -> HarnessError { HarnessError::new(code, text) }
fn valid_id(id: &str) -> bool { id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) }
fn short(s: &str, max: usize) -> String {
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) { end -= 1; }
    if end < s.len() { format!("{}…", &s[..end]) } else { s.to_owned() }
}
fn text(v: &Value, max: usize) -> Value { v.as_str().map(|s| json!(short(s, max))).unwrap_or(Value::Null) }

/// Reject symbolic links and Windows reparse points throughout the metadata
/// path. This is a local read boundary, not an OS sandbox against hostile races.
fn regular_file(root: &Path, relative: &Path) -> HarnessResult<Option<File>> {
    let mut path = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) { return Err(error("MONITOR_PATH", "Invalid metadata path")); }
        path.push(part);
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(error("MONITOR_IO", "Task metadata cannot be read")),
        };
        if meta.file_type().is_symlink() { return Err(error("MONITOR_PATH", "Linked task metadata is not followed")); }
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 { return Err(error("MONITOR_PATH", "Reparse-point task metadata is not followed")); }
        }
    }
    if !path.canonicalize().map_err(|_| error("MONITOR_IO", "Metadata path unavailable"))?.starts_with(root) {
        return Err(error("MONITOR_PATH", "Metadata escaped the history root"));
    }
    if !fs::symlink_metadata(&path).map_err(|_| error("MONITOR_IO", "Metadata unavailable"))?.is_file() {
        return Err(error("MONITOR_PATH", "Expected a regular task metadata file"));
    }
    let f = File::open(path).map_err(|_| error("MONITOR_IO", "Task metadata cannot be opened"))?;
    if !f.metadata().map_err(|_| error("MONITOR_IO", "Metadata unavailable"))?.is_file() {
        return Err(error("MONITOR_PATH", "Expected a regular task metadata file"));
    }
    Ok(Some(f))
}
fn limited_json<T: for<'a> Deserialize<'a>>(mut file: File, cap: usize, budget: &mut usize) -> HarnessResult<T> {
    let len = file.metadata().map_err(|_| error("MONITOR_IO", "Task metadata unavailable"))?.len();
    if len > cap as u64 || len > *budget as u64 { return Err(error("MONITOR_LIMIT", "Task metadata exceeds the observation budget")); }
    let mut bytes = Vec::with_capacity((len as usize).min(cap));
    (&mut file).take(cap.min(*budget) as u64 + 1).read_to_end(&mut bytes).map_err(|_| error("MONITOR_IO", "Cannot read task metadata"))?;
    if bytes.len() > cap || bytes.len() > *budget { return Err(error("MONITOR_LIMIT", "Task metadata grew past the observation budget")); }
    *budget -= bytes.len();
    serde_json::from_slice(&bytes).map_err(|_| error("MONITOR_INVALID", "Task metadata is incomplete or malformed"))
}
fn load_task(root: &Path, wid: &str, id: &str, budget: &mut usize) -> HarnessResult<Option<Task>> {
    if !valid_id(id) { return Err(error("MONITOR_TASK_ID", "Task ID must contain exactly 32 hexadecimal characters")); }
    let path = PathBuf::from("workspaces").join(wid).join("tasks").join(format!("{id}.json"));
    let Some(file) = regular_file(root, &path)? else { return Ok(None) };
    let task: Task = limited_json(file, TASK_BYTES, budget)?;
    if task.id != id || task.workspace_id != wid { return Err(error("MONITOR_SCOPE", "Task does not belong to the selected workspace")); }
    Ok(Some(task))
}
fn summary(t: &Task, details: bool) -> Value {
    let mut v = json!({"id":t.id,"workspace_id":t.workspace_id,"objective":short(&t.objective,if details {4096}else{400}),"status":t.status,
        "created_at":short(&t.created_at,32),"updated_at":short(&t.updated_at,32),
        "completed_count":t.completed_steps.len(),"pending_count":t.pending_steps.len(),
        "latest_change_id":t.latest_change_id.as_deref().map(|s|short(s,128)),"latest_verification_id":t.latest_verification_id.as_deref().map(|s|short(s,128))});
    if details {
        v["completed_steps"] = json!(t.completed_steps.iter().take(64).map(|s|short(s,1024)).collect::<Vec<_>>());
        v["pending_steps"] = json!(t.pending_steps.iter().take(64).map(|s|short(s,1024)).collect::<Vec<_>>());
        v["steps_truncated"] = json!(t.completed_steps.len()>64 || t.pending_steps.len()>64 || t.completed_steps.iter().chain(&t.pending_steps).any(|s|s.len()>1024));
    }
    v
}
fn event(v: &Value, task: &str) -> HarnessResult<Value> {
    if v["task_id"] != task { return Err(error("MONITOR_SCOPE", "Event belongs to a different task")); }
    let r = &v["result_summary"];
    // Deliberate allowlist: no command arguments, output bodies, access tokens,
    // arbitrary result fields or user-provided reasons are sent to this view.
    Ok(json!({"id":text(&v["id"],128),"task_id":task,"operation_id":text(&v["operation_id"],128),
        "kind":text(&v["kind"],128),"tool_name":text(&v["tool_name"],128),"created_at":text(&v["created_at"],32),
        "ok":r["ok"].as_bool(),"code":text(&r["error"]["code"],128),"exit_code":r["exit_code"].as_i64(),
        "command_id":text(&r["command_id"],128),
        "files":v["affected_files"].as_array().map(|a|a.iter().take(20).map(|f|json!({"path":text(&f["path"],512),"status":text(&f["status"],64)})).collect::<Vec<_>>()).unwrap_or_default()}))
}
fn events(root: &Path, wid: &str, task: &str, cursor: Option<&Cursor>) -> HarnessResult<Value> {
    let path = PathBuf::from("workspaces").join(wid).join("events").join(format!("{task}.jsonl"));
    let Some(mut file) = regular_file(root, &path)? else {
        return if cursor.is_some() { Err(error("MONITOR_CURSOR", "History changed; return to latest events")) }
            else { Ok(json!({"events":[],"next_cursor":null,"partial_tail":false,"warnings":[]})) };
    };
    let length = file.metadata().map_err(|_|error("MONITOR_IO","Cannot inspect event history"))?.len();
    let end = cursor.map(|c|c.before).unwrap_or(length);
    if end > length || end > 9_007_199_254_740_991 { return Err(error("MONITOR_CURSOR", "Event cursor is outside current history")); }
    if cursor.is_some() && end > 0 {
        file.seek(SeekFrom::Start(end-1)).map_err(|_|error("MONITOR_IO","Cannot seek history"))?;
        let mut b = [0];file.read_exact(&mut b).map_err(|_|error("MONITOR_IO","History changed"))?;
        if b[0] != b'\n' { return Err(error("MONITOR_CURSOR", "Event cursor must point to a complete record boundary")); }
    }
    let start = end.saturating_sub(EVENT_WINDOW as u64);
    file.seek(SeekFrom::Start(start)).map_err(|_|error("MONITOR_IO","Cannot seek history"))?;
    let mut bytes = Vec::with_capacity((end-start) as usize);
    file.take(end-start).read_to_end(&mut bytes).map_err(|_|error("MONITOR_IO","Cannot read event history"))?;
    let mut pos = 0;
    let mut warnings = Vec::<String>::new();
    // A bounded tail can begin partway through a record. Never parse that fragment.
    if start > 0 { pos = bytes.iter().position(|b|*b==b'\n').map(|i|i+1).unwrap_or(bytes.len()); warnings.push("Older events outside this bounded window are not loaded".into()); }
    let mut rows: Vec<(u64,Value)> = Vec::new();
    let mut partial_tail = false;
    while pos < bytes.len() {
        let Some(n) = bytes[pos..].iter().position(|b|*b==b'\n') else { partial_tail=true; break };
        let begin = pos;pos += n+1;
        if n==0 { continue; }
        if n>EVENT_BYTES { warnings.push("An oversized event was omitted from the display; original is retained".into());continue; }
        let v: Value = match serde_json::from_slice(&bytes[begin..begin+n]) {
            Ok(v)=>v,
            Err(_)=>{warnings.push("A malformed event was omitted; original is retained".into());continue;}
        };
        rows.push((start+begin as u64,event(&v,task)?));
        if rows.len() > PAGE { rows.remove(0); }
    }
    // Only issue a cursor at an actual line boundary; never point into a large
    // record. For a window filled by one record the bound is disclosed instead.
    let before = rows.first().map(|(offset,_)|*offset).filter(|offset|*offset>0);
    let next = before.map(|before|Cursor{workspace_id:wid.into(),task_id:task.into(),before});
    warnings.sort();warnings.dedup();
    Ok(json!({"events":rows.into_iter().map(|(_,v)|v).collect::<Vec<_>>(),"next_cursor":next,"partial_tail":partial_tail,"warnings":warnings}))
}

pub fn read(history_root: &Path, workspace_root: &Path, task_id: Option<&str>, cursor: Option<&Cursor>) -> HarnessResult<Value> {
    let workspace_root=workspace_root.canonicalize().map_err(|_|error("MONITOR_WORKSPACE","Selected workspace is unavailable"))?;
    let wid=workspace_id(&workspace_root);
    if task_id.is_some_and(|id|!valid_id(id)) { return Err(error("MONITOR_TASK_ID","Invalid task ID")); }
    if cursor.is_some_and(|c|c.workspace_id!=wid || Some(c.task_id.as_str())!=task_id) { return Err(error("MONITOR_SCOPE","Event cursor belongs to a different workspace or task")); }
    let empty=json!({"tasks":[],"task":null,"events":[],"next_cursor":null,"partial_tail":false,"warnings":[],"recent_limit":RECENT});
    if !history_root.exists() { return Ok(empty); }
    if fs::symlink_metadata(history_root).map_err(|_|error("MONITOR_IO","History unavailable"))?.file_type().is_symlink() {
        return Err(error("MONITOR_PATH","Linked history root is not followed"));
    }
    let root=history_root.canonicalize().map_err(|_|error("MONITOR_IO","History unavailable"))?;
    let mut budget=TOTAL_BYTES;
    let mut warnings=Vec::<String>::new();
    let index_path=PathBuf::from("workspaces").join(&wid).join("state.json");
    let index: Option<Index>=regular_file(&root,&index_path)?.map(|f|limited_json(f,INDEX_BYTES,&mut budget)).transpose()?;
    let mut ids=Vec::<String>::new();
    if let Some(index)=index { if let Some(id)=index.active_task_id { ids.push(id); } ids.extend(index.recent_task_ids); }
    let mut unique=HashSet::new();ids.retain(|id|unique.insert(id.clone()));ids.truncate(RECENT);
    let selected=task_id.map(|id|load_task(&root,&wid,id,&mut budget)).transpose()?.flatten();
    if task_id.is_some() && selected.is_none() { return Err(error("MONITOR_NOT_FOUND","Task not found in the selected workspace")); }
    let mut tasks=Vec::new();
    for id in ids {
        if Some(id.as_str())==task_id { tasks.push(summary(selected.as_ref().expect("selected task"),false));continue; }
        match load_task(&root,&wid,&id,&mut budget) {
            Ok(Some(t))=>tasks.push(summary(&t,false)),
            Ok(None)=>warnings.push("A recent indexed task is unavailable".into()),
            Err(e) if e.code()=="MONITOR_LIMIT"=>{warnings.push("Recent task list reached its read budget".into());break;}
            Err(_)=>warnings.push("An invalid recent task was omitted".into()),
        }
    }
    tasks.sort_by(|a,b|b["updated_at"].as_str().cmp(&a["updated_at"].as_str()));
    let mut view=if let Some(id)=task_id { events(&root,&wid,id,cursor)? } else { empty };
    warnings.extend(view["warnings"].as_array().into_iter().flatten().filter_map(|v|v.as_str()).map(str::to_owned));
    warnings.sort();warnings.dedup();
    view["tasks"]=json!(tasks);view["task"]=selected.as_ref().map(|t|summary(t,true)).unwrap_or(Value::Null);
    view["warnings"]=json!(warnings);view["recent_limit"]=json!(RECENT);view["history_workspace_id"]=json!(wid);
    view["read_only"]=json!(true);view["project_baseline_scanned"]=json!(false);
    Ok(view)
}
