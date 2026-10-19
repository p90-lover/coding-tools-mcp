//! Host-observed artifact checks. A digest proves bytes, not test correctness or semantic quality.
use super::{Assignment, Node, Role, Run};
use crate::tools::workspace::Workspace;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::OpenOptions, io::Read, path::Path};

pub const MAX_CHECKS: usize = 8;
const MAX_ARTIFACT_BYTES: u64 = 1_048_576;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AcceptanceCheck {
    ArtifactSha256 { path: String, sha256: String },
}

impl AcceptanceCheck {
    pub fn valid(&self) -> bool {
        let Self::ArtifactSha256 { path, sha256 } = self;
        super::text(path, 512)
            && !path.starts_with(['/', '\\', '@'])
            && !path.contains(':')
            && path
                .split(['/', '\\'])
                .all(|part| !part.is_empty() && part != ".." && part != ".")
            && super::sha256_text(sha256)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptanceEvidence {
    pub kind: String,
    pub path: String,
    pub expected_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_sha256: Option<String>,
    pub planner_request_key: String,
    pub worker_request_key: String,
    pub verified_at_ms: u64,
    pub passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Never executes an agent-provided command or follows links outside this workspace.
fn artifact_sha256(root: &Path, path: &str) -> Result<String, &'static str> {
    let workspace = Workspace::isolated(root.to_path_buf())
        .map_err(|_| "Acceptance workspace is unavailable")?;
    let resolved = workspace
        .resolve_existing(path)
        .map_err(|_| "Acceptance artifact is missing or outside its workspace")?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A FIFO can otherwise wait forever before fstat gets a chance to reject it.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options
        .open(&resolved.path)
        .map_err(|_| "Acceptance artifact cannot be opened")?;
    workspace
        .verify_opened(&file, &resolved.path)
        .map_err(|_| "Acceptance artifact escaped its workspace")?;
    let before = file
        .metadata()
        .map_err(|_| "Acceptance artifact metadata is unavailable")?;
    if !before.is_file() || before.len() > MAX_ARTIFACT_BYTES {
        return Err("Acceptance artifact must be a regular file of at most 1 MiB");
    }
    let mut digest = Sha256::new();
    let mut bounded = (&mut file).take(MAX_ARTIFACT_BYTES + 1);
    let mut buffer = [0u8; 16_384];
    let mut read = 0u64;
    loop {
        let count = bounded
            .read(&mut buffer)
            .map_err(|_| "Acceptance artifact could not be read")?;
        if count == 0 {
            break;
        }
        read += count as u64;
        if read > MAX_ARTIFACT_BYTES {
            return Err("Acceptance artifact exceeds 1 MiB");
        }
        digest.update(&buffer[..count]);
    }
    let after = file
        .metadata()
        .map_err(|_| "Acceptance artifact metadata is unavailable")?;
    workspace
        .verify_opened(&file, &resolved.path)
        .map_err(|_| "Acceptance artifact escaped its workspace")?;
    // A changing file is not an authoritative snapshot. Approval takes a fresh snapshot again.
    if read != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("Acceptance artifact changed while it was being verified");
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn planner_key<'a>(run: &'a Run, assignment: &Assignment) -> Option<&'a str> {
    let key = assignment.planner_request_key.as_deref()?;
    run.nodes
        .iter()
        .find(|node| node.role == Role::Planner)
        .and_then(|node| {
            node.receipt
                .as_ref()
                .filter(|receipt| node.request_key.as_deref() == Some(receipt.request_key.as_str()))
        })
        .filter(|receipt| {
            receipt.status == "completed" && receipt.turn_id.is_some() && receipt.request_key == key
        })
        .map(|receipt| receipt.request_key.as_str())
}

/// Only the registered root is supported by typed artifact checks. External AO sessions must
/// confirm their effective root; canonicalizing a root is not permission to read its artifacts.
pub(super) fn workspace_for_attempt(
    registered: Option<&Path>,
    worker: &Node,
    observed: Option<&str>,
) -> Result<std::path::PathBuf, &'static str> {
    let registered = registered
        .and_then(|root| root.canonicalize().ok())
        .ok_or("Acceptance workspace is unavailable")?;
    if super::external_harness(&worker.route).is_some() {
        let observed = observed
            .filter(|root| {
                root.len() <= 4_096
                    && !root.chars().any(char::is_control)
                    && Path::new(root).is_absolute()
            })
            .ok_or("Typed artifact checks require a confirmed worker workspace")?;
        let observed = Path::new(observed)
            .canonicalize()
            .map_err(|_| "Typed artifact checks require an available worker workspace")?;
        if observed != registered {
            return Err("Typed artifact checks support folder mode only; the worker workspace differs from the registered root");
        }
    }
    Ok(registered)
}

/// Results are generated from current files and controller-owned attempt identities only.
pub(super) fn observe_worker(
    root: Option<&Path>,
    run: &Run,
    worker: &Node,
) -> Result<Vec<AcceptanceEvidence>, &'static str> {
    let Some(assignment) = run.assignments.get(&worker.id) else {
        return Ok(Vec::new());
    };
    if assignment.checks.is_empty() {
        return Ok(Vec::new());
    }
    if assignment.checks.len() > MAX_CHECKS || assignment.checks.iter().any(|check| !check.valid())
    {
        return Err("Acceptance check specification is invalid");
    }
    let planner_request_key = planner_key(run, assignment)
        .ok_or("Acceptance checks no longer match the current planner attempt")?;
    let worker_request_key = worker
        .receipt
        .as_ref()
        .filter(|receipt| worker.request_key.as_deref() == Some(receipt.request_key.as_str()))
        .map(|receipt| receipt.request_key.as_str())
        .ok_or("Acceptance checks have no current worker attempt")?;
    let root = root.ok_or("Acceptance workspace is unavailable")?;
    Ok(assignment
        .checks
        .iter()
        .map(|check| {
            let AcceptanceCheck::ArtifactSha256 { path, sha256 } = check;
            let observed = artifact_sha256(root, path);
            let passed = observed.as_ref().is_ok_and(|actual| actual == sha256);
            let error = match &observed {
                Err(error) => Some((*error).into()),
                Ok(_) if !passed => {
                    Some("Acceptance artifact SHA256 does not match the planned bytes".into())
                }
                _ => None,
            };
            AcceptanceEvidence {
                kind: "artifact_sha256".into(),
                path: path.clone(),
                expected_sha256: sha256.clone(),
                observed_sha256: observed.ok(),
                planner_request_key: planner_request_key.into(),
                worker_request_key: worker_request_key.into(),
                verified_at_ms: super::unix_now_ms(),
                passed,
                error,
            }
        })
        .collect())
}

/// A reviewer's approval cannot substitute for missing, stale or failed host observations.
pub(super) fn review_failure(root: Option<&Path>, run: &Run) -> Option<&'static str> {
    for worker in run.nodes.iter().filter(|node| node.role == Role::Worker) {
        let Some(assignment) = run.assignments.get(&worker.id) else {
            continue;
        };
        if assignment.checks.is_empty() || assignment.skip_reason.is_some() {
            continue;
        }
        let Some(receipt) = worker.receipt.as_ref().filter(|receipt| {
            worker.state == super::State::Finished
                && receipt.status == "completed"
                && receipt.turn_id.is_some()
        }) else {
            return Some("Required acceptance evidence has no completed worker attempt");
        };
        let canonical_root = root.and_then(|root| root.canonicalize().ok());
        if canonical_root.as_deref().is_none_or(|root| {
            receipt.acceptance_workspace_root.as_deref().map(Path::new) != Some(root)
        }) {
            return Some(
                "Required host acceptance evidence belongs to an unknown or changed workspace",
            );
        }
        let current = match observe_worker(canonical_root.as_deref(), run, worker) {
            Ok(current) => current,
            Err(error) => return Some(error),
        };
        if current.len() != receipt.acceptance_evidence.len() {
            return Some("Required host acceptance evidence is missing");
        }
        for (fresh, recorded) in current.iter().zip(&receipt.acceptance_evidence) {
            if !fresh.passed
                || !recorded.passed
                || fresh.kind != recorded.kind
                || fresh.path != recorded.path
                || fresh.expected_sha256 != recorded.expected_sha256
                || fresh.observed_sha256 != recorded.observed_sha256
                || fresh.planner_request_key != recorded.planner_request_key
                || fresh.worker_request_key != recorded.worker_request_key
            {
                return Some("Required host acceptance evidence failed or became stale");
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    fn fixture() -> tempfile::TempDir {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .find(|path| path.join("src-tauri").is_dir())
            .expect("repository");
        tempfile::Builder::new()
            .prefix("ao-acceptance-")
            .tempdir_in(repo.join("aiTemp"))
            .unwrap()
    }
    #[test]
    fn artifact_checks_require_bounded_workspace_relative_paths_and_lowercase_sha256() {
        let hash = "a".repeat(64);
        let check = |path: &str, sha256: &str| AcceptanceCheck::ArtifactSha256 {
            path: path.into(),
            sha256: sha256.into(),
        };
        assert!(check("reports/result.json", &hash).valid());
        for path in [
            "../outside",
            "a/../outside",
            "/absolute",
            "C:\\outside",
            "@other/file",
            "a//b",
            "a/./b",
        ] {
            assert!(!check(path, &hash).valid(), "{path}");
        }
        assert!(!check("a.txt", &hash.to_uppercase()).valid());
        assert!(serde_json::from_str::<AcceptanceCheck>(
            r#"{"kind":"command","command":"echo ok"}"#
        )
        .is_err());
    }
    #[test]
    fn artifact_verifier_reads_actual_bytes_and_rejects_missing_or_large_files() {
        let dir = fixture();
        std::fs::write(dir.path().join("a.txt"), b"actual bytes").unwrap();
        assert_eq!(
            artifact_sha256(dir.path(), "a.txt").unwrap(),
            format!("{:x}", Sha256::digest(b"actual bytes"))
        );
        assert!(artifact_sha256(dir.path(), "missing").is_err());
        assert!(artifact_sha256(dir.path(), ".").is_err());
        let large = File::create(dir.path().join("large.bin")).unwrap();
        large.set_len(MAX_ARTIFACT_BYTES + 1).unwrap();
        assert!(artifact_sha256(dir.path(), "large.bin").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn artifact_verifier_rejects_symlinks_outside_workspace() {
        let dir = fixture();
        let outside = fixture();
        std::fs::write(outside.path().join("file"), b"outside").unwrap();
        std::os::unix::fs::symlink(outside.path().join("file"), dir.path().join("link")).unwrap();
        assert!(artifact_sha256(dir.path(), "link").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn artifact_verifier_rejects_fifo_without_waiting_for_a_writer() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt, sync::mpsc, time::Duration};
        let dir = fixture();
        let fifo = dir.path().join("pipe");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let root = dir.path().to_path_buf();
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = sender.send(artifact_sha256(&root, "pipe"));
        });
        let result = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("special files must not block the controller waiting for a writer");
        assert!(result.is_err());
        worker.join().unwrap();
    }
}
