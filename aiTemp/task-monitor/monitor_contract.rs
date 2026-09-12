#[test]
fn task_monitor_history_bounds_scope_and_preservation() {
    use std::{fs,io::Write};
    use serde_json::json;
    use crate::harness::{Harness,monitor::{self,Cursor}};
    let base=std::env::current_dir().unwrap().join("aiTemp/task-monitor-fixture").join(uuid::Uuid::new_v4().to_string());
    let workspace=base.join("primary");let foreign=base.join("foreign");let history=base.join("history");
    fs::create_dir_all(&workspace).unwrap();fs::create_dir_all(&foreign).unwrap();
    assert!(monitor::read(&history,&workspace,None,None).unwrap()["tasks"].as_array().unwrap().is_empty());
    assert!(!history.exists(),"Read-only monitor must not initialize history");
    fs::write(workspace.join("hello.txt"),"hello").unwrap();
    let harness=Harness::new(workspace.clone(),history.clone()).unwrap();
    let task=harness.start_task("Inspect recorded task evidence").unwrap();
    harness.update_steps(&task.id,Some(vec!["read source".into()]),Some(vec!["verify".into()])).unwrap();
    for n in 0..61 {
        harness.record_event(&task.id,"tool_returned",Some("read_file"),json!({"secret":"INPUT_SECRET_NEVER_RENDER","sequence":n}),json!({"ok":true,"exit_code":0,"token":"RESULT_SECRET_NEVER_RENDER","command_id":format!("command-{n}")})).unwrap();
    }
    let task_path=history.join("workspaces").join(harness.workspace_id()).join("tasks").join(format!("{}.json",task.id));
    let events_path=history.join("workspaces").join(harness.workspace_id()).join("events").join(format!("{}.jsonl",task.id));
    // A project file above the baseline limit proves that this monitor never
    // re-scans the workspace just to display state.
    fs::File::create(workspace.join("large.model")).unwrap().set_len(64*1024*1024).unwrap();
    let task_before=fs::read(&task_path).unwrap();let events_before=fs::read(&events_path).unwrap();
    let latest=monitor::read(&history,&workspace,Some(&task.id),None).unwrap();
    assert_eq!(latest["events"].as_array().unwrap().len(),50);
    assert_eq!(latest["task"]["pending_steps"][0],"verify");
    assert_eq!(latest["project_baseline_scanned"],false);
    assert_eq!(latest["events"].as_array().unwrap().last().unwrap()["command_id"],"command-60");
    let cursor:Cursor=serde_json::from_value(latest["next_cursor"].clone()).unwrap();
    let older=monitor::read(&history,&workspace,Some(&task.id),Some(&cursor)).unwrap();
    assert_eq!(older["events"].as_array().unwrap().len(),13);
    assert!(older["next_cursor"].is_null());
    let encoded=serde_json::to_vec(&latest).unwrap();
    assert!(encoded.len()<128*1024);
    let text=String::from_utf8(encoded).unwrap();
    for secret in ["INPUT_SECRET_NEVER_RENDER","RESULT_SECRET_NEVER_RENDER","expected_fingerprint"] { assert!(!text.contains(secret)); }
    assert!(monitor::read(&history,&foreign,Some(&task.id),Some(&cursor)).is_err());
    assert!(monitor::read(&history,&workspace,Some("../outside"),None).is_err());
    let bad=Cursor{before:cursor.before-1,..cursor.clone()};
    assert!(monitor::read(&history,&workspace,Some(&task.id),Some(&bad)).is_err());
    assert_eq!(fs::read(&task_path).unwrap(),task_before);assert_eq!(fs::read(&events_path).unwrap(),events_before);
    let mut file=fs::OpenOptions::new().append(true).open(&events_path).unwrap();file.write_all(b"{\"unfinished\":").unwrap();drop(file);
    let partial=monitor::read(&history,&workspace,Some(&task.id),None).unwrap();
    assert_eq!(partial["partial_tail"],true);assert_eq!(partial["events"].as_array().unwrap().len(),50);
    assert!(fs::read(&events_path).unwrap().ends_with(b"{\"unfinished\":"));
    // Symlink metadata must not expose another workspace. Originals are moved,
    // never deleted; no mutation is performed by the monitor.
    let retained=base.join("Trash");fs::create_dir_all(&retained).unwrap();
    fs::rename(&events_path,retained.join("events.jsonl")).unwrap();
    #[cfg(windows)] std::os::windows::fs::symlink_file(retained.join("events.jsonl"),&events_path).unwrap();
    #[cfg(unix)] std::os::unix::fs::symlink(retained.join("events.jsonl"),&events_path).unwrap();
    assert!(monitor::read(&history,&workspace,Some(&task.id),None).is_err());
    println!("TASK_MONITOR_HISTORY_PASS: real stored tasks/events, 50-event tail, older cursor, scope and byte bounds, no secrets or writes, append-tail and symlink handling");
}
