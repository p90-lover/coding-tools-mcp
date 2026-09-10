use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Move an application-managed file or directory into the persistent app Trash.
/// Refuses paths outside the app config root and never falls back to deletion.
pub fn move_to_app_trash(path: &Path, category: &str) -> AppResult<Option<PathBuf>> {
    if !path.exists() && !path.is_symlink() {
        return Ok(None);
    }
    if category.is_empty()
        || !category
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(AppError::Message("Invalid Trash category".into()));
    }
    let app_root = super::platform().app_config_dir()?;
    std::fs::create_dir_all(&app_root)?;
    let canonical_root = app_root.canonicalize()?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Message("Managed path has no parent".into()))?;
    let canonical_parent = parent.canonicalize()?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(AppError::Message(
            "Refusing to retire a path outside the application config directory".into(),
        ));
    }
    let trash = app_root.join("Trash").join(category);
    std::fs::create_dir_all(&trash)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("item");
    let target = trash.join(format!("{}-{}-{name}", unix_millis(), uuid::Uuid::new_v4()));
    std::fs::rename(path, &target)?;
    Ok(Some(target))
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
