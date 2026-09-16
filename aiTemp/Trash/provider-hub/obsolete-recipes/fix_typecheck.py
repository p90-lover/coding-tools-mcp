from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "desktop-electron/src/providers/ProviderHubIntegration.tsx"
OLD = "setSnapshot(result as ProviderNetworkSnapshot);"
NEW = "setSnapshot(result as unknown as ProviderNetworkSnapshot);"

text = TARGET.read_text(encoding="utf-8")
if NEW in text:
    print("Provider Hub result narrowing is already applied.")
elif text.count(OLD) == 1:
    TARGET.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print("Applied Provider Hub result narrowing repair.")
else:
    raise SystemExit(f"Expected one Provider Hub snapshot cast, found {text.count(OLD)}")
