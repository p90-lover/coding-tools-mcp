//! Restore only a previously saved local grant; never infer consent from an MCP request.
use crate::app_state::AppState;
use crate::data::DataStore;
use crate::tools::computer::{self, permissions};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Retry frequency is bounded; remembered permission itself does not time out.
#[derive(Default)]
struct RestoreRetry {
    misses: u8,
}
impl RestoreRetry {
    fn delay(&mut self) -> Duration {
        let seconds = if self.misses < 12 { 5 } else { 30 };
        self.misses = self.misses.saturating_add(1);
        Duration::from_secs(seconds)
    }
}

pub fn start(app: AppHandle) {
    if !cfg!(target_os = "windows") {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Wait for initial visible local UI; this is not an input or screenshot loop.
        tokio::time::sleep(Duration::from_secs(2)).await;
        if computer::has_local_session() {
            return;
        }
        let grant = DataStore::read_file(|data| {
            let eligible: Vec<_> = data
                .computer_permissions
                .iter()
                .filter(|g| {
                    g.restore_on_start
                        && !g.suspended
                        && data.profiles.iter().any(|p| {
                            p.id == g.workspace_id
                                && g.can_restore(&g.root, &permissions::configuration(p))
                        })
                })
                .cloned()
                .collect();
            Ok(if eligible.len() == 1 {
                eligible.into_iter().next()
            } else {
                None
            })
        })
        .ok()
        .flatten();
        let Some(grant) = grant else {
            return;
        };
        permissions::set_active(&grant.workspace_id);
        let epoch = permissions::epoch();
        if permissions::restore_blocked() {
            return;
        }
        let mut retry = RestoreRetry::default();
        loop {
            if computer::has_local_session()
                || permissions::restore_blocked()
                || permissions::epoch() != epoch
            {
                return;
            }
            let current = permissions::get(&grant.workspace_id).ok().flatten();
            if current.as_ref() != Some(&grant) {
                return;
            }
            let state = app.state::<AppState>();
            let root = super::computer::approved_root(&state, &grant.workspace_id);
            if root.as_ref().ok() != Some(&grant.root) {
                return;
            }
            let copy = grant.clone();
            let target =
                tauri::async_runtime::spawn_blocking(move || permissions::restore_target(&copy))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .flatten();
            let Some(target) = target else {
                tokio::time::sleep(retry.delay()).await;
                continue;
            };
            if computer::has_local_session()
                || permissions::restore_blocked()
                || permissions::epoch() != epoch
            {
                return;
            }
            if super::runtime::restore_mcp_service(
                &state,
                &grant.workspace_id,
                &grant.configuration,
                epoch,
            )
            .await
            .is_err()
            {
                return;
            }
            if computer::has_local_session()
                || permissions::restore_blocked()
                || permissions::epoch() != epoch
            {
                return;
            }
            if permissions::get(&grant.workspace_id)
                .ok()
                .flatten()
                .as_ref()
                != Some(&grant)
            {
                return;
            }
            let verify_grant = grant.clone();
            let expected_target = target.clone();
            let still_matches = tauri::async_runtime::spawn_blocking(move || {
                permissions::restore_target(&verify_grant)
                    .map(|t| t.as_ref() == Some(&expected_target))
            })
            .await
            .ok()
            .and_then(Result::ok)
                == Some(true);
            if !still_matches || permissions::epoch() != epoch {
                return;
            }
            // Restore the real monitor, not the foreground target. No input until heartbeat arrives.
            if super::computer::open_monitor(&app).is_err() {
                if permissions::epoch() == epoch {
                    computer::emergency_stop("Could not restore control monitor");
                }
                return;
            }
            let expected = epoch;
            let root = grant.root.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                computer::restore_arm(root, target, expected)
            })
            .await;
            if permissions::epoch() == epoch
                && (result.is_err() || result.as_ref().is_ok_and(|r| r.is_err()))
            {
                computer::emergency_stop("Remembered restore did not obtain a valid local target");
            }
            return;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computer_restore_retry_has_no_expiry_or_counter_overflow() {
        let mut retry = RestoreRetry::default();
        for _ in 0..12 {
            assert_eq!(retry.delay(), Duration::from_secs(5));
        }
        // Well beyond the former one-hour cutoff and the counter's capacity.
        for _ in 0..10_000 {
            assert_eq!(retry.delay(), Duration::from_secs(30));
        }
        assert_eq!(retry.misses, u8::MAX);
    }
}
