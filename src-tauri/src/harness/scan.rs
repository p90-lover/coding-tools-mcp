//! Bounded source fingerprinting. Scope is not a filesystem permission grant.
use super::{
    model::BaselineEntry,
    store::{HarnessError, HarnessResult},
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant, SystemTime},
};
use walkdir::WalkDir;

pub const CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct ScanLimits {
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_entries: usize,
    pub deadline: Duration,
}
impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 8 * 1024 * 1024 * 1024,
            max_total_bytes: 64 * 1024 * 1024 * 1024,
            max_entries: 100_000,
            deadline: Duration::from_secs(300),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ScanProgress {
    pub files_hashed: usize,
    pub bytes_hashed: u64,
    pub peak_chunk_bytes: usize,
    pub elapsed_ms: u128,
}
#[derive(Debug)]
pub struct SourceScan {
    pub source_roots: Option<Vec<String>>,
    pub entries: Vec<BaselineEntry>,
    pub fingerprint: String,
    pub progress: ScanProgress,
}

static ACTIVE_SCANS: AtomicUsize = AtomicUsize::new(0);
struct ScanSlot;
impl ScanSlot {
    fn enter() -> HarnessResult<Self> {
        ACTIVE_SCANS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 2).then_some(n + 1)
            })
            .map_err(|_| {
                error(
                    "BASELINE_SCAN_BUSY",
                    "Two scans are already running; no additional scan was started",
                )
            })?;
        Ok(Self)
    }
}
impl Drop for ScanSlot {
    fn drop(&mut self) {
        ACTIVE_SCANS.fetch_sub(1, Ordering::Release);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp {
    bytes: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    directory: bool,
    readonly: bool,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}
fn stamp(meta: &Metadata) -> HarnessResult<Stamp> {
    Ok(Stamp {
        bytes: meta.len(),
        modified: meta.modified().map_err(io_error)?,
        created: meta.created().ok(),
        directory: meta.is_dir(),
        readonly: meta.permissions().readonly(),
        #[cfg(unix)]
        identity: {
            use std::os::unix::fs::MetadataExt;
            (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec())
        },
    })
}
fn is_link(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}
fn error(code: &'static str, message: &str) -> HarnessError {
    HarnessError::new(code, message)
}
fn io_error(e: std::io::Error) -> HarnessError {
    HarnessError::new(
        "BASELINE_SCAN_IO_FAILED",
        format!("Source could not be verified: {e}. No partial baseline was accepted."),
    )
}

// Preserve legacy transient-directory policy; never silently exclude model/data files by extension.
pub(crate) fn ignored(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .into_iter()
        .flat_map(|p| p.components())
        .filter_map(|c| c.as_os_str().to_str())
        .any(|name| {
            matches!(
                name,
                ".git"
                    | "aiTemp"
                    | "Trash"
                    | ".mcp-probe-kit"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | ".svelte-kit"
            )
        })
}

fn normalized_roots(root: &Path, roots: Option<&[String]>) -> HarnessResult<Option<Vec<String>>> {
    let Some(roots) = roots else { return Ok(None) };
    if roots.is_empty() || roots.len() > 128 {
        return Err(error(
            "INVALID_BASELINE_SCOPE",
            "Select 1..128 exact code/config paths",
        ));
    }
    let mut selected = Vec::new();
    for raw in roots {
        let path = raw.replace('\\', "/");
        if path.is_empty()
            || path.len() > 1024
            || path.chars().any(|c| c.is_control())
            || path.contains([':', '*', '?', '[', ']'])
            || path.starts_with('/')
            || path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with(['.', ' ']))
            || ignored(&root.join(&path), root)
        {
            return Err(error("INVALID_BASELINE_SCOPE", "Use explicit relative source paths, not globs, traversal, or ignored output directories"));
        }
        selected.push(path);
    }
    selected.sort();
    let keys: Vec<_> = selected.iter().map(|s| s.to_lowercase()).collect();
    for (i, a) in keys.iter().enumerate() {
        for b in &keys[i + 1..] {
            if a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/")) {
                return Err(error(
                    "INVALID_BASELINE_SCOPE",
                    "Selected source roots overlap",
                ));
            }
        }
    }
    Ok(Some(selected))
}

fn checked_metadata(root: &Path, path: &Path) -> HarnessResult<Metadata> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| error("INVALID_BASELINE_SCOPE", "Path escaped source root"))?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        if is_link(&fs::symlink_metadata(&current).map_err(io_error)?) {
            return Err(error(
                "BASELINE_SYMLINK_REJECTED",
                "A selected source path is a symlink or reparse point",
            ));
        }
    }
    let real = path.canonicalize().map_err(io_error)?;
    if !real.starts_with(root) {
        return Err(error(
            "INVALID_BASELINE_SCOPE",
            "Source resolves outside its approved root",
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(error(
            "BASELINE_SPECIAL_FILE_REJECTED",
            "Only regular source files and directories can be fingerprinted",
        ));
    }
    Ok(metadata)
}

fn inventory(
    root: &Path,
    roots: Option<&[String]>,
    limits: &ScanLimits,
    check: &dyn Fn() -> HarnessResult<()>,
) -> HarnessResult<BTreeMap<String, Stamp>> {
    let starts: Vec<PathBuf> = roots
        .map(|paths| paths.iter().map(|p| root.join(p)).collect())
        .unwrap_or_else(|| vec![root.to_path_buf()]);
    let mut found = BTreeMap::new();
    let mut path_bytes = 0usize;
    for start in starts {
        checked_metadata(root, &start)?;
        for item in WalkDir::new(&start)
            .follow_links(false)
            .max_open(8)
            .into_iter()
            .filter_entry(|entry| !ignored(entry.path(), root))
        {
            check()?;
            let item =
                item.map_err(|e| HarnessError::new("BASELINE_SCAN_IO_FAILED", e.to_string()))?;
            if item.depth() > 64 || found.len() >= limits.max_entries {
                return Err(error(
                    "BASELINE_BUDGET_EXCEEDED",
                    "Selected source exceeds the entry/depth budget; narrow the source scope",
                ));
            }
            let rel = item
                .path()
                .strip_prefix(root)
                .map_err(|_| error("INVALID_BASELINE_SCOPE", "Invalid source path"))?
                .to_str()
                .ok_or_else(|| error("BASELINE_PATH_ENCODING", "Source path is not valid UTF-8"))?
                .replace('\\', "/");
            path_bytes = path_bytes.saturating_add(rel.len());
            if path_bytes > 16 * 1024 * 1024 {
                return Err(error(
                    "BASELINE_BUDGET_EXCEEDED",
                    "Source path index exceeds the bounded memory budget",
                ));
            }
            found.insert(rel, stamp(&checked_metadata(root, item.path())?)?);
        }
    }
    Ok(found)
}

pub fn capture(
    root: &Path,
    roots: Option<&[String]>,
    limits: &ScanLimits,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(&ScanProgress),
) -> HarnessResult<SourceScan> {
    let root = root.canonicalize().map_err(io_error)?;
    let roots = normalized_roots(&root, roots)?;
    if limits.max_file_bytes == 0
        || limits.max_total_bytes == 0
        || limits.max_entries == 0
        || limits.max_entries > 100_000
        || limits.deadline.is_zero()
        || limits.deadline > Duration::from_secs(3600)
    {
        return Err(error("INVALID_SCAN_LIMITS", "Invalid bounded scan limits"));
    }
    let _slot = ScanSlot::enter()?;
    let started = Instant::now();
    let check = || {
        if cancel.load(Ordering::Acquire) {
            return Err(error(
                "BASELINE_SCAN_CANCELLED",
                "Scan was cancelled; no baseline was accepted",
            ));
        }
        if started.elapsed() > limits.deadline {
            return Err(error(
                "BASELINE_SCAN_DEADLINE",
                "Scan deadline reached; narrow scope or explicitly review its budget",
            ));
        }
        Ok(())
    };
    check()?;
    let initial = inventory(&root, roots.as_deref(), limits, &check)?;
    let mut progress = ScanProgress::default();
    let mut buffer = vec![0u8; CHUNK_BYTES];
    let mut entries = Vec::new();
    let mut last_report = Instant::now();
    on_progress(&progress);
    for (relative, before) in &initial {
        check()?;
        if before.directory {
            continue;
        }
        if before.bytes > limits.max_file_bytes
            || before.bytes > limits.max_total_bytes.saturating_sub(progress.bytes_hashed)
        {
            return Err(error(
                "BASELINE_BUDGET_EXCEEDED",
                "Selected files exceed the scan I/O budget; no partial fingerprint was accepted",
            ));
        }
        let path = root.join(relative);
        if stamp(&checked_metadata(&root, &path)?)? != *before {
            return Err(error(
                "BASELINE_CHANGED_DURING_SCAN",
                "Source changed before hashing",
            ));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Do not follow the final reparse point. Deny ordinary writers/deleters while hashing.
            options.custom_flags(0x0020_0000).share_mode(0x0000_0001);
        }
        let mut file = options.open(&path).map_err(io_error)?;
        let opened = file.metadata().map_err(io_error)?;
        if is_link(&opened) || !opened.is_file() || stamp(&opened)? != *before {
            return Err(error(
                "BASELINE_CHANGED_DURING_SCAN",
                "Opened source no longer matches the selected file",
            ));
        }
        let mut hasher = Sha256::new();
        let mut bytes = 0u64;
        let mut binary = false;
        loop {
            check()?;
            let n = file.read(&mut buffer).map_err(io_error)?;
            if n == 0 {
                break;
            }
            bytes = bytes
                .checked_add(n as u64)
                .ok_or_else(|| error("BASELINE_BUDGET_EXCEEDED", "Byte count overflow"))?;
            progress.bytes_hashed = progress
                .bytes_hashed
                .checked_add(n as u64)
                .ok_or_else(|| error("BASELINE_BUDGET_EXCEEDED", "Byte count overflow"))?;
            if bytes > limits.max_file_bytes || progress.bytes_hashed > limits.max_total_bytes {
                return Err(error(
                    "BASELINE_BUDGET_EXCEEDED",
                    "Source grew beyond the scan budget",
                ));
            }
            progress.peak_chunk_bytes = progress.peak_chunk_bytes.max(n);
            binary |= buffer[..n].contains(&0);
            hasher.update(&buffer[..n]);
            if last_report.elapsed() >= Duration::from_millis(250) {
                progress.elapsed_ms = started.elapsed().as_millis();
                on_progress(&progress);
                last_report = Instant::now();
            }
        }
        if bytes != before.bytes
            || stamp(&file.metadata().map_err(io_error)?)? != *before
            || stamp(&checked_metadata(&root, &path)?)? != *before
        {
            return Err(error(
                "BASELINE_CHANGED_DURING_SCAN",
                "Source changed while being hashed",
            ));
        }
        entries.push(BaselineEntry {
            path: relative.clone(),
            exists: true,
            is_binary: binary,
            sha256: format!("{:x}", hasher.finalize()),
            bytes,
        });
        progress.files_hashed += 1;
        progress.elapsed_ms = started.elapsed().as_millis();
        on_progress(&progress);
    }
    if inventory(&root, roots.as_deref(), limits, &check)? != initial {
        return Err(error(
            "BASELINE_CHANGED_DURING_SCAN",
            "Source inventory changed during verification",
        ));
    }
    check()?;
    let mut fingerprint = Sha256::new();
    if let Some(paths) = roots.as_ref() {
        fingerprint.update(b"scoped-baseline-v1\0");
        for path in paths {
            fingerprint.update((path.len() as u64).to_le_bytes());
            fingerprint.update(path.as_bytes());
        }
    }
    // Legacy unscoped fingerprint encoding stays unchanged; no automatic task rebaseline.
    for entry in &entries {
        fingerprint.update(entry.path.as_bytes());
        fingerprint.update(entry.sha256.as_bytes());
        fingerprint.update(entry.bytes.to_le_bytes());
    }
    Ok(SourceScan {
        source_roots: roots,
        entries,
        fingerprint: format!("{:x}", fingerprint.finalize()),
        progress,
    })
}
