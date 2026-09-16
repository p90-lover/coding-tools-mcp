from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def require(path: str, *needles: str) -> None:
    text = source(path)
    missing = [needle for needle in needles if needle not in text]
    if missing:
        raise AssertionError(f"{path} missing: {', '.join(missing)}")


def forbid(path: str, *needles: str) -> None:
    text = source(path)
    present = [needle for needle in needles if needle in text]
    if present:
        raise AssertionError(f"{path} contains forbidden text: {', '.join(present)}")


def require_before(path: str, first: str, second: str) -> None:
    text = source(path)
    first_index = text.find(first)
    second_index = text.find(second)
    if first_index < 0 or second_index < 0 or first_index >= second_index:
        raise AssertionError(f"{path} must place {first!r} before {second!r}")


def main() -> None:
    require(
        "src-tauri/src/lib.rs",
        "pub mod media;",
        "provider_image_generate",
    )
    require(
        "src-tauri/src/media.rs",
        "ImageGenerationInput",
        "ImageGenerationTarget",
        "image_generation",
        "inlineData",
        "b64_json",
        "create_new(true)",
        ".coding-tools",
        "artifacts",
        "connected_credential(&profile)",
        "validate_image_dimensions",
        "preview_data_url",
    )
    require_before(
        "src-tauri/src/media.rs",
        "workspace_root(&input.workspace_id)",
        ".post(endpoint(&profile, &input.model)?",
    )
    require(
        "src-tauri/src/commands/providers.rs",
        "provider_image_generate",
        "confirm",
    )
    require(
        "src/lib/provider-media.ts",
        "provider_image_generate",
        "ImageGenerationResult",
    )
    require(
        "src/routes/image-studio/+page.svelte",
        "generateProviderImage",
        "image_generation",
        "paseo",
        "anneal",
        "profile.base_url",
        "artifact.preview_data_url",
    )
    forbid(
        "src/routes/image-studio/+page.svelte",
        "convertFileSrc",
    )
    require(
        "src/lib/components/AppShell.svelte",
        "'/image-studio'",
    )
    print("IMAGE_PROVIDER_RC2_CONTRACT_OK")


if __name__ == "__main__":
    main()
