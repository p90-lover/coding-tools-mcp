#[test]
fn refresh_contract_baseline_rejects_oversized_input_without_saving_partial_task() {
    let base=std::env::current_dir().unwrap().join("aiTemp/baseline-budget").join(uuid::Uuid::new_v4().to_string());
    let root=base.join("workspace");std::fs::create_dir_all(&root).unwrap();
    let harness=crate::harness::Harness::new(root.clone(),base.join("store")).unwrap();
    // Sparse fixture; never read a user's model, start a game, or delete files.
    let big=std::fs::File::create(root.join("large-model.onnx")).unwrap();
    big.set_len(32*1024*1024+1).unwrap();drop(big);
    let rejected=harness.start_task("Synthetic oversized-baseline fixture");
    assert!(rejected.is_err(),"BASELINE_SCAN_UNBOUNDED: oversized files must not be read into a baseline and accepted");
    assert!(harness.current_task().unwrap().is_none(),"A rejected scan must not create an apparently valid task");
    // Retire the fixture, do not remove it. Excluded trees must not affect fingerprints.
    std::fs::create_dir_all(base.join("Trash")).unwrap();
    std::fs::rename(root.join("large-model.onnx"),base.join("Trash/large-model.onnx")).unwrap();
    std::fs::write(root.join("main.rs"),"fn main() {}\n").unwrap();
    std::fs::create_dir_all(root.join("node_modules/deep/nested")).unwrap();
    let ignored=std::fs::File::create(root.join("node_modules/deep/nested/ignored.bin")).unwrap();
    ignored.set_len(32*1024*1024+1).unwrap();drop(ignored);
    let task=harness.start_task("Synthetic valid baseline").unwrap();
    assert_eq!(task.baseline.entries.len(),1);
    assert!(harness.check_baseline(&task.id).is_ok());
    std::fs::write(root.join("main.rs"),"changed\n").unwrap();
    assert!(harness.check_baseline(&task.id).is_err(),"Incomplete or stale baselines must never authorize writes");
    println!("LIVE_REFRESH_SCAN: oversized input denied without a task; excluded trees pruned; valid hash and external-change rejection retained");
}
