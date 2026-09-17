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
    "desktop-electron/electron/upstream-tools.cjs",
    '''  async function stop(toolId) {
    requireTool(toolId);
    const child = processes.get(toolId);
    if (child && !child.killed) child.kill("SIGTERM");
    processes.delete(toolId);
    publish(toolId, { status: "offline", pid: null, checkedAt: now(), error: null });
    return project(toolId);
  }

  function dispose() {
''',
    '''  async function stop(toolId) {
    requireTool(toolId);
    const child = processes.get(toolId);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = await new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          child.removeListener("exit", onExit);
          child.removeListener("error", onError);
          resolve(value);
        };
        const onExit = () => finish(true);
        const onError = () => finish(true);
        child.once("exit", onExit);
        child.once("error", onError);
        timer = setTimeout(() => finish(false), 5_000);
        timer.unref?.();
        try {
          if (!child.kill("SIGTERM")) finish(false);
        } catch {
          finish(false);
        }
      });
      if (!exited && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }
    processes.delete(toolId);
    publish(toolId, { status: "offline", pid: null, checkedAt: now(), error: null });
    return project(toolId);
  }

  async function restart(toolId) {
    requireTool(toolId);
    await stop(toolId);
    return start(toolId);
  }

  function dispose() {
''',
)

replace_once(
    "desktop-electron/electron/upstream-tools.cjs",
    '''    start,
    stop,
    openEmbeddedTool,
''',
    '''    start,
    stop,
    restart,
    openEmbeddedTool,
''',
)

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

replace_once(
    "desktop-electron/src/features/UpstreamToolSurface.tsx",
    '''function sectionLabel(section: string): string {
  return section.replaceAll("-", " ").replace(/(^|\\s)\\S/g, (value) => value.toUpperCase());
}
''',
    '''const SECTION_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  tasks: ["Tasks", "任務"],
  projects: ["Projects", "專案"],
  agents: ["Agents", "代理"],
  sessions: ["Sessions", "工作階段"],
  inbox: ["Inbox", "收件匣"],
  automations: ["Automations", "自動化"],
  triggers: ["Triggers", "觸發器"],
  costs: ["Costs", "成本"],
  goals: ["Goals", "目標"],
  connections: ["Connections", "連線"],
  settings: ["Settings", "設定"],
  workspaces: ["Workspaces", "工作區"],
  providers: ["Providers", "供應商"],
  plugins: ["Plugins", "外掛"],
  voice: ["Voice", "語音"],
};

function sectionLabel(language: Language, section: string): string {
  const labels = SECTION_LABELS[section];
  if (labels) return localize(language, labels[0], labels[1]);
  return section.replaceAll("-", " ").replace(/(^|\\s)\\S/g, (value) => value.toUpperCase());
}
''',
)

replace_once(
    "desktop-electron/src/features/UpstreamToolSurface.tsx",
    '''  const start = () => run("start", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.startUpstreamTool(toolId);
    await openEmbeddedTool();
  });

  const stop = () => run("stop", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.stopUpstreamTool(toolId);
    setFrameUrl("");
  });

  const openExternal = () => run("external", async () => {
''',
    '''  const openEmbedded = () => run("open", async () => {
    await openEmbeddedTool();
  });

  const start = () => run("start", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.startUpstreamTool(toolId);
    await openEmbeddedTool();
  });

  const restart = () => run("restart", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.restartUpstreamTool(toolId);
    await openEmbeddedTool();
  });

  const stop = () => run("stop", async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    await api.stopUpstreamTool(toolId);
    setFrameUrl("");
  });

  const openExternal = () => run("external", async () => {
''',
)

replace_once(
    "desktop-electron/src/features/UpstreamToolSurface.tsx",
    '''          <span className="upstream-tool-kicker">PINNED UPSTREAM</span>
''',
    '''          <span className="upstream-tool-kicker">
            {localize(language, "PINNED UPSTREAM", "固定上游版本")}
          </span>
''',
)

replace_once(
    "desktop-electron/src/features/UpstreamToolSurface.tsx",
    '''        <button className="primary" disabled={busy !== null} onClick={() => void (ready ? openEmbeddedTool() : start())} type="button">
          {busy === "start" ? "…" : ready
            ? localize(language, "Open full UI", "開啟完整介面")
            : localize(language, "Start pinned source", "啟動固定版本")}
        </button>
        <button disabled={busy !== null || !ready} onClick={() => void openExternal()} type="button">
          {busy === "external" ? "…" : localize(language, "Open externally", "外部開啟")}
        </button>
        <button disabled={busy !== null || (!ready && tool.pid === null)} onClick={() => void stop()} type="button">
          {busy === "stop" ? "…" : localize(language, "Stop", "停止")}
        </button>
''',
    '''        <button className="primary" disabled={busy !== null} onClick={() => void (ready ? openEmbedded() : start())} type="button">
          {busy === "start" || busy === "open" ? "…" : ready
            ? localize(language, "Open full UI", "開啟完整介面")
            : localize(language, "Start pinned source", "啟動固定版本")}
        </button>
        <button disabled={busy !== null || !ready} onClick={() => void openExternal()} type="button">
          {busy === "external" ? "…" : localize(language, "Open externally", "外部開啟")}
        </button>
        <button disabled={busy !== null || tool.pid === null} onClick={() => void restart()} type="button">
          {busy === "restart" ? "…" : localize(language, "Restart", "重新啟動")}
        </button>
        <button disabled={busy !== null || (!ready && tool.pid === null)} onClick={() => void stop()} type="button">
          {busy === "stop" ? "…" : localize(language, "Stop", "停止")}
        </button>
''',
)

replace_once(
    "desktop-electron/src/features/UpstreamToolSurface.tsx",
    '''            {sectionLabel(section)}
''',
    '''            {sectionLabel(language, section)}
''',
)

print("RC7_UPSTREAM_RUNTIME_HARDENING_APPLIED")
