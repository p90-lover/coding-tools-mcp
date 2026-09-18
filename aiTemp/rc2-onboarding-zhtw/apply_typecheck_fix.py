from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "desktop-electron/src/i18n.ts"
OLD = """const zhTW = {
  ...zh,
  ...zhTWOverrides,
} as Copy;

export function copyFor"""
NEW = """const zhTW = {
  ...zh,
  ...zhTWOverrides,
} as unknown as Copy;

export function copyFor"""

source = TARGET.read_text(encoding="utf-8")
count = source.count(OLD)
if count == 0:
    if NEW not in source:
        raise SystemExit("Traditional Chinese Copy cast was not found")
elif count == 1:
    TARGET.write_text(source.replace(OLD, NEW, 1), encoding="utf-8")
else:
    raise SystemExit(f"Expected one Traditional Chinese Copy cast, found {count}")

print("Applied the narrow Traditional Chinese Copy typecheck repair.")
