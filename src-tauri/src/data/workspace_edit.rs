//! Editing a project (workspace) in place and removing it from the app's list.
//!
//! Editing changes the project's name, its primary folder and its extra source folders (the
//! `.mcp-paths` mappings under the primary folder). Removing drops only the app's record of the
//! project: no project file is deleted, and its saved missions stay in the data file.

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::integrations::ao::State as NodeState;
use crate::integrations::ao_lifecycle::ScheduleState;
use crate::workspace::linked_projects::{
    list_linked_projects_for_root, quick_add_linked_project_for_root, remove_linked_project_mapping,
};
use crate::workspace::WorkspaceProfile;

use super::{AppData, DataStore};

pub const MAX_WORKSPACE_NAME_CHARS: usize = 128;
pub const MAX_WORKSPACE_PATH_BYTES: usize = 4096;
pub const MAX_LINKED_FOLDERS: usize = 32;

/// A requested project edit, as the user typed and picked it.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceEdit {
    pub workspace_id: String,
    pub name: String,
    /// The primary folder.
    pub path: String,
    /// The extra source folders, besides the primary one.
    pub linked_paths: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceEditOutcome {
    pub profile: WorkspaceProfile,
    pub root_changed: bool,
    pub linked_added: usize,
    pub linked_removed: usize,
}

/// A validated edit: every folder is an existing directory in canonical form.
#[derive(Debug, Clone)]
pub struct WorkspaceEditPlan {
    pub name: String,
    pub root: PathBuf,
    pub linked: Vec<PathBuf>,
    pub root_changed: bool,
}

fn message(text: impl Into<String>) -> AppError {
    AppError::Message(text.into())
}

fn valid_workspace_id(id: &str) -> AppResult<()> {
    if id.trim().is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err(message("A valid workspace_id is required"));
    }
    Ok(())
}

/// The path as people write it: without Windows' `\\?\` verbatim prefix.
pub fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(normal) = raw.strip_prefix(r"\\?\") {
            return normal.to_string();
        }
    }
    raw
}

fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        display_path(left).eq_ignore_ascii_case(&display_path(right))
    } else {
        left == right
    }
}

/// An absolute path to an existing directory, in canonical form.
fn canonical_folder(raw: &str, label: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_WORKSPACE_PATH_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err(message(format!("{label} path is invalid")));
    }
    if !Path::new(trimmed).is_absolute() {
        return Err(message(format!("{label} must be an absolute path")));
    }
    let canonical = Path::new(trimmed)
        .canonicalize()
        .map_err(|_| message(format!("{label} must be an existing folder: {trimmed}")))?;
    if !canonical.is_dir() {
        return Err(message(format!("{label} must be a folder: {trimmed}")));
    }
    Ok(canonical)
}

/// Checks an edit against the saved projects without changing anything.
pub fn plan_workspace_edit(data: &AppData, edit: &WorkspaceEdit) -> AppResult<WorkspaceEditPlan> {
    valid_workspace_id(&edit.workspace_id)?;
    let current = data
        .profiles
        .iter()
        .find(|profile| profile.id == edit.workspace_id)
        .ok_or_else(|| message("Workspace was not found"))?;
    let name = edit.name.trim();
    if name.is_empty() {
        return Err(message("Project name is required"));
    }
    if name.chars().count() > MAX_WORKSPACE_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(message(format!(
            "Project name must be at most {MAX_WORKSPACE_NAME_CHARS} characters on one line"
        )));
    }
    let root = canonical_folder(&edit.path, "Project folder")?;
    let taken = data.profiles.iter().any(|profile| {
        profile.id != edit.workspace_id
            && Path::new(&profile.path)
                .canonicalize()
                .is_ok_and(|existing| same_path(&existing, &root))
    });
    if taken {
        return Err(message(
            "Another project already uses this folder as its project folder",
        ));
    }
    if edit.linked_paths.len() > MAX_LINKED_FOLDERS {
        return Err(message(format!(
            "A project can have at most {MAX_LINKED_FOLDERS} extra source folders"
        )));
    }
    let mut linked: Vec<PathBuf> = Vec::with_capacity(edit.linked_paths.len());
    for raw in &edit.linked_paths {
        let folder = canonical_folder(raw, "Source folder")?;
        if same_path(&folder, &root) {
            return Err(message(format!(
                "{} is already the project folder",
                display_path(&folder)
            )));
        }
        if linked.iter().any(|existing| same_path(existing, &folder)) {
            return Err(message(format!(
                "{} is listed more than once",
                display_path(&folder)
            )));
        }
        linked.push(folder);
    }
    let root_changed = !Path::new(&current.path)
        .canonicalize()
        .is_ok_and(|previous| same_path(&previous, &root));
    Ok(WorkspaceEditPlan {
        name: name.to_string(),
        root,
        linked,
        root_changed,
    })
}

/// Why this project's missions make moving or removing it unsafe right now, if they do: a card
/// that is reserved or running, or a delayed start still waiting to fire.
pub fn workspace_ao_activity(data: &AppData, workspace_id: &str) -> Option<String> {
    let running = data.ao_runs.iter().any(|run| {
        run.workspace_id == workspace_id
            && run
                .nodes
                .iter()
                .any(|node| matches!(node.state, NodeState::Reserved | NodeState::Running))
    });
    if running {
        return Some("a mission in this project is still running; stop it first".into());
    }
    let scheduled = data.ao_task_lifecycle.iter().any(|item| {
        item.workspace_id == workspace_id
            && item.schedule.as_ref().is_some_and(|schedule| {
                matches!(
                    schedule.state,
                    ScheduleState::Scheduled | ScheduleState::Claimed
                )
            })
    });
    if scheduled {
        return Some("a mission in this project is scheduled to start; cancel it first".into());
    }
    None
}

/// Makes the root's `.mcp-paths` mappings name exactly `desired` (adds first, then removes).
/// With `prune` false only missing folders are added: after the primary folder changes, the new
/// folder's own existing mappings were never shown to the user, so none of them are removed.
fn sync_linked_folders(root: &Path, desired: &[PathBuf], prune: bool) -> AppResult<(usize, usize)> {
    let current: Vec<_> = list_linked_projects_for_root(root)
        .into_iter()
        .map(|project| {
            let canonical = project.root_path().canonicalize().ok();
            (project, canonical)
        })
        .collect();
    let mut added = 0;
    for folder in desired {
        let present = current.iter().any(|(_, canonical)| {
            canonical
                .as_deref()
                .is_some_and(|path| same_path(path, folder))
        });
        if !present {
            quick_add_linked_project_for_root(root, folder, None)?;
            added += 1;
        }
    }
    let mut removed = 0;
    if prune {
        for (project, canonical) in &current {
            let wanted = canonical
                .as_deref()
                .is_some_and(|path| desired.iter().any(|folder| same_path(path, folder)));
            if !wanted && remove_linked_project_mapping(root, &project.alias)? {
                removed += 1;
            }
        }
    }
    Ok((added, removed))
}

/// Applies a project edit. Moving the primary folder is refused while the project's missions
/// are running or scheduled, since their cards work in the current folder.
pub fn edit_workspace(
    store: &mut DataStore,
    edit: &WorkspaceEdit,
) -> AppResult<WorkspaceEditOutcome> {
    let plan = plan_workspace_edit(store.data(), edit)?;
    if plan.root_changed {
        if let Some(reason) = workspace_ao_activity(store.data(), &edit.workspace_id) {
            return Err(message(format!(
                "Can't change the project folder: {reason}"
            )));
        }
    }
    let (linked_added, linked_removed) =
        sync_linked_folders(&plan.root, &plan.linked, !plan.root_changed)?;
    let mut profile = store
        .get(&edit.workspace_id)
        .cloned()
        .ok_or_else(|| message("Workspace was not found"))?;
    profile.name = plan.name;
    profile.path = display_path(&plan.root);
    store.update(profile.clone())?;
    Ok(WorkspaceEditOutcome {
        profile,
        root_changed: plan.root_changed,
        linked_added,
        linked_removed,
    })
}

/// Removes the project from the app's list. Its folders and files are left untouched, and its
/// saved missions stay in the data file (only views of a listed project show them). Refused while
/// any of its missions are running or scheduled to start.
pub fn remove_local_workspace(
    store: &mut DataStore,
    workspace_id: &str,
) -> AppResult<WorkspaceProfile> {
    valid_workspace_id(workspace_id)?;
    if store.get(workspace_id).is_none() {
        return Err(message("Workspace was not found"));
    }
    if let Some(reason) = workspace_ao_activity(store.data(), workspace_id) {
        return Err(message(format!("Can't remove this project: {reason}")));
    }
    store
        .remove(workspace_id)?
        .ok_or_else(|| message("Workspace was not found"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::linked_projects::LINKED_PROJECTS_DIR;
    use serde_json::json;
    use tempfile::tempdir;

    fn store_with(profiles: &[(&str, &Path)]) -> DataStore {
        let profiles: Vec<_> = profiles
            .iter()
            .map(|(id, path)| {
                json!({"id": id, "name": id, "path": display_path(path), "tunnel": {},
                    "auth": {"type": "bearer"}, "runtime": {}, "actions": {}})
            })
            .collect();
        DataStore::from_data(serde_json::from_value(json!({ "profiles": profiles })).unwrap())
            .unwrap()
    }

    fn edit(id: &str, name: &str, path: &Path, linked: &[&Path]) -> WorkspaceEdit {
        WorkspaceEdit {
            workspace_id: id.into(),
            name: name.into(),
            path: path.to_string_lossy().into_owned(),
            linked_paths: linked
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        }
    }

    fn with_run(store: &DataStore, workspace_id: &str, state: &str) -> DataStore {
        let route = json!({"harness_id":"codex-native","provider_id":"chatgpt-web",
            "account_id":"chatgpt-web","model":"chatgpt-web/pro","permission_profile":":read-only"});
        let mut data = store.data().clone();
        data.ao_runs.push(
            serde_json::from_value(json!({
                "id": "run", "workspace_id": workspace_id, "project_id": "task", "revision": 0,
                "nodes": [{"id":"planner","task_id":"task","role":"planner","parents":[],"x":0,"y":0,
                    "state": state, "route": route}]
            }))
            .unwrap(),
        );
        DataStore::from_data(data).unwrap()
    }

    #[test]
    fn edit_renames_moves_and_links_folders() {
        let old = tempdir().unwrap();
        let new = tempdir().unwrap();
        let extra = tempdir().unwrap();
        let mut store = store_with(&[("ws", old.path())]);
        let outcome = edit_workspace(
            &mut store,
            &edit("ws", "  Renamed  ", new.path(), &[extra.path()]),
        )
        .unwrap();
        assert!(outcome.root_changed);
        assert_eq!(outcome.linked_added, 1);
        let saved = store.get("ws").unwrap();
        assert_eq!(saved.name, "Renamed");
        assert!(same_path(
            &Path::new(&saved.path).canonicalize().unwrap(),
            &new.path().canonicalize().unwrap()
        ));
        assert!(
            !saved.path.starts_with(r"\\?\"),
            "stored without the verbatim prefix"
        );
        let linked = list_linked_projects_for_root(new.path());
        assert_eq!(linked.len(), 1);
        assert!(same_path(
            &Path::new(&linked[0].path).canonicalize().unwrap(),
            &extra.path().canonicalize().unwrap()
        ));
    }

    #[test]
    fn edit_unlinks_a_removed_folder_without_touching_it() {
        let root = tempdir().unwrap();
        let keep = tempdir().unwrap();
        let drop = tempdir().unwrap();
        std::fs::write(drop.path().join("file.txt"), "kept").unwrap();
        let mut store = store_with(&[("ws", root.path())]);
        edit_workspace(
            &mut store,
            &edit("ws", "ws", root.path(), &[keep.path(), drop.path()]),
        )
        .unwrap();
        assert_eq!(list_linked_projects_for_root(root.path()).len(), 2);
        let outcome =
            edit_workspace(&mut store, &edit("ws", "ws", root.path(), &[keep.path()])).unwrap();
        assert!(!outcome.root_changed);
        assert_eq!((outcome.linked_added, outcome.linked_removed), (0, 1));
        assert_eq!(list_linked_projects_for_root(root.path()).len(), 1);
        assert!(drop.path().join("file.txt").exists());
    }

    #[test]
    fn moving_the_project_keeps_the_new_folders_own_mappings() {
        let old = tempdir().unwrap();
        let new = tempdir().unwrap();
        let theirs = tempdir().unwrap();
        quick_add_linked_project_for_root(new.path(), theirs.path(), Some("Theirs")).unwrap();
        let mut store = store_with(&[("ws", old.path())]);
        let outcome = edit_workspace(&mut store, &edit("ws", "ws", new.path(), &[])).unwrap();
        assert_eq!(outcome.linked_removed, 0);
        assert_eq!(list_linked_projects_for_root(new.path()).len(), 1);
        assert!(new
            .path()
            .join(LINKED_PROJECTS_DIR)
            .join("theirs.txt")
            .exists());
    }

    #[test]
    fn edit_validates_names_and_folders() {
        let root = tempdir().unwrap();
        let other = tempdir().unwrap();
        let extra = tempdir().unwrap();
        let store = store_with(&[("ws", root.path()), ("other", other.path())]);
        let data = store.data();
        let rejects = |request: WorkspaceEdit, expected: &str| {
            let error = plan_workspace_edit(data, &request).unwrap_err().to_string();
            assert!(
                error.contains(expected),
                "{error} should mention {expected}"
            );
        };
        rejects(edit("ws", "  ", root.path(), &[]), "name is required");
        rejects(
            edit("ws", &"x".repeat(129), root.path(), &[]),
            "at most 128",
        );
        rejects(edit("ws", "a\nb", root.path(), &[]), "one line");
        rejects(edit("", "ws", root.path(), &[]), "workspace_id");
        rejects(edit("missing", "ws", root.path(), &[]), "not found");
        rejects(
            edit("ws", "ws", Path::new("relative/folder"), &[]),
            "absolute",
        );
        rejects(
            edit("ws", "ws", &root.path().join("does-not-exist"), &[]),
            "existing folder",
        );
        std::fs::write(root.path().join("plain.txt"), "").unwrap();
        rejects(
            edit("ws", "ws", &root.path().join("plain.txt"), &[]),
            "must be a folder",
        );
        rejects(edit("ws", "ws", other.path(), &[]), "Another project");
        rejects(
            edit("ws", "ws", root.path(), &[root.path()]),
            "already the project folder",
        );
        rejects(
            edit("ws", "ws", root.path(), &[extra.path(), extra.path()]),
            "more than once",
        );
        let too_many: Vec<&Path> = (0..=MAX_LINKED_FOLDERS).map(|_| extra.path()).collect();
        rejects(edit("ws", "ws", root.path(), &too_many), "at most 32");
        let mut long = edit("ws", "ws", root.path(), &[]);
        long.path = format!("C:\\{}", "a".repeat(MAX_WORKSPACE_PATH_BYTES));
        rejects(long, "invalid");
        let plan =
            plan_workspace_edit(data, &edit("ws", "ws", root.path(), &[extra.path()])).unwrap();
        assert!(!plan.root_changed);
        assert_eq!(plan.linked.len(), 1);
    }

    #[test]
    fn moving_a_project_with_a_running_mission_is_refused() {
        let old = tempdir().unwrap();
        let new = tempdir().unwrap();
        let mut store = with_run(&store_with(&[("ws", old.path())]), "ws", "running");
        let error = edit_workspace(&mut store, &edit("ws", "ws", new.path(), &[]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("still running"), "{error}");
        // A rename in place is still allowed.
        edit_workspace(&mut store, &edit("ws", "Renamed", old.path(), &[])).unwrap();
        assert_eq!(store.get("ws").unwrap().name, "Renamed");
    }

    #[test]
    fn remove_keeps_files_and_missions_and_refuses_while_running() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("keep.txt"), "kept").unwrap();
        for state in ["running", "reserved"] {
            let mut store = with_run(&store_with(&[("ws", root.path())]), "ws", state);
            let error = remove_local_workspace(&mut store, "ws")
                .unwrap_err()
                .to_string();
            assert!(error.contains("still running"), "{error}");
            assert!(store.get("ws").is_some());
        }
        let mut store = with_run(&store_with(&[("ws", root.path())]), "ws", "finished");
        let removed = remove_local_workspace(&mut store, "ws").unwrap();
        assert_eq!(removed.id, "ws");
        assert!(store.get("ws").is_none());
        assert_eq!(store.data().ao_runs.len(), 1, "saved missions are kept");
        assert!(
            root.path().join("keep.txt").exists(),
            "no project file is deleted"
        );
        assert!(remove_local_workspace(&mut store, "ws").is_err());
    }

    #[test]
    fn remove_is_refused_while_a_start_is_scheduled() {
        let root = tempdir().unwrap();
        let store = store_with(&[("ws", root.path())]);
        let mut data = store.data().clone();
        data.ao_task_lifecycle.push(
            serde_json::from_value(json!({
                "workspace_id": "ws", "task_id": "task", "revision": 0, "visibility": "active",
                "reconfigure": [], "schedule": {"id": "job", "run_id": "run", "due_at_ms": 1,
                    "revision": 0, "team_id": "team", "team_revision": 0, "state": "scheduled"}
            }))
            .unwrap(),
        );
        let mut store = DataStore::from_data(data).unwrap();
        let error = remove_local_workspace(&mut store, "ws")
            .unwrap_err()
            .to_string();
        assert!(error.contains("scheduled"), "{error}");
        assert!(store.get("ws").is_some());
    }
}
