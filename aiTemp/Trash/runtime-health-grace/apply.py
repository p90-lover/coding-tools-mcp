from pathlib import Path
import re

path = Path("src-tauri/src/runtime/supervisor.rs")
text = path.read_text()

field_old = "    missing_port_checks: u8,\n"
field_new = "    missing_port_checks: u8,\n    missing_port_since: Option<std::time::Instant>,\n"
assert text.count(field_old) == 1, "RuntimeEntry health fields changed"
text = text.replace(field_old, field_new, 1)

pattern = re.compile(r"(?m)^(?P<indent>[ \t]*)missing_port_checks: 0,$")
text, constructor_count = pattern.subn(
    lambda match: (
        f"{match.group('indent')}missing_port_checks: 0,\n"
        f"{match.group('indent')}missing_port_since: None,"
    ),
    text,
)
assert constructor_count == 4, f"expected four RuntimeEntry constructors, found {constructor_count}"

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
const RUNTIME_STARTUP_FLOOR: Duration = Duration::from_millis(200);

fn missing_port_is_stale(
    missing_port_checks: u8,
    missing_for: Duration,
    service_age: Duration,
) -> bool {
    missing_port_checks >= MISSING_PORT_CHECK_LIMIT
        && missing_for >= MISSING_PORT_GRACE
        && service_age >= RUNTIME_STARTUP_FLOOR
}

fn should_mark_runtime_error(entry: &mut RuntimeEntry, listening: bool) -> bool {
    if entry.phase != RuntimePhase::Running {
        return false;
    }
    if listening {
        entry.missing_port_checks = 0;
        entry.missing_port_since = None;
        return false;
    }

    entry.missing_port_checks = entry.missing_port_checks.saturating_add(1);
    let now = std::time::Instant::now();
    let missing_since = entry
        .missing_port_since
        .get_or_insert(now)
        .to_owned();
    let missing_for = now.saturating_duration_since(missing_since);
    let service_age = entry
        .started_at
        .map(|started| now.saturating_duration_since(started))
        .unwrap_or(MISSING_PORT_GRACE);

    // Windows port-table enumeration can transiently miss under heavy desktop
    // load. A mature listener therefore needs both repeated misses and a full
    // grace period beginning with the first consecutive miss before teardown.
    missing_port_is_stale(entry.missing_port_checks, missing_for, service_age)
}
"""
assert old in text, "health helper changed"
text = text.replace(old, new, 1)

old_tests = """    #[test]
    fn refresh_does_not_cleanup_a_running_runtime_that_is_listening() {
        let mut runtime = entry(RuntimePhase::Running, Some(std::time::Instant::now()));
        assert!(!should_mark_runtime_error(&mut runtime, true));
    }

    #[test]
    fn refresh_does_not_cleanup_a_starting_runtime() {
        let mut runtime = entry(RuntimePhase::Starting, None);
        assert!(!should_mark_runtime_error(&mut runtime, false));
    }

    #[test]
    fn refresh_cleans_up_only_after_running_runtime_is_confirmed_missing() {
        let mut runtime = entry(
            RuntimePhase::Running,
            Some(std::time::Instant::now() - Duration::from_secs(1)),
        );
        assert!(!should_mark_runtime_error(&mut runtime, false));
        assert!(!should_mark_runtime_error(&mut runtime, false));
        assert!(should_mark_runtime_error(&mut runtime, false));
    }

    #[test]
    fn a_recovered_port_clears_missing_port_checks() {
        let mut runtime = entry(
            RuntimePhase::Running,
            Some(std::time::Instant::now() - Duration::from_secs(1)),
        );
        assert!(!should_mark_runtime_error(&mut runtime, false));
        assert!(!should_mark_runtime_error(&mut runtime, true));
        assert!(!should_mark_runtime_error(&mut runtime, false));
    }
"""
new_tests = """    #[test]
    fn refresh_does_not_cleanup_a_running_runtime_that_is_listening() {
        let mut runtime = entry(RuntimePhase::Running, Some(std::time::Instant::now()));
        runtime.missing_port_checks = MISSING_PORT_CHECK_LIMIT;
        runtime.missing_port_since = Some(
            std::time::Instant::now() - MISSING_PORT_GRACE - Duration::from_secs(1),
        );
        assert!(!should_mark_runtime_error(&mut runtime, true));
        assert_eq!(runtime.missing_port_checks, 0);
        assert!(runtime.missing_port_since.is_none());
    }

    #[test]
    fn refresh_does_not_cleanup_a_starting_runtime() {
        let mut runtime = entry(RuntimePhase::Starting, None);
        assert!(!should_mark_runtime_error(&mut runtime, false));
        assert_eq!(runtime.missing_port_checks, 0);
        assert!(runtime.missing_port_since.is_none());
    }

    #[test]
    fn missing_port_policy_requires_count_and_full_grace() {
        let old_enough = MISSING_PORT_GRACE + Duration::from_secs(1);
        let mature = RUNTIME_STARTUP_FLOOR + Duration::from_secs(1);
        assert!(!missing_port_is_stale(
            MISSING_PORT_CHECK_LIMIT - 1,
            old_enough,
            mature
        ));
        assert!(!missing_port_is_stale(
            MISSING_PORT_CHECK_LIMIT,
            MISSING_PORT_GRACE - Duration::from_millis(1),
            mature
        ));
        assert!(missing_port_is_stale(
            MISSING_PORT_CHECK_LIMIT,
            MISSING_PORT_GRACE,
            mature
        ));
    }

    #[test]
    fn first_missing_port_observation_starts_the_grace_window() {
        let mut runtime = entry(
            RuntimePhase::Running,
            Some(std::time::Instant::now() - Duration::from_secs(60)),
        );
        assert!(!should_mark_runtime_error(&mut runtime, false));
        assert_eq!(runtime.missing_port_checks, 1);
        assert!(runtime.missing_port_since.is_some());
    }

    #[test]
    fn a_recovered_port_clears_missing_port_state() {
        let mut runtime = entry(
            RuntimePhase::Running,
            Some(std::time::Instant::now() - Duration::from_secs(60)),
        );
        assert!(!should_mark_runtime_error(&mut runtime, false));
        assert!(runtime.missing_port_since.is_some());
        assert!(!should_mark_runtime_error(&mut runtime, true));
        assert_eq!(runtime.missing_port_checks, 0);
        assert!(runtime.missing_port_since.is_none());
        assert!(!should_mark_runtime_error(&mut runtime, false));
        assert_eq!(runtime.missing_port_checks, 1);
        assert!(runtime.missing_port_since.is_some());
    }
"""
assert old_tests in text, "supervisor health tests changed"
text = text.replace(old_tests, new_tests, 1)

path.write_text(text)
