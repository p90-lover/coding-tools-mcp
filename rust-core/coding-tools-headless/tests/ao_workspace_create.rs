use coding_tools_core::data::{AppData, DataStore};

#[test]
fn ao_workspace_creation_is_canonical_and_has_no_partial_duplicate() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("aiTemp/ao-workspace-create-test");
    std::fs::create_dir_all(&root).unwrap();
    let mut store = DataStore::from_data(AppData::default()).unwrap();
    let profile = store
        .create_workspace(root.to_string_lossy().into_owned(), Some("AO QA".into()))
        .unwrap();
    assert_eq!(profile.path, root.canonicalize().unwrap().to_string_lossy());
    assert_eq!(store.list().len(), 1);
    assert!(store
        .get_workspace_secret(&profile.id, "bearer_token")
        .unwrap()
        .is_some());
    let before = serde_json::to_value(store.data()).unwrap();
    assert!(store
        .create_workspace(
            root.join(".").to_string_lossy().into_owned(),
            Some("Duplicate".into())
        )
        .is_err());
    assert!(store
        .create_workspace(root.join("missing").to_string_lossy().into_owned(), None)
        .is_err());
    assert_eq!(serde_json::to_value(store.data()).unwrap(), before);
}

#[test]
fn ao_workspace_creation_preserves_the_filesystem_root() {
    let current = std::env::current_dir().unwrap().canonicalize().unwrap();
    // Native ancestors yield `/` on Unix and the volume root on Windows.
    let root = current.ancestors().last().unwrap();
    let mut store = DataStore::from_data(AppData::default()).unwrap();
    let profile = store
        .create_workspace(root.to_string_lossy().into_owned(), None)
        .unwrap();
    let saved = std::path::Path::new(&profile.path);
    assert!(saved.is_absolute(), "saved root was {:?}", profile.path);
    assert_eq!(saved.canonicalize().unwrap(), root);
    assert!(!profile.name.trim().is_empty());
    let before = serde_json::to_value(store.data()).unwrap();
    assert!(store
        .create_workspace(root.to_string_lossy().into_owned(), None)
        .is_err());
    assert_eq!(serde_json::to_value(store.data()).unwrap(), before);
}
