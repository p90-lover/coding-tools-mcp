use super::*;
use std::fs;
#[test]
fn integration_contract_snapshot_rejection_and_lossless_local_archival() {
    let base = std::env::current_dir().unwrap().join("aiTemp/contracts-retention")
        .join(uuid::Uuid::new_v4().to_string());
    let root = base.join("workspace");
    let home = base.join("store");
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    fs::write(root.join("hello.txt"), b"ORIGINAL_BYTES").unwrap();
    for files in [vec!["../secret.txt".into()], vec!["missing.txt".into()],
                  vec!["hello.txt".into(),"hello.txt".into()]] {
        assert!(prepare(&root, &home, &files).is_err());
        assert_eq!(retained_count(&home).unwrap(), 0,
            "INVALID_INPUT_CONSUMED_RETENTION_SLOT");
    }
    let first = prepare(&root, &home, &["hello.txt".into()]).unwrap();
    fs::write(first.work.join("result.txt"), b"RETAINED_RESULT").unwrap();
    let second = prepare(&root, &home, &[]).unwrap();
    assert_eq!(retained_count(&home).unwrap(), 2);
    let archived = archive_retained(&home).unwrap().unwrap();
    assert_eq!(retained_count(&home).unwrap(), 0);
    assert_eq!(fs::read(archived.join(&first.id).join("input/hello.txt")).unwrap(), b"ORIGINAL_BYTES");
    assert_eq!(fs::read(archived.join(&first.id).join("work/result.txt")).unwrap(), b"RETAINED_RESULT");
    assert!(archived.join(&second.id).join("work").is_dir());
    assert_eq!(fs::read(root.join("hello.txt")).unwrap(), b"ORIGINAL_BYTES");
    assert!(archive_retained(&home).unwrap().is_none());
    assert!(prepare(&root, &home, &[]).is_ok());
    #[cfg(unix)] {
        let unsafe_home = base.join("unsafe-store");
        let outside = base.join("outside");
        fs::create_dir_all(&unsafe_home).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, unsafe_home.join("runs")).unwrap();
        assert!(archive_retained(&unsafe_home).is_err());
        assert!(outside.is_dir());
    }
    println!("PASS: invalid selections do not consume retention; archive moves intact trees and permits another run; no file deletion");
}
