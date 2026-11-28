//! What keeps a failing profile save from filling the disk.
//!
//! A save stages the whole store in `aiTemp/data-write` and then installs it. On 2026-11-28 the
//! live profiles.json (22 MB) refused renames after an antivirus restored it from quarantine.
//! Every save left its staged copy behind, and the next request saved again about every 17 s:
//! 21 MB a try, about 5 GB an hour, until the drive was full. Here a staged copy is removed
//! unless it was installed, saves after a failure back off, the failure is reported once, and
//! copies an earlier process left are swept when the store first loads.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// Prefix and extension of the staged copies, which other files in `data-write` don't share.
pub(super) const STAGED_PREFIX: &str = "profiles";
pub(super) const STAGED_EXTENSION: &str = "tmp";

/// The wait after the first failed save, doubled for each further one up to the longest.
const FIRST_RETRY: Duration = Duration::from_secs(5);
const LONGEST_RETRY: Duration = Duration::from_secs(5 * 60);

/// A staged copy older than this belongs to a save that can no longer be running.
const STALE_STAGED_AGE: Duration = Duration::from_secs(60 * 60);

pub(super) fn staged_dir(app_root: &Path) -> PathBuf {
    app_root.join("aiTemp").join("data-write")
}

/// A staged copy of the data file, removed when dropped unless it was installed. Drop runs on
/// every early return, so no failure after the copy exists can leave it behind.
pub(super) struct StagedFile {
    path: PathBuf,
    installed: bool,
}

impl StagedFile {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            installed: false,
        }
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    /// The copy is the data file now: nothing is left to remove.
    pub(super) fn installed(mut self) {
        self.installed = true;
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if self.installed {
            return;
        }
        match std::fs::remove_file(&self.path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                eprintln!("Profile data: a failed save could not remove its staged copy: {error}");
            }
            _ => {}
        }
    }
}

/// How long saves wait after `failures` failed saves in a row: the first retry after
/// FIRST_RETRY, doubled for each further failure, never longer than LONGEST_RETRY.
pub(super) fn retry_delay(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    FIRST_RETRY
        .saturating_mul(1u32 << doublings)
        .min(LONGEST_RETRY)
}

struct Failures {
    count: u32,
    retry_at: Instant,
    kind: std::io::ErrorKind,
    last: String,
}

/// Failed saves in a row, per data file. Each process keeps its own: a save that works again
/// clears it, and a restarted app starts over.
static FAILURES: Mutex<Option<HashMap<PathBuf, Failures>>> = Mutex::new(None);

fn failures() -> std::sync::MutexGuard<'static, Option<HashMap<PathBuf, Failures>>> {
    FAILURES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// While the wait after a failed save of `path` runs, the error a save gets instead of staging
/// the store again; it keeps the kind of the failure that started the wait.
pub(super) fn paused(path: &Path) -> Option<std::io::Error> {
    let failures = failures();
    let failure = failures.as_ref()?.get(path)?;
    let left = failure.retry_at.checked_duration_since(Instant::now())?;
    Some(std::io::Error::new(
        failure.kind,
        format!(
            "Profile persistence (paused): {} failed saves in a row, next attempt in {} s; last failure: {}",
            failure.count,
            left.as_millis().div_ceil(1000).max(1),
            failure.last
        ),
    ))
}

/// Counts a failed save of `path` and starts the wait before the next one. True for the first
/// failure since the last save that worked: the one to report.
pub(super) fn record_failure(path: &Path, error: &crate::error::AppError) -> bool {
    let kind = match error {
        crate::error::AppError::Io(error) => error.kind(),
        _ => std::io::ErrorKind::Other,
    };
    let mut failures = failures();
    let failure = failures
        .get_or_insert_with(HashMap::new)
        .entry(path.to_path_buf())
        .or_insert(Failures {
            count: 0,
            retry_at: Instant::now(),
            kind,
            last: String::new(),
        });
    failure.count = failure.count.saturating_add(1);
    failure.retry_at = Instant::now() + retry_delay(failure.count);
    failure.kind = kind;
    failure.last = error.to_string();
    failure.count == 1
}

/// A save of `path` worked: the failed ones before it, if there were any, are forgotten.
pub(super) fn record_success(path: &Path) -> Option<u32> {
    failures()
        .as_mut()?
        .remove(path)
        .map(|failure| failure.count)
}

/// Ends the wait after a failure, as if it had run out.
#[cfg(test)]
pub(super) fn expire_wait(path: &Path) {
    if let Some(failure) = failures().as_mut().and_then(|map| map.get_mut(path)) {
        failure.retry_at = Instant::now();
    }
}

/// Removes, once per process and folder, the staged copies older than an hour that failed or
/// interrupted saves left in `dir`. Best effort: a copy that cannot go stays.
pub(super) fn sweep_stale_once(dir: &Path) {
    static SWEPT: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
    let first = SWEPT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get_or_insert_with(HashSet::new)
        .insert(dir.to_path_buf());
    if !first {
        return;
    }
    let (removed, bytes) = sweep_stale(dir, STALE_STAGED_AGE, SystemTime::now());
    if removed > 0 {
        eprintln!(
            "Profile data: removed {removed} staged copies ({} MB) that earlier failed saves left",
            bytes / (1024 * 1024)
        );
    }
}

/// Removes the staged copies in `dir` last written at least `max_age` before `now`; returns how
/// many went and their size. Only regular files named like a staged copy are touched.
pub(super) fn sweep_stale(dir: &Path, max_age: Duration, now: SystemTime) -> (usize, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let prefix = format!("{STAGED_PREFIX}-");
    let extension = format!(".{STAGED_EXTENSION}");
    let mut removed = (0, 0);
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(&prefix) || !name.ends_with(&extension) {
            continue;
        }
        // Not followed through a link: only the staged file itself counts.
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let stale = metadata.is_file()
            && metadata
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= max_age);
        if stale && std::fs::remove_file(entry.path()).is_ok() {
            removed.0 += 1;
            removed.1 += metadata.len();
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let parent = std::env::current_dir()
            .unwrap()
            .join("aiTemp/staged-write-tests");
        std::fs::create_dir_all(&parent).unwrap();
        tempfile::tempdir_in(parent).unwrap()
    }

    #[test]
    fn failed_saves_wait_twice_as_long_each_time_up_to_five_minutes() {
        assert_eq!(retry_delay(1), Duration::from_secs(5));
        assert_eq!(retry_delay(2), Duration::from_secs(10));
        assert_eq!(retry_delay(3), Duration::from_secs(20));
        assert_eq!(retry_delay(6), Duration::from_secs(160));
        assert_eq!(retry_delay(7), LONGEST_RETRY);
        assert_eq!(retry_delay(u32::MAX), LONGEST_RETRY);
        // Never shorter than the wait before it.
        for failures in 1..64 {
            assert!(retry_delay(failures + 1) >= retry_delay(failures));
        }
    }

    #[test]
    fn a_failure_is_reported_once_until_a_save_works_again() {
        let path = PathBuf::from(format!("report-once-{}", uuid::Uuid::new_v4()));
        let error =
            crate::error::AppError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert!(
            record_failure(&path, &error),
            "the first failure is reported"
        );
        assert!(!record_failure(&path, &error), "a retry is not");
        assert!(!record_failure(&path, &error));
        assert_eq!(record_success(&path), Some(3));
        assert_eq!(
            record_success(&path),
            None,
            "a later success has nothing to clear"
        );
        assert!(record_failure(&path, &error), "a new run of failures is");
        record_success(&path);
    }

    #[test]
    fn a_paused_save_keeps_the_failure_kind_and_says_when_it_retries() {
        let path = PathBuf::from(format!("paused-{}", uuid::Uuid::new_v4()));
        assert!(paused(&path).is_none());
        let error =
            crate::error::AppError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        record_failure(&path, &error);
        let pause = paused(&path).expect("paused after a failure");
        assert_eq!(pause.kind(), std::io::ErrorKind::PermissionDenied);
        let message = pause.to_string();
        assert!(message.contains("Profile persistence (paused): 1 failed saves in a row"));
        // 5 s, or less if a slow disk stalled the test since the failure.
        assert!(
            ["1", "2", "3", "4", "5"]
                .iter()
                .any(|secs| message.contains(&format!("next attempt in {secs} s"))),
            "{message}"
        );
        expire_wait(&path);
        assert!(
            paused(&path).is_none(),
            "the next save may try once the wait ran out"
        );
        record_success(&path);
    }

    #[test]
    fn dropping_a_staged_file_removes_it_unless_it_was_installed() {
        let root = fixture();
        let dropped = root.path().join("profiles-1-a.tmp");
        std::fs::write(&dropped, "{}").unwrap();
        drop(StagedFile::new(dropped.clone()));
        assert!(!dropped.exists());
        let kept = root.path().join("profiles-2-b.tmp");
        std::fs::write(&kept, "{}").unwrap();
        StagedFile::new(kept.clone()).installed();
        assert!(kept.exists());
        // A copy that is already gone is no error.
        drop(StagedFile::new(root.path().join("profiles-3-c.tmp")));
    }

    #[test]
    fn sweep_removes_only_staged_copies_older_than_an_hour() {
        let root = fixture();
        let dir = root.path();
        let old = dir.join("profiles-1-old.tmp");
        let fresh = dir.join("profiles-2-fresh.tmp");
        let other_old = dir.join("coding-tools-open-probe-g-1.tmp");
        let old_json = dir.join("profiles-3-old.json");
        let old_folder = dir.join("profiles-4-folder.tmp");
        for file in [&old, &fresh, &other_old, &old_json] {
            std::fs::write(file, "{}").unwrap();
        }
        std::fs::create_dir(&old_folder).unwrap();
        let two_hours_ago = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        for file in [&old, &other_old, &old_json] {
            std::fs::OpenOptions::new()
                .write(true)
                .open(file)
                .unwrap()
                .set_modified(two_hours_ago)
                .unwrap();
        }
        let (removed, bytes) = sweep_stale(dir, STALE_STAGED_AGE, SystemTime::now());
        assert_eq!((removed, bytes), (1, 2));
        assert!(!old.exists());
        assert!(fresh.exists(), "a save may still be writing it");
        assert!(other_old.exists() && old_json.exists() && old_folder.exists());
        // A folder that does not exist has nothing to sweep.
        assert_eq!(
            sweep_stale(&dir.join("missing"), STALE_STAGED_AGE, SystemTime::now()),
            (0, 0)
        );
    }

    #[test]
    fn the_start_sweep_runs_once_per_folder() {
        let root = fixture();
        let dir = root.path();
        let first = dir.join("profiles-1-first.tmp");
        std::fs::write(&first, "{}").unwrap();
        let two_hours_ago = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        let age = |file: &Path| {
            std::fs::OpenOptions::new()
                .write(true)
                .open(file)
                .unwrap()
                .set_modified(two_hours_ago)
                .unwrap();
        };
        age(&first);
        sweep_stale_once(dir);
        assert!(!first.exists());
        let later = dir.join("profiles-2-later.tmp");
        std::fs::write(&later, "{}").unwrap();
        age(&later);
        sweep_stale_once(dir);
        assert!(later.exists(), "only the first load in a process sweeps");
    }
}
