use crate::integrations::board::{apply, Board, Change};
use serde_json::{json, Value};
fn submit(board: &mut Board, value: Value) {
    let change: Change = serde_json::from_value(value).expect("supported board operation");
    apply(board, board.revision, change).expect("valid board transition");
}
#[test]
fn work_board_create_in_each_column_and_move_without_fabricating_evidence() {
    let mut board = Board::default();
    for state in ["backlog", "in_progress", "blocked", "done"] {
        submit(&mut board, json!({"operation":"create","workspace_id":"workspace-one","title":state,"description":"fixture","state":state}));
        let task = board.tasks.last().unwrap();
        assert_eq!(task.state, state);
        assert_eq!(task.step, 0);
        assert!(task.evidence.is_empty());
    }
    let id = board.tasks[0].id.clone();
    for state in ["blocked", "in_progress", "done", "backlog"] {
        submit(&mut board, json!({"operation":"move","id":id,"state":state}));
        assert_eq!(board.tasks[0].state, state);
        assert_eq!(board.tasks[0].step, 0, "moving a card is not completing its checklist");
        assert!(board.tasks[0].evidence.is_empty());
    }
    submit(&mut board, json!({"operation":"move","id":id,"state":"in_progress"}));
    submit(&mut board, json!({"operation":"record_step","id":id,"note":"Human checked the specification"}));
    let evidence = serde_json::to_value(&board.tasks[0].evidence).unwrap();
    submit(&mut board, json!({"operation":"move","id":id,"state":"blocked"}));
    submit(&mut board, json!({"operation":"move","id":id,"state":"backlog"}));
    assert_eq!(board.tasks[0].step, 1);
    assert_eq!(serde_json::to_value(&board.tasks[0].evidence).unwrap(), evidence);
}
#[test]
fn work_board_archive_restore_and_edit_preserve_original_work() {
    let mut board = Board::default();
    submit(&mut board, json!({"operation":"create","workspace_id":"workspace-one","title":"Need help","description":"Original notes","state":"blocked"}));
    let id = board.tasks[0].id.clone();
    submit(&mut board, json!({"operation":"edit","id":id,"title":"Need review","description":"Keep the original evidence"}));
    submit(&mut board, json!({"operation":"archive","id":id}));
    assert_eq!(board.tasks.len(), 1);
    assert_eq!(board.tasks[0].state, "archived");
    submit(&mut board, json!({"operation":"restore","id":id}));
    assert_eq!(board.tasks[0].state, "blocked");
    assert_eq!(board.tasks[0].title, "Need review");
    assert_eq!(board.tasks[0].description, "Keep the original evidence");
    let restored: Board = serde_json::from_value(serde_json::to_value(&board).unwrap()).unwrap();
    assert_eq!(restored.tasks[0].state, "blocked");
}
#[test]
fn work_board_rejected_mutations_are_atomic_and_old_records_remain_readable() {
    let mut board = Board::default();
    submit(&mut board, json!({"operation":"create","workspace_id":"workspace-one","title":"Original","description":""}));
    let id = board.tasks[0].id.clone();
    let before = serde_json::to_value(&board).unwrap();
    let stale: Change = serde_json::from_value(json!({"operation":"start","id":id})).unwrap();
    assert!(apply(&mut board, 0, stale).is_err());
    assert_eq!(serde_json::to_value(&board).unwrap(), before);
    board.revision = u64::MAX;
    let before = serde_json::to_value(&board).unwrap();
    let change: Change = serde_json::from_value(json!({"operation":"start","id":id})).unwrap();
    assert!(apply(&mut board, u64::MAX, change).is_err());
    assert_eq!(serde_json::to_value(&board).unwrap(), before, "revision overflow must not mutate the task first");
    let mut old = before;
    for task in old["tasks"].as_array_mut().unwrap() { task.as_object_mut().unwrap().remove("archived_from"); task.as_object_mut().unwrap().remove("origin"); }
    assert!(serde_json::from_value::<Board>(old).is_ok());
}
