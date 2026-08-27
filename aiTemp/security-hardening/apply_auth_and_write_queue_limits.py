from __future__ import annotations

import shutil
import time
from pathlib import Path

ROOT = Path.cwd().resolve()
BACKUP_ROOT = (
    ROOT
    / "aiTemp"
    / "Trash"
    / "security-hardening"
    / "auth-and-write-queue-limits"
    / str(time.time_ns())
)


def checked_file(path: str) -> Path:
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe source path: {path}")
    candidate = ROOT / relative
    if candidate.is_symlink():
        raise RuntimeError(f"refusing to modify a symlink: {path}")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(ROOT)
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError(f"source path is missing or escapes the repository: {path}") from error
    if not resolved.is_file():
        raise RuntimeError(f"source path is not a regular file: {path}")
    return resolved


def write_existing(path: str, text: str, label: str) -> None:
    target = checked_file(path)
    current = target.read_text(encoding="utf-8")
    if current == text:
        print(f"unchanged: {label}")
        return
    backup = BACKUP_ROOT / Path(path)
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, backup)
    target.write_text(text, encoding="utf-8")
    print(f"applied: {label}")


def replace_once(text: str, before: str, after: str, label: str) -> str:
    if after in text:
        print(f"already applied: {label}")
        return text
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    print(f"prepared: {label}")
    return text.replace(before, after, 1)


def insert_before_once(text: str, marker: str, insertion: str, sentinel: str, label: str) -> str:
    if sentinel in text:
        print(f"already applied: {label}")
        return text
    count = text.count(marker)
    if count != 1:
        raise RuntimeError(f"{label}: expected one insertion marker, found {count}")
    print(f"prepared: {label}")
    return text.replace(marker, insertion + marker, 1)


def append_once(text: str, addition: str, sentinel: str, label: str) -> str:
    if sentinel in text:
        print(f"already applied: {label}")
        return text
    print(f"prepared: {label}")
    return text.rstrip() + "\n\n" + addition.strip() + "\n"


CONSTANTS_BEFORE = '''const MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS: usize = 16;
const REQUEST_QUEUE_WAIT_SECONDS: u64 = 2;
'''
CONSTANTS_AFTER = '''const MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS: usize = 16;
const MAX_IN_FLIGHT_AUTH_REQUESTS: usize = 8;
const REQUEST_QUEUE_WAIT_SECONDS: u64 = 2;
const AUTH_FAILURE_DELAY_MILLIS: u64 = 250;
const TOKEN_FAILURE_DELAY_MILLIS: u64 = 100;
'''

AUTH_TESTS = r'''
#[cfg(test)]
mod oauth_capacity_hardening_tests {
    use super::*;

    #[tokio::test]
    async fn oauth_slots_enforce_a_separate_bounded_limit() {
        let slots = Arc::new(Semaphore::new(MAX_IN_FLIGHT_AUTH_REQUESTS));
        let mut permits = Vec::with_capacity(MAX_IN_FLIGHT_AUTH_REQUESTS);
        for _ in 0..MAX_IN_FLIGHT_AUTH_REQUESTS {
            permits.push(slots.clone().acquire_owned().await.expect("permit"));
        }
        let queued = tokio::time::timeout(
            std::time::Duration::from_millis(25),
            slots.clone().acquire_owned(),
        )
        .await;
        assert!(queued.is_err(), "OAuth concurrency must remain bounded");
        drop(permits.pop());
        let permit = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            slots.acquire_owned(),
        )
        .await
        .expect("released OAuth capacity should become available")
        .expect("OAuth semaphore remains open");
        drop(permit);
    }

    #[test]
    fn oauth_failure_delays_and_capacity_are_bounded() {
        let auth_slots = std::hint::black_box(MAX_IN_FLIGHT_AUTH_REQUESTS);
        let auth_delay = std::hint::black_box(AUTH_FAILURE_DELAY_MILLIS);
        let token_delay = std::hint::black_box(TOKEN_FAILURE_DELAY_MILLIS);
        assert!((1..=16).contains(&auth_slots));
        assert!((100..=1_000).contains(&auth_delay));
        assert!((50..=500).contains(&token_delay));
    }
}
'''


def patch_mcp() -> None:
    path = "src-tauri/src/mcp/listener.rs"
    text = checked_file(path).read_text(encoding="utf-8")
    text = replace_once(text, CONSTANTS_BEFORE, CONSTANTS_AFTER, "define MCP OAuth overload limits")
    text = replace_once(
        text,
        '''    request_slots: Arc<Semaphore>,
}''',
        '''    request_slots: Arc<Semaphore>,
    auth_slots: Arc<Semaphore>,
}''',
        "store independent MCP OAuth slots",
    )
    text = replace_once(
        text,
        '''        request_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),
    };''',
        '''        request_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),
        auth_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_AUTH_REQUESTS)),
    };''',
        "initialize independent MCP OAuth slots",
    )

    helper = r'''async fn acquire_oauth_slot(
    state: &ListenerState,
) -> Result<tokio::sync::OwnedSemaphorePermit, Response> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(REQUEST_QUEUE_WAIT_SECONDS),
        state.auth_slots.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => Ok(permit),
        _ => Err((
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": "server_busy",
                "detail": "OAuth request capacity is temporarily exhausted"
            })),
        )
            .into_response()),
    }
}

'''
    text = insert_before_once(
        text,
        "async fn oauth_authorization_server_metadata(",
        helper,
        "async fn acquire_oauth_slot(",
        "add bounded MCP OAuth admission",
    )

    for function_marker, next_marker in (
        ("async fn oauth_authorize_get(", "async fn oauth_authorize_post("),
        ("async fn oauth_authorize_post(", "async fn oauth_token_post("),
        ("async fn oauth_token_post(", "fn oauth_not_configured("),
    ):
        start = text.find(function_marker)
        end = text.find(next_marker, start)
        if start < 0 or end < 0:
            raise RuntimeError(f"MCP OAuth handler boundary changed: {function_marker}")
        block = text[start:end]
        if "acquire_oauth_slot(&state).await" not in block:
            brace = block.find("{\n")
            if brace < 0:
                raise RuntimeError(f"MCP OAuth handler body changed: {function_marker}")
            admission = '''{
    let _auth_permit = match acquire_oauth_slot(&state).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
'''
            block = block[:brace] + admission + block[brace + 2 :]
            text = text[:start] + block + text[end:]

    text = replace_once(
        text,
        '''    authorize_post(oauth, form, &resolve_oauth_base(&state, &headers))
}

async fn oauth_token_post(''',
        '''    let response = authorize_post(oauth, form, &resolve_oauth_base(&state, &headers));
    if response.status() == StatusCode::UNAUTHORIZED {
        tokio::time::sleep(std::time::Duration::from_millis(
            AUTH_FAILURE_DELAY_MILLIS,
        ))
        .await;
    }
    response
}

async fn oauth_token_post(''',
        "delay failed MCP OAuth passwords while holding bounded capacity",
    )
    text = replace_once(
        text,
        '''    token_exchange(oauth, &headers, form, &resolve_oauth_base(&state, &headers))
}

fn oauth_not_configured(''',
        '''    let response = token_exchange(oauth, &headers, form, &resolve_oauth_base(&state, &headers));
    if response.status() != StatusCode::OK {
        tokio::time::sleep(std::time::Duration::from_millis(
            TOKEN_FAILURE_DELAY_MILLIS,
        ))
        .await;
    }
    response
}

fn oauth_not_configured(''',
        "delay failed MCP token exchanges while holding bounded capacity",
    )
    text = append_once(
        text,
        AUTH_TESTS,
        "mod oauth_capacity_hardening_tests",
        "test independent MCP OAuth capacity",
    )
    write_existing(path, text, "bound MCP OAuth concurrency and failures")


def patch_actions() -> None:
    path = "src-tauri/src/actions/listener.rs"
    text = checked_file(path).read_text(encoding="utf-8")
    text = replace_once(text, CONSTANTS_BEFORE, CONSTANTS_AFTER, "define Actions OAuth overload limits")
    text = replace_once(
        text,
        '''    request_slots: Arc<Semaphore>,
}''',
        '''    request_slots: Arc<Semaphore>,
    auth_slots: Arc<Semaphore>,
}''',
        "store independent Actions OAuth slots",
    )
    text = replace_once(
        text,
        '''        request_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),
    };''',
        '''        request_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),
        auth_slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT_AUTH_REQUESTS)),
    };''',
        "initialize independent Actions OAuth slots",
    )

    helper = r'''async fn acquire_oauth_slot(
    state: &AppState,
) -> Result<tokio::sync::OwnedSemaphorePermit, Response> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(REQUEST_QUEUE_WAIT_SECONDS),
        state.auth_slots.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => Ok(permit),
        _ => Err((
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "detail": "OAuth request capacity is temporarily exhausted"
            })),
        )
            .into_response()),
    }
}

'''
    text = insert_before_once(
        text,
        "async fn oauth_authorization_server_metadata(",
        helper,
        "async fn acquire_oauth_slot(",
        "add bounded Actions OAuth admission",
    )

    for function_marker, next_marker in (
        ("async fn oauth_authorize_get(", "async fn oauth_authorize_post("),
        ("async fn oauth_authorize_post(", "async fn oauth_token_post("),
        ("async fn oauth_token_post(", "fn oauth_not_configured("),
    ):
        start = text.find(function_marker)
        end = text.find(next_marker, start)
        if start < 0 or end < 0:
            raise RuntimeError(f"Actions OAuth handler boundary changed: {function_marker}")
        block = text[start:end]
        if "acquire_oauth_slot(&state).await" not in block:
            brace = block.find("{\n")
            if brace < 0:
                raise RuntimeError(f"Actions OAuth handler body changed: {function_marker}")
            admission = '''{
    let _auth_permit = match acquire_oauth_slot(&state).await {
        Ok(permit) => permit,
        Err(response) => return response,
    };
'''
            block = block[:brace] + admission + block[brace + 2 :]
            text = text[:start] + block + text[end:]

    text = replace_once(
        text,
        '''    authorize_post(oauth, form, &resolve_oauth_base(&state, &headers))
}

async fn oauth_token_post(''',
        '''    let response = authorize_post(oauth, form, &resolve_oauth_base(&state, &headers));
    if response.status() == StatusCode::UNAUTHORIZED {
        tokio::time::sleep(std::time::Duration::from_millis(
            AUTH_FAILURE_DELAY_MILLIS,
        ))
        .await;
    }
    response
}

async fn oauth_token_post(''',
        "delay failed Actions OAuth passwords while holding bounded capacity",
    )
    text = replace_once(
        text,
        '''    token_exchange(oauth, &headers, form, &resolve_oauth_base(&state, &headers))
}

fn oauth_not_configured(''',
        '''    let response = token_exchange(oauth, &headers, form, &resolve_oauth_base(&state, &headers));
    if response.status() != StatusCode::OK {
        tokio::time::sleep(std::time::Duration::from_millis(
            TOKEN_FAILURE_DELAY_MILLIS,
        ))
        .await;
    }
    response
}

fn oauth_not_configured(''',
        "delay failed Actions token exchanges while holding bounded capacity",
    )

    text = replace_once(
        text,
        '''    let write_guard = if tools::registry::MUTATING_TOOLS.contains(&tool_name.as_str()) {
        Some(state.write_lock.clone().lock_owned().await)
    } else {
        None
    };
''',
        '''    let write_guard = if tools::registry::MUTATING_TOOLS.contains(&tool_name.as_str()) {
        match tokio::time::timeout(
            std::time::Duration::from_secs(REQUEST_QUEUE_WAIT_SECONDS),
            state.write_lock.clone().lock_owned(),
        )
        .await
        {
            Ok(guard) => Some(guard),
            Err(_) => {
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({
                        "detail": "Actions mutating request queue is temporarily full"
                    })),
                )
                    .into_response();
            }
        }
    } else {
        None
    };
''',
        "bound the Actions mutating write queue",
    )
    text = append_once(
        text,
        AUTH_TESTS,
        "mod oauth_capacity_hardening_tests",
        "test independent Actions OAuth capacity",
    )
    write_existing(path, text, "bound Actions OAuth and mutating queues")


def verify() -> None:
    mcp = checked_file("src-tauri/src/mcp/listener.rs").read_text(encoding="utf-8")
    actions = checked_file("src-tauri/src/actions/listener.rs").read_text(encoding="utf-8")
    for label, text in (("MCP", mcp), ("Actions", actions)):
        required = (
            "MAX_IN_FLIGHT_AUTH_REQUESTS",
            "auth_slots: Arc<Semaphore>",
            "async fn acquire_oauth_slot(",
            "AUTH_FAILURE_DELAY_MILLIS",
            "TOKEN_FAILURE_DELAY_MILLIS",
            "mod oauth_capacity_hardening_tests",
        )
        missing = [item for item in required if item not in text]
        if missing:
            raise RuntimeError(f"{label} OAuth overload hardening is incomplete: {missing}")
        if text.count("acquire_oauth_slot(&state).await") < 3:
            raise RuntimeError(f"{label} OAuth handlers are not all capacity-bound")
    if "Actions mutating request queue is temporarily full" not in actions:
        raise RuntimeError("Actions mutating write queue remains unbounded")


patch_mcp()
patch_actions()
verify()
print("OAuth and Actions queue limits applied successfully")
