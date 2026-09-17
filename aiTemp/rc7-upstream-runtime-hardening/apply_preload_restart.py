from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "desktop-electron/electron/preload.cjs"
BEFORE = '''  startUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-start", toolId),
  stopUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-stop", toolId),
  openEmbeddedTool: (toolId, section) => ipcRenderer.invoke(
'''
AFTER = '''  startUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-start", toolId),
  stopUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-stop", toolId),
  restartUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-restart", toolId),
  openEmbeddedTool: (toolId, section) => ipcRenderer.invoke(
'''

text = PATH.read_text(encoding="utf-8")
if AFTER in text:
    print("already applied: desktop-electron/electron/preload.cjs")
elif text.count(BEFORE) == 1:
    PATH.write_text(text.replace(BEFORE, AFTER, 1), encoding="utf-8")
    print("patched: desktop-electron/electron/preload.cjs")
else:
    raise SystemExit(
        "expected one restart bridge anchor in desktop-electron/electron/preload.cjs, "
        f"found {text.count(BEFORE)}"
    )

print("RC7_UPSTREAM_PRELOAD_RESTART_APPLIED")
