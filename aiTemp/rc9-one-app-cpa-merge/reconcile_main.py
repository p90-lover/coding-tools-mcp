from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAIN = ROOT / "desktop-electron" / "electron" / "main.cjs"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    return text.replace(old, new, 1)


def main() -> None:
    text = MAIN.read_text(encoding="utf-8")

    text = replace_once(
        text,
        'const { HeadlessHost } = require("./headless-host.cjs");\n',
        'const { HeadlessHost } = require("./headless-host.cjs");\n'
        'const { createCodingToolsShellBridge } = require("./coding-tools-shell-bridge.cjs");\n',
        "shell bridge import",
    )

    handlers = '''  const codingTools = createCodingToolsShellBridge({
    assertFocusedMainWindow,
    headlessHost,
    updateController,
  });
  handle("coding-tools:runtime:status", (event) => codingTools.runtimeStatus(event));
  handle("coding-tools:workspaces:list", (event, input) => codingTools.listWorkspaces(event, input));
  handle("coding-tools:permissions:snapshot", (event, input) => codingTools.permissionsSnapshot(event, input));
  handle("coding-tools:computer:status", (event) => codingTools.computerStatus(event));
  handle("coding-tools:tasks:list", (event, input) => codingTools.listTasks(event, input));
  handle("coding-tools:history:search", (event, input) => codingTools.searchHistory(event, input));
  handle("coding-tools:native-codex:status", (event) => codingTools.nativeCodexStatus(event));
  handle("coding-tools:integrations:snapshot", (event) => codingTools.integrationsSnapshot(event));
  handle("coding-tools:updates:status", (event) => codingTools.updatesStatus(event));
  handle("coding-tools:diagnostics:snapshot", (event) => codingTools.diagnosticsSnapshot(event));
  handle("coding-tools:tools:catalog", (event, input) => codingTools.toolsCatalog(event, input));
  handle("coding-tools:tools:call", (event, input) => codingTools.toolsCall(event, input));
'''
    anchor = '  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, handler);\n'
    text = replace_once(
        text,
        anchor,
        anchor + handlers,
        "shell bridge IPC handlers",
    )

    MAIN.write_text(text, encoding="utf-8")
    print("reconciled managed CPA main process with the verified desktop shell")


if __name__ == "__main__":
    main()
