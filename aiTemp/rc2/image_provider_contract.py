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
    )
    require(
        "src/lib/components/AppShell.svelte",
        "'/image-studio'",
    )
    print("IMAGE_PROVIDER_RC2_CONTRACT_OK")


if __name__ == "__main__":
    main()
