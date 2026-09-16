from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def require(path: str, *needles: str) -> None:
    source = read(path)
    missing = [needle for needle in needles if needle not in source]
    if missing:
        joined = "\n  - ".join(missing)
        raise AssertionError(f"{path} is missing:\n  - {joined}")


def main() -> None:
    require(
        "src-tauri/src/lib.rs",
        "pub mod providers;",
        "pub mod orchestrators;",
        "pub mod orchestrator_run;",
        "provider_profiles_read",
        "orchestrator_profiles_read",
        "orchestrator_profile_run",
    )
    require(
        "src-tauri/src/commands/mod.rs",
        "mod providers;",
        "mod orchestrators;",
        "provider_profile_probe",
        "orchestrator_profile_run",
    )
    require(
        "src-tauri/src/data/model.rs",
        "provider_registry_revision",
        "provider_profiles",
        "orchestrator_registry_revision",
        "orchestrator_profiles",
    )
    require(
        "src-tauri/src/providers.rs",
        "AI Studio Reverse Proxy",
        "Gemini Reverse Proxy",
        "AIStudioToAPI",
        "CLIProxyAPI / Antigravity",
        "CommandCode Proxy",
        "pub async fn probe",
    )
    require(
        "src-tauri/src/orchestrators.rs",
        "pub struct OrchestratorStage",
        "fallback_provider_ids",
        "max_concurrency",
        "pub fn runnable_snapshot",
    )
    require(
        "src-tauri/src/orchestrator_run.rs",
        "task-templates/{}/instantiate",
        "stepOverrides",
        "staffingProfileId",
        "pub async fn run",
    )
    require(
        "src-tauri/src/commands/providers.rs",
        "provider_profiles_read",
        "provider_profile_save",
        "provider_profile_probe",
    )
    require(
        "src-tauri/src/commands/orchestrators.rs",
        "orchestrator_profiles_read",
        "orchestrator_profile_save",
        "orchestrator_profile_run",
    )
    require(
        "src/lib/provider-center.ts",
        "provider_profiles_read",
        "provider_profile_save",
        "provider_profile_probe",
        "connectProviderProfile",
    )
    require(
        "src/lib/orchestrator-center.ts",
        "orchestrator_profiles_read",
        "orchestrator_profile_save",
        "orchestrator_profile_run",
        "fallback_provider_ids",
        "max_concurrency",
    )
    require(
        "src/routes/orchestrator-run/+page.svelte",
        "runAnnealOrchestrator",
        "operator_token",
        "auto_start",
        "approved",
    )
    require("src/lib/components/AppShell.svelte", "'/orchestrator-run'")
    print("TAURI_PROVIDER_ORCHESTRATOR_BACKEND_CONTRACT_OK")


if __name__ == "__main__":
    main()
