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
for module in ("service", "schema"):
    require(
        "src-tauri/src/integrations/execution/mod.rs",
        f"pub mod {module};",
        f"execution-{module}-module",
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
for function in ("service::view", "service::refresh", "service::change"):
    require(
        "src-tauri/src/tools/workflow.rs",
        function,
        f"workflow-{function.replace('::', '-')}",
    )
require(
    "src-tauri/src/tools/workflow.rs",
    'v.starts_with("agent_")',
    "workflow-typed-agent-routing",
)
for variant in ("AgentPrepare", "AgentControl", "AgentReview"):
    require(
        "src-tauri/src/integrations/execution/service.rs",
        variant,
        f"typed-operation-{variant}",
    )
require(
    "src-tauri/src/commands/execution.rs",
    "workflow::call(",
    "visible-read-shared-workflow",
)
require(
    "src-tauri/src/commands/execution.rs",
    "service::change(&request, expected_revision, change)",
    "visible-update-typed-service",
)
forbid(
    "src-tauri/src/commands/execution.rs",
    "call_tool_mcp",
    "local-command-self-dispatch",
)
require(
    "rust-core/coding-tools-headless/src/lib.rs",
    'route("/api/v1/integrations/read", post(integration_read))',
    "headless-read-adapter-route",
)
for marker in (
    "struct IntegrationReadRequest",
    'admit(&state, "integration_read")',
    "integrations::read(body.source, &body.endpoint, &body.credential).await",
    '"INTEGRATION_READ_FAILED"',
):
    require(
        "rust-core/coding-tools-headless/src/lib.rs",
        marker,
        f"headless-{marker[:32]}",
    )
for source_name in ("Paseo", "Anneal"):
    require(
        "src-tauri/src/integrations/mod.rs",
        source_name,
        f"bounded-source-{source_name.lower()}",
    )
require(
    "src-tauri/src/integrations/mod.rs",
    "Use 127.0.0.1 or [::1]",
    "loopback-only-provider-boundary",
)

print("PASEO_ANNEAL_07_WIRING_CONTRACT_OK")
