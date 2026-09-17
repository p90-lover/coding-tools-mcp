from __future__ import annotations

from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if new in text:
        print(f"{label}: already applied")
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count} in {path}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"{label}: applied")


def main() -> None:
    replace_once(
        "src/lib/provider-center.ts",
        "export type ProviderProfileInput = Omit<\n"
        "  ProviderProfile,\n"
        "  'generation' | 'revision' | 'updated_at' | 'archived'\n"
        "> & { id: string | null };",
        "export type ProviderProfileInput = Omit<\n"
        "  ProviderProfile,\n"
        "  'id' | 'generation' | 'revision' | 'updated_at' | 'archived'\n"
        "> & { id: string | null };",
        "provider nullable draft id",
    )

    replace_once(
        "src/lib/orchestrator-center.ts",
        "export type OrchestratorProfileInput = Omit<\n"
        "  OrchestratorProfile,\n"
        "  'archived' | 'revision' | 'updated_at'\n"
        "> & { id: string | null };",
        "export type OrchestratorProfileInput = Omit<\n"
        "  OrchestratorProfile,\n"
        "  'id' | 'archived' | 'revision' | 'updated_at'\n"
        "> & { id: string | null };",
        "orchestrator nullable draft id",
    )

    replace_once(
        "src/lib/components/AppShell.svelte",
        "repoError='Open the repository from your browser. / 請在瀏覽器開啟儲存庫。';}}><Github",
        "repoError='Open the repository from your browser. / 請在瀏覽器開啟儲存庫。';}}}><Github",
        "repository button expression closure",
    )

    replace_once(
        "package.json",
        '"check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json"',
        '"check": "svelte-kit sync && svelte-check --config ./svelte.config.js --tsconfig ./tsconfig.json"',
        "root Svelte config boundary",
    )

    print("RC6_MAIN_UNION_FIXES_OK")


if __name__ == "__main__":
    main()
