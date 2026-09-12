static SCAN_FIXTURES: std::sync::Mutex<()> = std::sync::Mutex::new(());
use coding_tools_mcp_desktop_lib::harness::scan::{self, ScanLimits, CHUNK_BYTES};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::atomic::AtomicBool};

fn fixture() -> PathBuf {
    let root = std::env::current_dir()
        .unwrap()
        .join("aiTemp/large-workspace-fixtures")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join("models")).unwrap();
    fs::write(root.join("src/main.py"), "print(1)\n").unwrap();
    root
}

#[test]
fn streams_files_above_old_single_and_aggregate_caps() {
    let _fixture = SCAN_FIXTURES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let root = fixture();
    const SIZE: u64 = 48 * 1024 * 1024;
    for name in ["a.pt", "b.pt", "c.pt"] {
        fs::File::create(root.join("models").join(name))
            .unwrap()
            .set_len(SIZE)
            .unwrap();
    }
    let mut updates = 0;
    let scan = scan::capture(
        &root,
        Some(&["src".into(), "models".into()]),
        &ScanLimits::default(),
        &AtomicBool::new(false),
        &mut |_| updates += 1,
    )
    .unwrap();
    let mut expected = Sha256::new();
    let chunk = vec![0u8; CHUNK_BYTES];
    for _ in 0..SIZE / CHUNK_BYTES as u64 {
        expected.update(&chunk);
    }
    assert_eq!(scan.entries.len(), 4);
    assert_eq!(
        scan.entries
            .iter()
            .find(|e| e.path == "models/a.pt")
            .unwrap()
            .sha256,
        format!("{:x}", expected.finalize())
    );
    assert!(scan.progress.bytes_hashed > 128 * 1024 * 1024);
    assert_eq!(scan.progress.peak_chunk_bytes, CHUNK_BYTES);
    assert!(updates >= 4);
    println!(
        "native_scan_bytes={} peak_read_chunk={} files={}",
        scan.progress.bytes_hashed,
        scan.progress.peak_chunk_bytes,
        scan.entries.len()
    );
}

#[test]
fn explicit_scope_excludes_data_but_detects_code_changes() {
    let _fixture = SCAN_FIXTURES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let root = fixture();
    let sources = vec!["src".into()];
    let capture = || {
        scan::capture(
            &root,
            Some(&sources),
            &ScanLimits::default(),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap()
    };
    let first = capture();
    let store = root
        .parent()
        .unwrap()
        .join(format!("store-{}", uuid::Uuid::new_v4()));
    let harness =
        coding_tools_mcp_desktop_lib::harness::Harness::new(root.clone(), store.clone()).unwrap();
    let task = harness
        .start_task_scoped("Keep only code in the baseline", Some(&sources))
        .unwrap();
    let restarted =
        coding_tools_mcp_desktop_lib::harness::Harness::new(root.clone(), store).unwrap();
    assert_eq!(
        restarted.task(&task.id).unwrap().baseline.source_roots,
        Some(sources.clone())
    );
    fs::write(root.join("models/weights.pt"), vec![9u8; 1024]).unwrap();
    let second = capture();
    assert_eq!(first.fingerprint, second.fingerprint);
    assert_eq!(second.entries.len(), 1);
    assert_eq!(second.source_roots, Some(sources.clone()));
    restarted.check_baseline(&task.id).unwrap();
    fs::write(root.join("src/main.py"), "print(2)\n").unwrap();
    assert_ne!(first.fingerprint, capture().fingerprint);
    assert_eq!(
        restarted.check_baseline(&task.id).unwrap_err().code(),
        "FILE_CHANGED_EXTERNALLY"
    );
}

#[test]
fn invalid_cancelled_or_over_budget_scans_never_return_partial_success() {
    let _fixture = SCAN_FIXTURES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let root = fixture();
    let limits = ScanLimits::default();
    for roots in [
        vec!["../outside".into()],
        vec!["src".into(), "src/main.py".into()],
        vec!["C:/Windows".into()],
        vec![],
        vec!["aiTemp".into()],
    ] {
        let error = scan::capture(
            &root,
            Some(&roots),
            &limits,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(error.code(), "INVALID_BASELINE_SCOPE", "{error}");
    }
    let error = scan::capture(
        &root,
        Some(&["src".into()]),
        &limits,
        &AtomicBool::new(true),
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(error.code(), "BASELINE_SCAN_CANCELLED");
    let tiny = ScanLimits {
        max_total_bytes: 1,
        ..limits
    };
    let error = scan::capture(
        &root,
        Some(&["src".into()]),
        &tiny,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(error.code(), "BASELINE_BUDGET_EXCEEDED");
}
