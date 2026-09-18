use coding_tools_core::{data::AppData, tools::registry, CoreState};

#[test]
fn extracted_core_preserves_catalog_and_in_memory_state() {
    let advanced = registry::list_tools_for_profile("advanced");
    assert_eq!(advanced.len(), 71, "advanced tool ABI changed during extraction");

    let mut names = advanced
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name").to_owned())
        .collect::<Vec<_>>();
    let original_len = names.len();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), original_len, "tool names must remain unique");

    let state = CoreState::from_data(AppData::default()).expect("in-memory core state");
    let workspaces = state
        .with_data(|store| Ok(store.list().len()))
        .expect("read in-memory data");
    assert_eq!(workspaces, 0);

    state
        .with_runtime(|_| Ok(()))
        .expect("runtime supervisor is available through the reusable core");
}
