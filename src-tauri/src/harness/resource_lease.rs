//! Hierarchical cross-process write coordination, held for an owned command's lifetime.
use super::{HarnessError, HarnessResult};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
};

#[derive(Debug)]
pub struct ResourceLease {
    _handles: Vec<File>,
}
impl ResourceLease {
    pub fn acquire(store: &Path, root: &Path) -> HarnessResult<Self> {
        let root = root
            .canonicalize()
            .map_err(|e| HarnessError::new("WORKSPACE_UNAVAILABLE", e.to_string()))?;
        let directory = store.join("aiTemp/resource-leases");
        fs::create_dir_all(&directory)
            .map_err(|e| HarnessError::new("RESOURCE_LEASE_UNAVAILABLE", e.to_string()))?;
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
            lock.map_err(|_| HarnessError::new("PROJECT_WRITE_BUSY", "An owned operation is still using this project or an overlapping directory. Poll its existing command; independent projects and read-only monitoring remain available."))?;
            handles.push(handle);
        }
        Ok(Self { _handles: handles })
    }
}
