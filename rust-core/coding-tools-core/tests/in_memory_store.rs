use coding_tools_core::{data::AppData, CoreState};

#[test]
fn isolated_core_state_never_falls_through_to_the_user_data_file() {
    let state = CoreState::from_data(AppData::default()).expect("isolated core state");

    state
        .with_data(|store| {
            assert!(!store.is_persistent());
            store.set_shared_secret("fixture-secret", "memory-only")?;
            Ok(())
        })
        .expect("mutate isolated state");

    state
        .with_data(|store| {
            assert!(!store.is_persistent());
            assert_eq!(
                store.get_shared_secret("fixture-secret").as_deref(),
                Some("memory-only")
            );
            Ok(())
        })
        .expect("read isolated state after refresh boundary");
}
