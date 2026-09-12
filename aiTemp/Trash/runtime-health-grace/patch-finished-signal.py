from pathlib import Path

path = Path('src-tauri/src/runtime/supervisor.rs')
text = path.read_text()

old = '''        if let Some(entry) = self.entries.get_mut(&key) {
            if entry.phase == RuntimePhase::Running {
                let listening = match platform().find_pid_listening_on_port(port) {
                    Ok(pid) => pid.is_some(),
                    Err(error) => {
                        append_profile_log(
                            &profile.id,
                            stderr_log_name(kind),
                            &format!("[refresh] 检查端口 {port} 失败，保留当前线路：{error}"),
                        );
                        return;
                    }
                };
                if should_mark_runtime_error(entry, listening) {
'''
new = '''        if let Some(entry) = self.entries.get_mut(&key) {
            if entry.phase == RuntimePhase::Running {
                // A dropped shutdown receiver is authoritative: the listener task has
                // already exited. Only a still-live listener is eligible for the
                // transient port-table grace window below.
                let listener_finished = listener_task_finished(entry);
                let listening = if listener_finished {
                    false
                } else {
                    match platform().find_pid_listening_on_port(port) {
                        Ok(pid) => pid.is_some(),
                        Err(error) => {
                            append_profile_log(
                                &profile.id,
                                stderr_log_name(kind),
                                &format!("[refresh] 检查端口 {port} 失败，保留当前线路：{error}"),
                            );
                            return;
                        }
                    }
                };
                if listener_finished || should_mark_runtime_error(entry, listening) {
'''
assert old in text, 'refresh listener-health block changed'
text = text.replace(old, new, 1)

anchor = '''const MISSING_PORT_CHECK_LIMIT: u8 = 6;
'''
helper = '''fn listener_task_finished(entry: &RuntimeEntry) -> bool {
    entry
        .shutdown
        .as_ref()
        .is_some_and(|shutdown| shutdown.is_closed())
}

'''
assert anchor in text, 'listener health constants anchor changed'
text = text.replace(anchor, helper + anchor, 1)

anchor = '''    #[test]
    fn refresh_does_not_cleanup_a_running_runtime_that_is_listening() {
'''
test = '''    #[test]
    fn closed_shutdown_receiver_is_authoritative_listener_completion() {
        let (shutdown, receiver) = tokio::sync::oneshot::channel::<()>();
        let mut runtime = entry(
            RuntimePhase::Running,
            Some(std::time::Instant::now() - Duration::from_secs(60)),
        );
        runtime.shutdown = Some(shutdown);
        assert!(!listener_task_finished(&runtime));
        drop(receiver);
        assert!(listener_task_finished(&runtime));
        assert_eq!(runtime.missing_port_checks, 0);
        assert!(runtime.missing_port_since.is_none());
    }

'''
assert anchor in text, 'supervisor tests anchor changed'
text = text.replace(anchor, test + anchor, 1)

path.write_text(text)
