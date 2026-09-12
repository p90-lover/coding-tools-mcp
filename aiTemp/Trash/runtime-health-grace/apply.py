from pathlib import Path

path = Path("src-tauri/src/runtime/supervisor.rs")
text = path.read_text()

old = """                if should_mark_runtime_error(entry, listening) {
                    if let Some(handle) = entry.handle.take() {
"""
new = """                let listener_finished = entry
                    .handle
                    .as_ref()
                    .is_some_and(|handle| handle.is_finished());
                if should_mark_runtime_error(entry, listening, listener_finished) {
                    if let Some(handle) = entry.handle.take() {
"""
assert old in text, "refresh health call site changed"
text = text.replace(old, new, 1)

old = """fn should_mark_runtime_error(entry: &mut RuntimeEntry, listening: bool) -> bool {
    if entry.phase != RuntimePhase::Running {
        return false;
    }
    if listening {
        entry.missing_port_checks = 0;
        return false;
    }

    entry.missing_port_checks = entry.missing_port_checks.saturating_add(1);
    entry.missing_port_checks >= 3
        && entry
            .started_at
            .map(|started| started.elapsed() > Duration::from_millis(200))
            .unwrap_or(true)
}
"""
new = """const MISSING_PORT_CHECK_LIMIT: u8 = 6;
const MISSING_PORT_GRACE: Duration = Duration::from_secs(15);
const FINISHED_LISTENER_STARTUP_FLOOR: Duration = Duration::from_millis(200);

fn missing_port_is_stale(
    missing_port_checks: u8,
    age: Option<Duration>,
    listener_finished: bool,
) -> bool {
    if listener_finished {
        return age
            .map(|elapsed| elapsed > FINISHED_LISTENER_STARTUP_FLOOR)
            .unwrap_or(true);
    }

    missing_port_checks >= MISSING_PORT_CHECK_LIMIT
        && age
            .map(|elapsed| elapsed >= MISSING_PORT_GRACE)
            .unwrap_or(true)
}

fn should_mark_runtime_error(
    entry: &mut RuntimeEntry,
    listening: bool,
    listener_finished: bool,
) -> bool {
    if entry.phase != RuntimePhase::Running {
        return false;
    }
    if listening {
        entry.missing_port_checks = 0;
        return false;
    }

    entry.missing_port_checks = entry.missing_port_checks.saturating_add(1);
    let age = entry.started_at.map(|started| started.elapsed());

    // A completed listener task plus a missing socket is authoritative failure.
    // A still-live task receives a wider grace window because Windows port-table
    // enumeration can transiently miss under heavy desktop load.
    missing_port_is_stale(entry.missing_port_checks, age, listener_finished)
}
"""
assert old in text, "health helper changed"
text = text.replace(old, new, 1)

text = text.replace(
    "assert!(!should_mark_runtime_error(&mut runtime, true));",
    "assert!(!should_mark_runtime_error(&mut runtime, true, false));",
)
text = text.replace(
    "assert!(!should_mark_runtime_error(&mut runtime, false));",
    "assert!(!should_mark_runtime_error(&mut runtime, false, false));",
)
text = text.replace(
    "assert!(should_mark_runtime_error(&mut runtime, false));",
    "assert!(should_mark_runtime_error(&mut runtime, false, false));",
)

old_test = """    #[test]
    fn refresh_cleans_up_only_after_running_runtime_is_confirmed_missing() {
        let mut runtime = entry(
            RuntimePhase::Running,
            Some(std::time::Instant::now() - Duration::from_secs(1)),
        );
        assert!(!should_mark_runtime_error(&mut runtime, false, false));
        assert!(!should_mark_runtime_error(&mut runtime, false, false));
        assert!(should_mark_runtime_error(&mut runtime, false, false));
    }
"""
new_test = """    #[test]
    fn live_listener_missing_port_requires_both_count_and_grace() {
        let old_enough = Some(MISSING_PORT_GRACE + Duration::from_secs(1));
        assert!(!missing_port_is_stale(
            MISSING_PORT_CHECK_LIMIT - 1,
            old_enough,
            false
        ));
        assert!(!missing_port_is_stale(
            MISSING_PORT_CHECK_LIMIT,
            Some(MISSING_PORT_GRACE - Duration::from_millis(1)),
            false
        ));
        assert!(missing_port_is_stale(
            MISSING_PORT_CHECK_LIMIT,
            Some(MISSING_PORT_GRACE),
            false
        ));
    }

    #[test]
    fn finished_listener_missing_port_uses_short_startup_floor() {
        assert!(!missing_port_is_stale(
            1,
            Some(FINISHED_LISTENER_STARTUP_FLOOR),
            true
        ));
        assert!(missing_port_is_stale(
            1,
            Some(FINISHED_LISTENER_STARTUP_FLOOR + Duration::from_millis(1)),
            true
        ));
    }
"""
assert old_test in text, "existing missing-port regression test changed"
text = text.replace(old_test, new_test, 1)

path.write_text(text)
