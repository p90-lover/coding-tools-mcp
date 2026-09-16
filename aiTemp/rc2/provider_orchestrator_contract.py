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
        "provider_profiles_read",
        "provider_profile_save",
        "provider_profile_probe",
        "orchestrator_profiles_read",
        "orchestrator_profile_save",
    )
    require(
        "src-tauri/src/commands/mod.rs",
        "mod providers;",
        "mod orchestrators;",
        "provider_profiles_read",
        "orchestrator_profiles_read",
    )
    require(
        "src-tauri/src/data/model.rs",
        "provider_registry_revision",
        "provider_profiles",
        "orchestrator_registry_revision",
        "orchestrator_profiles",
    )
    require(
        "src/lib/components/AppShell.svelte",
        "'/providers'",
        "'/orchestrators'",
    )
    require(
        "src/lib/provider-center.ts",
        "provider_profiles_read",
        "provider_profile_save",
        "provider_profile_probe",
        "connectProviderProfile",
    )
    require(
        "src/routes/providers/+page.svelte",
        "readProviderProfiles",
        "saveProviderProfile",
        "probeProviderProfile",
        "PROVIDER_CAPABILITIES",
    )
    require(
        "src/lib/orchestrator-center.ts",
        "orchestrator_profiles_read",
        "orchestrator_profile_save",
        "fallback_provider_ids",
        "max_concurrency",
    )
    require(
        "src/routes/orchestrators/+page.svelte",
        "readOrchestrators",
        "saveOrchestrator",
        "fallback_provider_ids",
        "max_concurrency",
    )
    require(
        "src-tauri/src/providers.rs",
        "AI Studio Reverse Proxy",
        "CLIProxyAPI / Antigravity",
        "CommandCode Proxy",
        "pub async fn probe",
    )
    require(
        "src-tauri/src/orchestrators.rs",
        "pub struct OrchestratorStage",
        "fallback_provider_ids",
        "pub fn runnable_snapshot",
    )
    print("PROVIDER_ORCHESTRATOR_RC2_CONTRACT_OK")


if __name__ == "__main__":
    main()
