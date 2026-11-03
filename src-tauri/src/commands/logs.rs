use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::error::{AppError, AppResult};
use crate::tunnel::log_dir_for_profile;
use crate::workspace::WorkspaceProfile;

const MAX_LOG_BYTES: usize = 8192;
const MAX_LOG_CHARS: usize = 4000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub name: String,
    pub content: String,
}

fn profile_by_id(state: &AppState, id: &str) -> AppResult<WorkspaceProfile> {
    state.with_workspaces(|store| {
        store
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Message(format!("workspace not found: {id}")))
    })
}

fn log_file_names(profile: &WorkspaceProfile, service: &str) -> AppResult<Vec<&'static str>> {
    match service {
        "mcp" => {
            let mut names = vec!["stderr.log", "stdout.log"];
            if profile.tunnel.tunnel_type == "cloudflare" {
                names.insert(0, "cloudflared.log");
            }
            if profile.tunnel.tunnel_type == "frp" {
                names.insert(0, "frpc-mcp.log");
            }
            Ok(names)
        }
        "actions" => {
            let mut names = vec!["actions-stderr.log", "actions-stdout.log"];
            if profile.actions.tunnel_type == "cloudflare" {
                names.insert(0, "actions-cloudflared.log");
            }
            if profile.actions.tunnel_type == "frp" {
                names.insert(0, "frpc-actions.log");
            }
            Ok(names)
        }
        other => Err(AppError::Message(format!("unknown log service: {other}"))),
    }
}

fn read_log_tail(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let size = file.seek(SeekFrom::End(0))?;
    let start = size.saturating_sub(MAX_LOG_BYTES as u64);
    let read_start = start.saturating_sub(3);
    file.seek(SeekFrom::Start(read_start))?;
    let mut buf = Vec::new();
    file.take(size - read_start).read_to_end(&mut buf)?;
    let mut offset = ((start - read_start) as usize).min(buf.len());
    // Skip only the suffix of a valid scalar crossing the cutoff; retain actual invalid bytes.
    for previous in 0..offset {
        let width = match buf[previous] {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => continue,
        };
        let end = previous + width;
        if end > offset
            && buf
                .get(previous..end)
                .is_some_and(|bytes| std::str::from_utf8(bytes).is_ok())
        {
            offset = end;
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf[offset..]).into_owned();
    Ok(if text.chars().count() > MAX_LOG_CHARS {
        text.chars()
            .rev()
            .take(MAX_LOG_CHARS)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    } else {
        text
    })
}

#[tauri::command]
pub async fn read_workspace_logs(
    state: State<'_, AppState>,
    id: String,
    service: String,
) -> AppResult<Vec<LogChunk>> {
    let profile = profile_by_id(&state, &id)?;
    let log_dir = log_dir_for_profile(&profile.id);
    let names = log_file_names(&profile, &service)?;

    let mut chunks = Vec::new();
    for name in names {
        let path = log_dir.join(name);
        if !path.exists() {
            continue;
        }
        let content = read_log_tail(&path)?;
        chunks.push(LogChunk {
            name: name.to_string(),
            content,
        });
    }

    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tail_of(bytes: &[u8]) -> String {
        let root = std::env::current_dir()
            .unwrap()
            .join("aiTemp/log-tail-tests");
        std::fs::create_dir_all(&root).unwrap();
        let fixture = tempfile::tempdir_in(root).unwrap();
        let path = fixture.path().join("owned.log");
        std::fs::write(&path, bytes).unwrap();
        read_log_tail(&path).unwrap()
    }

    #[test]
    fn log_tail_aligns_cjk_boundary() {
        assert!(
            tail_of("中".repeat(3000).as_bytes()) == "中".repeat(2730),
            "CJK tail boundary corrupted"
        );
    }

    #[test]
    fn log_tail_aligns_four_byte_boundary() {
        let input = format!("{}x", "😀".repeat(2100));
        assert!(
            tail_of(input.as_bytes()) == format!("{}x", "😀".repeat(2047)),
            "four-byte tail boundary corrupted"
        );
    }

    #[test]
    fn log_tail_preserves_limits_and_actual_invalid_bytes() {
        assert_eq!(tail_of(&[b'a'; 9000]), "a".repeat(MAX_LOG_CHARS));
        assert_eq!(tail_of("短日志".as_bytes()), "短日志");
        assert_eq!(tail_of(b""), "");
        assert_eq!(tail_of(&[0x80, 0xbf, b'X', 0xf0, 0x9f]), "��X�");
        // These invalid continuation bytes land exactly at a nonzero tail cutoff.
        for prefix in [
            vec![b'a'; 1000],
            [vec![b'a'; 998], vec![0xe0, 0x80]].concat(),
        ] {
            let mut input = prefix;
            input.push(0x80);
            input.extend_from_slice("中".repeat(2730).as_bytes());
            input.push(b'Z');
            assert!(
                tail_of(&input) == format!("�{}Z", "中".repeat(2730)),
                "invalid bytes at the cutoff must stay visible"
            );
        }
    }
}
