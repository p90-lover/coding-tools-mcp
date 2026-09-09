//! Focused board regressions against the production reducer; no agents or user files.
use super::*;
use serde_json::{json, Value};

fn request(b: &mut Board, value: Value) -> Result<(), String> {
    let revision = b.revision;
    let change: Change = serde_json::from_value(value).map_err(|e| e.to_string())?;
    apply(b, revision, change).map_err(|e| e.to_string())
}
fn create(b: &mut Board, title: &str, state: &str) {
    request(b, json!({"operation":"create","workspace_id":"fixture","title":title,"description":"","state":state})).unwrap();
}
#[test]
fn board_flow_create_in_each_column_and_restore_legacy_data() {
    let mut b = Board::default();
    for state in ["backlog", "in_progress", "blocked", "done"] {
        create(&mut b, state, state);
        let task = b.tasks.last().unwrap();
        assert_eq!(task.state, state);
        assert_eq!(task.step, 0);
        assert!(task.evidence.is_empty());
    }
    request(&mut b, json!({"operation":"create","workspace_id":"fixture","title":"legacy","description":""})).unwrap();
    assert_eq!(b.tasks.last().unwrap().state, "backlog");
    let restored: Board = serde_json::from_slice(&serde_json::to_vec(&b).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(&b).unwrap(), serde_json::to_value(restored).unwrap());
}
#[test]
fn board_flow_move_reorder_and_reopen_preserve_evidence() {
    let mut b = Board::default();
    create(&mut b, "First", "in_progress");
    let first = b.tasks[0].id.clone();
    request(&mut b, json!({"operation":"record_step","id":first,"note":"Operator inspected the specification"})).unwrap();
    let evidence = serde_json::to_value(&b.tasks[0].evidence).unwrap();
    create(&mut b, "Second", "blocked");
    let second = b.tasks[1].id.clone();
    request(&mut b, json!({"operation":"move","id":first,"state":"blocked","before_id":second})).unwrap();
    assert_eq!(b.tasks[0].id, first);
    assert_eq!(b.tasks[0].state, "blocked");
    request(&mut b, json!({"operation":"move","id":first,"state":"blocked"})).unwrap();
    assert_eq!(b.tasks[1].id, first);
    for state in ["done", "backlog", "in_progress"] {
        request(&mut b, json!({"operation":"move","id":first,"state":state})).unwrap();
        let task = b.tasks.iter().find(|t| t.id == first).unwrap();
        assert_eq!(task.step, 1);
        assert_eq!(serde_json::to_value(&task.evidence).unwrap(), evidence);
    }
    let restored: Board = serde_json::from_slice(&serde_json::to_vec(&b).unwrap()).unwrap();
    assert_eq!(restored.tasks.last().unwrap().id, first);
    assert_eq!(restored.tasks.last().unwrap().state, "in_progress");
}
#[test]
fn board_flow_invalid_stale_and_overflow_changes_are_atomic() {
    let mut b = Board::default();
    request(&mut b, json!({"operation":"create","workspace_id":"fixture","title":"First","description":""})).unwrap();
    let id = b.tasks[0].id.clone();
    for invalid in [
        json!({"operation":"move","id":id,"state":"deleted"}),
        json!({"operation":"move","id":id,"state":"blocked","before_id":"missing"}),
        json!({"operation":"create","workspace_id":"fixture","title":"bad","description":"","state":"archived"}),
    ] {
        let before = serde_json::to_value(&b).unwrap();
        assert!(request(&mut b, invalid).is_err());
        assert_eq!(serde_json::to_value(&b).unwrap(), before);
    }
    let stale: Change = serde_json::from_value(json!({"operation":"start","id":id})).unwrap();
    let before = serde_json::to_value(&b).unwrap();
    assert!(apply(&mut b, 0, stale).is_err());
    assert_eq!(serde_json::to_value(&b).unwrap(), before);
    b.revision = u64::MAX;
    let before = serde_json::to_value(&b).unwrap();
    assert!(request(&mut b, json!({"operation":"start","id":id})).is_err());
    assert_eq!(serde_json::to_value(&b).unwrap(), before);
}
#[test]
fn board_flow_workspace_scope_and_agent_notes_cannot_forge_human_review() {
    let mut b = Board::default();
    create(&mut b, "Owned", "backlog");
    let owned=b.tasks[0].id.clone();
    let mut foreign=b.tasks[0].clone();
    foreign.id="foreign".into();foreign.workspace_id="private".into();foreign.title="Private task".into();
    b.tasks.push(foreign);
    for raw in [
        json!({"operation":"move","id":"foreign","state":"done"}),
        json!({"operation":"move","id":owned,"state":"backlog","before_id":"foreign"}),
        json!({"operation":"observe","id":"foreign","note":"No cross-workspace access"}),
    ] {
        let before=serde_json::to_value(&b).unwrap();let revision=b.revision;
        let change: ScopedChange=serde_json::from_value(raw).unwrap();
        assert!(apply_scoped(&mut b,"fixture",revision,change).is_err());
        assert_eq!(serde_json::to_value(&b).unwrap(),before);
    }
    let revision=b.revision;
    let change: ScopedChange=serde_json::from_value(json!({"operation":"observe","id":owned,"note":"Observed one failing test; human review required."})).unwrap();
    let task=apply_scoped(&mut b,"fixture",revision,change).unwrap();
    assert_eq!(task.step,0);assert_eq!(task.state,"backlog");
    assert_eq!(task.evidence.len(),1);assert_eq!(task.evidence[0].source,"agent_observation");
    assert!(serde_json::from_value::<ScopedChange>(json!({"operation":"record_step","id":owned,"note":"Pretend the human approved"})).is_err());
    assert!(serde_json::from_value::<ScopedChange>(json!({"operation":"create","workspace_id":"private","title":"wrong","description":""})).is_err());
    assert_eq!(b.tasks.iter().find(|t|t.id=="foreign").unwrap().evidence.len(),0);
}
