//! Hierarchical cross-process write coordination, held for an owned command's lifetime.
use super::{HarnessError, HarnessResult};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
    sync::{RwLock, RwLockReadGuard},
    time::{Duration, Instant},
};

/// How long a busy lock may be a transient copy before admission reports it busy.
///
/// On Unix these are `flock` locks, which belong to the open file description. A child being
/// spawned by any thread duplicates every open descriptor until it execs (glibc's posix_spawn is
/// a clone that copies the descriptor table, and `O_CLOEXEC` closes the copies only at exec), so
/// a lease released just before can still read as held for that moment. Callers that saw a
/// command finish and started the next one were refused at random under parallel spawning.
/// A genuinely running owner is still refused, this much later. The app's own spawns no longer
/// leave such copies (`spawn_gate`); this patience covers a spawn made outside it.
const TRANSIENT_HOLD: Duration = Duration::from_millis(250);
const RETRY_EVERY: Duration = Duration::from_millis(10);

/// Child spawns share this gate; a lease attempt takes it alone.
static SPAWN_GATE: RwLock<()> = RwLock::new(());

/// Held around every child spawn in this process (shared, so spawns never wait on each other).
///
/// `spawn()` returns only once the child has exec'd (or failed to), and exec closes the lease's
/// `O_CLOEXEC` descriptors the child inherited. So while a lease attempt holds the gate alone, no
/// child of this process holds a copy of a released lease, and a lease just released is free at
/// once. On a loaded macOS runner a sibling's spawn outlived the 250 ms patience and a command
/// that had finished still refused the next one as `PROJECT_WRITE_BUSY`.
pub fn spawn_gate() -> RwLockReadGuard<'static, ()> {
    SPAWN_GATE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug)]
pub struct ResourceLease {
    _handles: Vec<File>,
}
impl ResourceLease {
    pub fn acquire(store: &Path, root: &Path) -> HarnessResult<Self> {
        Self::acquire_within(store, root, TRANSIENT_HOLD)
    }

    fn acquire_within(store: &Path, root: &Path, patience: Duration) -> HarnessResult<Self> {
        let root = root
            .canonicalize()
            .map_err(|e| HarnessError::new("WORKSPACE_UNAVAILABLE", e.to_string()))?;
        let directory = store.join("aiTemp/resource-leases");
        fs::create_dir_all(&directory)
            .map_err(|e| HarnessError::new("RESOURCE_LEASE_UNAVAILABLE", e.to_string()))?;
        let deadline = Instant::now() + patience;
        loop {
            // Alone at the gate for one attempt only: spawns wait microseconds, never the retry sleep.
            let attempt = {
                let _alone = SPAWN_GATE
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                Self::try_acquire(&directory, &root)?
            };
            match attempt {
                Some(lease) => return Ok(lease),
                None if Instant::now() < deadline => std::thread::sleep(RETRY_EVERY),
                None => return Err(HarnessError::new("PROJECT_WRITE_BUSY", "An owned operation is still using this project or an overlapping directory. Poll its existing command; independent projects and read-only monitoring remain available.")),
            }
        }
    }

    /// One attempt at the whole hierarchy. A busy level releases the levels already taken
    /// (their handles drop with this attempt), so a waiting caller holds nothing between tries.
    fn try_acquire(directory: &Path, root: &Path) -> HarnessResult<Option<Self>> {
        let mut ancestors: Vec<_> = root.ancestors().collect();
        ancestors.reverse();
        let mut handles = Vec::with_capacity(ancestors.len());
        for path in ancestors {
            let key = path.to_string_lossy().replace('\\', "/");
            #[cfg(windows)]
            let key = key.to_lowercase();
            let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
            let handle = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(directory.join(format!("{digest}.lock")))
                .map_err(|e| HarnessError::new("RESOURCE_LEASE_UNAVAILABLE", e.to_string()))?;
            let lock = if path == root {
                fs2::FileExt::try_lock_exclusive(&handle)
            } else {
                fs2::FileExt::try_lock_shared(&handle)
            };
            if lock.is_err() {
                return Ok(None);
            }
            handles.push(handle);
        }
        Ok(Some(Self { _handles: handles }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let base = tempfile::tempdir().expect("temp dir");
        let store = base.path().join("store");
        let root = base.path().join("project");
        fs::create_dir_all(&root).expect("project");
        (base, store, root)
    }

    #[test]
    fn a_lease_held_only_for_a_moment_is_waited_out() {
        let (_base, store, root) = fixture();
        let held = ResourceLease::acquire(&store, &root).expect("first lease");
        // The holder lets go shortly after, as a spawning child's descriptor copy does at exec.
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            drop(held);
        });
        let started = Instant::now();
        let next = ResourceLease::acquire(&store, &root);
        release.join().expect("release thread");
        assert!(next.is_ok(), "{next:?}");
        // Generous slack: a loaded CI runner can delay the waiting thread. The bound itself is
        // covered by a_lease_still_held_is_refused_as_busy_after_the_bounded_wait.
        assert!(started.elapsed() < TRANSIENT_HOLD + Duration::from_secs(2));
    }

    #[test]
    fn a_lease_still_held_is_refused_as_busy_after_the_bounded_wait() {
        let (_base, store, root) = fixture();
        let _held = ResourceLease::acquire(&store, &root).expect("first lease");
        let started = Instant::now();
        let error = ResourceLease::acquire_within(&store, &root, Duration::from_millis(40))
            .expect_err("a running owner keeps the project");
        assert_eq!(error.code(), "PROJECT_WRITE_BUSY");
        assert!(started.elapsed() >= Duration::from_millis(40));
    }

    #[test]
    fn a_lease_attempt_waits_out_a_spawn_in_progress_and_spawns_never_wait_on_each_other() {
        let (_base, store, root) = fixture();
        // A spawn is in progress on another thread (its child may still hold descriptor copies).
        let spawning = spawn_gate();
        // Spawns share the gate: a second one is never held up by the first.
        let started = Instant::now();
        drop(spawn_gate());
        assert!(started.elapsed() < Duration::from_millis(50));
        let attempt = std::thread::spawn(move || {
            let started = Instant::now();
            let lease = ResourceLease::acquire(&store, &root);
            (lease.is_ok(), started.elapsed())
        });
        std::thread::sleep(Duration::from_millis(80));
        drop(spawning);
        let (acquired, waited) = attempt.join().expect("lease attempt");
        assert!(acquired, "the lease is free once the spawn has finished");
        assert!(
            waited >= Duration::from_millis(60),
            "the attempt waited for the spawn: {waited:?}"
        );
    }

    #[test]
    fn independent_projects_and_a_released_lease_never_wait() {
        let (_base, store, root) = fixture();
        let sibling = root.with_file_name("other-project");
        fs::create_dir_all(&sibling).expect("sibling");
        let _held = ResourceLease::acquire(&store, &root).expect("first lease");
        // No patience at all: the first attempt must take it, so there was no retry wait. A 100 ms
        // wall-clock bound also counted the spawn gate's wait behind sibling tests' spawns and
        // failed on a loaded Windows runner.
        ResourceLease::acquire_within(&store, &sibling, Duration::ZERO)
            .expect("an independent project is not blocked");
    }
}
