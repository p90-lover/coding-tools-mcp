from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, before: str, after: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {relative}")
        return
    count = text.count(before)
    if count != 1:
        raise SystemExit(
            f"expected one anchor in {relative}, found {count}: {before[:160]!r}"
        )
    path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {relative}")


replace_once(
    "desktop-electron/electron/main.cjs",
    '''  handle("launcher:upstream-tool-stop", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.stop(toolId);
  });
  handle("launcher:upstream-tool-open-embedded", (event, toolId, section) => {
''',
    '''  handle("launcher:upstream-tool-stop", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.stop(toolId);
  });
  handle("launcher:upstream-tool-restart", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.restart(toolId);
  });
  handle("launcher:upstream-tool-open-embedded", (event, toolId, section) => {
''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''    stopCatalogVerificationMonitor();
    updateController?.stopPeriodicChecks?.();
    quitting = true;
''',
    '''    stopCatalogVerificationMonitor();
    updateController?.stopPeriodicChecks?.();
    upstreamToolController?.dispose();
    quitting = true;
''',
)

replace_once(
    "desktop-electron/electron/preload.cjs",
    '''  startUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-start", toolId),
  stopUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-stop", toolId),
  openEmbeddedTool: (toolId, section) => ipcRenderer.invoke(
''',
    '''  startUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-start", toolId),
  stopUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-stop", toolId),
  restartUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-restart", toolId),
  openEmbeddedTool: (toolId, section) => ipcRenderer.invoke(
''',
)

replace_once(
    "desktop-electron/src/types.ts",
    '''  startUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  stopUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  openEmbeddedTool(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
''',
    '''  startUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  stopUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  restartUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;
  openEmbeddedTool(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
''',
)

print("RC7_CURRENT_UPSTREAM_RUNTIME_HARDENING_APPLIED")
