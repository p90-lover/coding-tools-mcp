from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    source = target.read_text(encoding="utf-8")
    if new in source:
        return
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one anchor, got {count}: {old!r}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


def remove_once(path: str, value: str) -> None:
    target = ROOT / path
    source = target.read_text(encoding="utf-8")
    count = source.count(value)
    if count == 0:
        return
    if count != 1:
        raise RuntimeError(f"{path}: expected at most one removable anchor, got {count}")
    target.write_text(source.replace(value, "", 1), encoding="utf-8")


def main() -> None:
    replace_once(
        "src-tauri/src/lib.rs",
        "pub mod integrations;\n",
        "pub mod integrations;\npub mod media;\n",
    )
    replace_once(
        "src-tauri/src/lib.rs",
        "provider_config_preview, provider_profile_archive, provider_profile_connect,\n",
        "provider_config_preview, provider_image_generate, provider_profile_archive, provider_profile_connect,\n",
    )
    replace_once(
        "src-tauri/src/lib.rs",
        "            provider_profiles_read,\n",
        "            provider_image_generate,\n            provider_profiles_read,\n",
    )
    replace_once(
        "src/lib/components/AppShell.svelte",
        "Github, Command, Cpu, GitBranch, Play }",
        "Github, Command, Cpu, GitBranch, Play, Image as ImageIcon }",
    )
    replace_once(
        "src/lib/components/AppShell.svelte",
        "{path:'/providers',en:'Providers',zh:'供應商',icon:Cpu}",
        "{path:'/image-studio',en:'Image Studio',zh:'圖片工作室',icon:ImageIcon},{path:'/providers',en:'Providers',zh:'供應商',icon:Cpu}",
    )
    remove_once("src-tauri/src/media.rs", "    create_new(true);\n")
    print("IMAGE_PROVIDER_WIRING_OK")


if __name__ == "__main__":
    main()
