from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[2]
PROVIDER_CENTER = ROOT / "src/lib/provider-center.ts"
ORCHESTRATOR_CENTER = ROOT / "src/lib/orchestrator-center.ts"
APP_SHELL = ROOT / "src/lib/components/AppShell.svelte"
PREVIOUS = Path(__file__).with_name("apply_image_review_fixes_v2.py")


def replace_once(path: Path, old: str, new: str, label: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if new in text and old not in text:
        return False
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


changed = False
changed |= replace_once(
    PROVIDER_CENTER,
    "  'generation' | 'revision' | 'updated_at' | 'archived'\n> & { id: string | null };",
    "  'id' | 'generation' | 'revision' | 'updated_at' | 'archived'\n> & { id: string | null };",
    "provider input nullable id",
)
changed |= replace_once(
    ORCHESTRATOR_CENTER,
    "  'archived' | 'revision' | 'updated_at'\n> & { id: string | null };",
    "  'id' | 'archived' | 'revision' | 'updated_at'\n> & { id: string | null };",
    "orchestrator input nullable id",
)
changed |= replace_once(
    APP_SHELL,
    "repoError='Open the repository from your browser. / 請在瀏覽器開啟儲存庫。';}}><Github",
    "repoError='Open the repository from your browser. / 請在瀏覽器開啟儲存庫。';}}}><Github",
    "repository button expression",
)

runpy.run_path(str(PREVIOUS), run_name="__main__")

for path in (PROVIDER_CENTER, ORCHESTRATOR_CENTER, APP_SHELL):
    if not path.read_text(encoding="utf-8").endswith("\n"):
        raise SystemExit(f"{path}: final newline missing")

print(f"RC2_FRONTEND_INTEGRATION_FIXES_OK changed={str(changed).lower()}")
