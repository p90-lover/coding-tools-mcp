#[test]
fn reliability_snapshot_rejected_inputs_do_not_consume_retention() {
    use std::{fs, path::Path};
    let base=std::env::current_dir().unwrap().join("aiTemp/reliability-snapshots").join(uuid::Uuid::new_v4().to_string());
    let root=base.join("workspace");let storage=base.join("storage");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("good.txt"),b"SOURCE_UNCHANGED").unwrap();
    fs::write(root.join("nested/input.txt"),b"NESTED_UNCHANGED").unwrap();
    let root=root.canonicalize().unwrap();
    let count=|home:&Path|fs::read_dir(home.join("runs")).map(|r|r.count()).unwrap_or(0);
    for names in [vec!["../private.txt"],vec!["good.txt","missing.txt"],vec!["nested"],vec!["auth.json"],vec!["good.txt","good.txt"],vec!["nested/input.txt","nested/./input.txt"]] {
        let files:Vec<String>=names.into_iter().map(str::to_owned).collect();
        assert!(snapshot::prepare(&root,&storage,&files).is_err());
        assert_eq!(count(&storage),0,"INVALID_INPUT_CONSUMED_RETENTION_SLOT");
    }
    let oversized=fs::File::create(root.join("oversized.bin")).unwrap();
    oversized.set_len(16*1024*1024+1).unwrap();drop(oversized);
    assert!(snapshot::prepare(&root,&storage,&["oversized.bin".into()]).is_err());
    assert_eq!(count(&storage),0);
    for _ in 0..33 {
        assert!(snapshot::prepare(&root,&storage,&["missing.txt".into()]).is_err());
    }
    assert_eq!(count(&storage),0);
    let run=snapshot::prepare(&root,&storage,&["good.txt".into(),"nested/input.txt".into()]).unwrap();
    assert_eq!(count(&storage),1);
    assert_eq!(fs::read(run.input.join("good.txt")).unwrap(),b"SOURCE_UNCHANGED");
    assert_eq!(fs::read(run.input.join("nested/input.txt")).unwrap(),b"NESTED_UNCHANGED");
    assert_eq!(fs::read(root.join("good.txt")).unwrap(),b"SOURCE_UNCHANGED");
    assert!(run.work.is_dir());
    for _ in 1..32 {snapshot::prepare(&root,&storage,&[]).unwrap();}
    assert!(snapshot::prepare(&root,&storage,&[]).is_err(),"The retained-run limit must remain enforced");
    assert_eq!(count(&storage),32);
    println!("RELIABILITY_SNAPSHOT: rejected path/file/duplicate/size cases consume no run; valid bytes and 32-run limit retained; no files deleted");
}
