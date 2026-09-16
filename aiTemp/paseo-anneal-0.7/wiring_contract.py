from pathlib import Path


def source(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def require(path: str, needle: str, label: str) -> None:
    text = source(path)
    if needle not in text:
        raise SystemExit(f"PASEO_ANNEAL_WIRING_MISSING:{label}:{path}:{needle}")


def forbid(path: str, needle: str, label: str) -> None:
    text = source(path)
    if needle in text:
        raise SystemExit(f"PASEO_ANNEAL_WIRING_STALE:{label}:{path}:{needle}")


require(
    "src-tauri/src/integrations/mod.rs",
    "pub mod execution;",
    "execution-parent-module",
)
require(
    "src-tauri/src/commands/mod.rs",
    "mod execution;",
    "execution-command-module",
)
for command in (
    "execution_local_read",
    "execution_local_provider",
    "execution_local_update",
):
    require(
        "src-tauri/src/commands/mod.rs",
        command,
        f"command-export-{command}",
    )
    require(
        "src-tauri/src/lib.rs",
        command,
        f"tauri-registration-{command}",
    )
require(
    "src-tauri/src/lib.rs",
    "pub mod integrations;",
    "public-integration-module",
)
require(
    "rust-core/coding-tools-core/src/lib.rs",
    "pub use coding_tools_mcp_desktop_lib::{data, error, integrations, runtime, tools};",
    "headless-core-integration-export",
)
require(
    "src-tauri/src/tools/workflow.rs",
    "integrations::{board_sync, execution::service}",
    "workflow-execution-service",
)
require(
    "src-tauri/src/tools/workflow.rs",
    '"agent_prepare" | "agent_control" | "agent_review"',
    "workflow-execution-routing",
)
require(
    "rust-core/coding-tools-headless/src/lib.rs",
    'route("/api/v1/integrations/read", post(integration_read))',
    "headless-read-adapter-route",
)
for source_name in ("Paseo", "Anneal"):
    require(
        "rust-core/coding-tools-headless/src/lib.rs",
        source_name,
        f"headless-source-{source_name.lower()}",
    )
forbid(
    "src-tauri/src/commands/execution.rs",
    'call_tool_mcp(&ctx,"workflow_list",&json!({"mission_id":mission_id,"refresh_source":refresh_source.unwrap_or(false)}))',
    "unverified-workflow-list-call",
)

print("PASEO_ANNEAL_07_WIRING_CONTRACT_OK")
