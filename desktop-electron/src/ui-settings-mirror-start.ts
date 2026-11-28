import { installUiSettingsMirror } from "./ui-settings-mirror";

// main.tsx's first import, so a reset store has its settings back before React or any screen runs.
try {
  installUiSettingsMirror({ storage: window.localStorage, bridge: window.codexWebLauncher, target: window });
} catch {
  // A blocked store: the screens fall back to their defaults, as they always did.
}
