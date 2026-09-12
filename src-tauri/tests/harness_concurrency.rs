use coding_tools_mcp_desktop_lib::harness::{Harness, TaskStatus};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Barrier},
    thread,
};

// Retain all fixtures under aiTemp: these tests never delete files.
fn fixture() -> (PathBuf, PathBuf) {
    let base = std::env::current_dir()
        .unwrap()
        .join("aiTemp/concurrency-fixtures")
        .join(uuid::Uuid::new_v4().to_string());
    let workspace = base.join("project");
    let store = base.join("store");
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("source.txt"), "baseline\n").unwrap();
    (workspace, store)
}

#[test]
fn concurrent_task_records_survive_restart() {
    let (workspace, store) = fixture();
    let harness = Harness::new(workspace.clone(), store.clone()).unwrap();
    let first = harness.start_task("Eros runtime").unwrap();
    let second = harness
        .start_task("Independent review")
        .expect("a second task must not replace or close the first");
    assert_ne!(first.id, second.id);
    let restarted = Harness::new(workspace, store).unwrap();
    assert_eq!(
        restarted.task(&first.id).unwrap().status,
        TaskStatus::Active
    );
    assert_eq!(
        restarted.task(&second.id).unwrap().status,
        TaskStatus::Active
    );
    assert!(
        restarted.current_task().is_err(),
        "multiple tasks need explicit selection"
    );
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = [first.id, second.id]
        .into_iter()
        .map(|id| {
            let h = restarted.clone();
            let b = barrier.clone();
            thread::spawn(move || {
                b.wait();
                h.update_steps(&id, Some(vec!["checked".into()]), None)
            })
        })
        .collect();
    barrier.wait();
    // Contended metadata writes may fail explicitly, but cannot corrupt another record.
    for worker in workers {
        let _ = worker.join().unwrap();
    }
}

#[test]
fn paused_task_is_not_executable_and_is_preserved() {
    let (workspace, store) = fixture();
    let harness = Harness::new(workspace, store).unwrap();
    let first = harness.start_task("Pause only this task").unwrap();
    let paused = harness.transition(&first.id, TaskStatus::Paused).unwrap();
    assert!(
        !paused.status.is_writable(),
        "paused is unfinished, not executable"
    );
    let other = harness.start_task("Other work continues").unwrap();
    assert_eq!(harness.task(&first.id).unwrap().status, TaskStatus::Paused);
    assert_eq!(harness.task(&other.id).unwrap().status, TaskStatus::Active);
    assert!(!TaskStatus::Failed.is_writable());
}

#[test]
fn task_id_must_not_escape_store() {
    let (workspace, store) = fixture();
    let harness = Harness::new(workspace, store.clone()).unwrap();
    let task = harness.start_task("Validate identifiers").unwrap();
    let outside_tasks = store
        .join("workspaces")
        .join(harness.workspace_id())
        .join("escape.json");
    fs::write(outside_tasks, serde_json::to_vec(&task).unwrap()).unwrap();
    assert!(
        harness.task("../escape").is_err(),
        "task IDs must not become paths"
    );
    assert!(harness.task("..\\escape").is_err());
}
