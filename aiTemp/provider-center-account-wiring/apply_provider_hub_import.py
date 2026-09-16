from pathlib import Path

path = Path("desktop-electron/src/App.tsx")
old = 'import { ProviderCenterSurface } from "./features/ProviderOrchestratorSurfaces";'
new = 'import { ProviderCenterSurface } from "./features/ProviderHubSurface";'
text = path.read_text(encoding="utf-8")

if new in text:
    print("PROVIDER_HUB_IMPORT_ALREADY_APPLIED")
elif old in text:
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print("PROVIDER_HUB_IMPORT_APPLIED")
else:
    raise SystemExit("Provider Center import anchor was not found")
