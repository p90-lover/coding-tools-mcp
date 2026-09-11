use super::{err, AppResult};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
pub(super) struct Snapshot {
    pub id: String,
    pub directory: PathBuf,
    pub input: PathBuf,
    pub work: PathBuf,
}
pub(super) fn safe_path(path: &Path) -> AppResult<()> {
    for p in path.ancestors() {
        let m = fs::symlink_metadata(p)?;
        if m.file_type().is_symlink() {
            return Err(err("Snapshot paths cannot traverse symlinks"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err(err("Reparse points are not supported"));
            }
        }
    }
    Ok(())
}
// Validate existing ancestors before creating any child. Never follow a stored
// symlink/reparse point merely to discover afterwards that it was unsafe.
pub(super) fn create_safe_directory(path: &Path) -> AppResult<()> {
    if path.exists() {
        safe_path(path)?;
        if !path.is_dir() {
            return Err(err("Storage path is not a directory"));
        }
        return Ok(());
    }
    let parent = path.parent().ok_or_else(|| err("Invalid storage root"))?;
    create_safe_directory(parent)?;
    fs::create_dir(path)?;
    safe_path(path)
}
fn relative(value: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(value);
    if value.is_empty()
        || value.len() > 240
        || value.contains(['\0', ':'])
        || value.starts_with('@')
        || p.is_absolute()
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(err("Input must be an ordinary relative file path"));
    }
    for c in p.components() {
        let s = c.as_os_str().to_string_lossy().to_lowercase();
        let stem = s.split('.').next().unwrap_or("");
        if s.starts_with('.')
            || s.ends_with([' ', '.'])
            || matches!(
                s.as_str(),
                "trash"
                    | "aitemp"
                    | "node_modules"
                    | "credentials"
                    | "secrets"
                    | "profiles.json"
                    | "auth.json"
                    | "id_rsa"
                    | "id_ed25519"
                    | "credentials.json"
                    | "credentials.toml"
                    | "secrets.json"
                    | "secrets.toml"
                    | "token.json"
                    | "tokens.json"
            )
            || s.ends_with(".pem")
            || s.ends_with(".key")
            || matches!(stem, "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err(err("Sensitive, reserved or internal input path denied"));
        }
    }
    Ok(p)
}
pub(super) fn prepare(root: &Path, home: &Path, files: &[String]) -> AppResult<Snapshot> {
    if files.len() > 64 {
        return Err(err("At most 64 explicit input files"));
    }
    safe_path(root)?;
    create_safe_directory(home)?;
    let home = home.canonicalize()?;
    if root.starts_with(&home) || home.starts_with(root) {
        return Err(err("Sandbox storage must be outside the workspace"));
    }
    let runs = home.join("runs");
    create_safe_directory(&runs)?;
    if fs::read_dir(&runs)?.take(33).count() >= 32 {
        return Err(err(
            "32 snapshots retained. Archive them locally before another run; nothing was deleted",
        ));
    }
    // Validate and read the bounded input set before allocating a retained run.
    let mut inputs = Vec::new();
    let mut seen = HashSet::new();
    let mut bytes = 0u64;
    for name in files {
        let relative = relative(name)?;
        let source = root.join(&relative);
        safe_path(&source)?;
        let resolved = source.canonicalize()?;
        if !resolved.starts_with(root) {
            return Err(err("Input escaped the workspace"));
        }
        if !seen.insert(resolved.to_string_lossy().to_lowercase()) {
            return Err(err("Duplicate input path"));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let file = options.open(&source)?;
        let meta = file.metadata()?;
        if !meta.is_file() || meta.len() > 16 * 1024 * 1024 - bytes {
            return Err(err("Input total exceeds 16 MiB or is not a regular file"));
        }
        let mut content = Vec::new();
        file.take(16 * 1024 * 1024 - bytes + 1)
            .read_to_end(&mut content)?;
        bytes += content.len() as u64;
        if bytes > 16 * 1024 * 1024 {
            return Err(err("Input grew past the snapshot limit"));
        }
        inputs.push((relative, content));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let directory = runs.join(&id);
    fs::create_dir(&directory)?;
    let input = directory.join("input");
    let work = directory.join("work");
    fs::create_dir(&input)?;
    fs::create_dir(&work)?;
    // Never reopen an input after validation. All copies come from these
    // bounded buffers. A later destination-I/O failure remains retained evidence.
    for (relative, content) in inputs {
        let destination = input.join(relative);
        create_safe_directory(destination.parent().unwrap())?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        output.write_all(&content)?;
    }
    Ok(Snapshot {
        id,
        directory,
        input,
        work,
    })
}
pub(super) fn executable(value: &str, input: &Path) -> AppResult<PathBuf> {
    let p = PathBuf::from(value);
    let p = if p.is_absolute() {
        p
    } else {
        input.join(relative(value)?)
    };
    safe_path(&p)?;
    let resolved = p.canonicalize()?;
    if !resolved.is_file()
        || resolved
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|s| !s.eq_ignore_ascii_case("exe"))
    {
        return Err(err("Select a regular EXE, not a shell script or wrapper"));
    }
    // The native helper additionally checks GetSystemDirectoryW; environment
    // variables cannot nominate a host executable outside the true system root.
    if !resolved.starts_with(input) {
        #[cfg(not(windows))]
        {
            return Err(err("Only Windows system executables are supported"));
        }
        #[cfg(windows)]
        {
            use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
            let mut buffer = [0u16; 32768];
            let length = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
            if length == 0 || length >= buffer.len() {
                return Err(err("Cannot resolve system executables"));
            }
            let system =
                PathBuf::from(String::from_utf16_lossy(&buffer[..length])).canonicalize()?;
            if !resolved.starts_with(system) {
                return Err(err(
                    "Host executable outside Windows system directory; select a copied input EXE",
                ));
            }
        }
    }
    Ok(resolved)
}
