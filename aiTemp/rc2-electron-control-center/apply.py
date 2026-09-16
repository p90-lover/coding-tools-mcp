from __future__ import annotations

from pathlib import Path


def replace_once(path: Path, before: str, after: str) -> None:
    source = path.read_text(encoding="utf-8")
    if after in source:
        print(f"already applied: {path}")
        return
    if before not in source:
        raise SystemExit(f"required patch anchor missing in {path}: {before[:120]!r}")
    path.write_text(source.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {path}")


def patch_types() -> None:
    path = Path("desktop-electron/src/types.ts")
    replace_once(
        path,
        'export type Surface = "browser" | "setup" | "mcp" | "activity" | "settings";',
        'export type Surface = "browser" | "setup" | "mcp" | "providers" | "orchestrator" | "activity" | "settings";',
    )
    marker = '''declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
  }
}
'''
    addition = '''export interface CodingToolsApi {
  workspaces: {
    list(input?: Record<string, unknown>): Promise<unknown>;
  };
  execution: {
    read(input: {
      workspaceId: string;
      missionId?: string | null;
      refreshSource?: boolean;
    }): Promise<unknown>;
    provider(input: {
      workspaceId: string;
      operation: "configure" | "connect" | "disable";
      expectedRevision?: number | null;
      bindingId?: string | null;
      settings?: Record<string, unknown> | null;
      credential?: string;
      confirm: boolean;
    }): Promise<unknown>;
    update(input: {
      workspaceId: string;
      expectedRevision: number;
      change: Record<string, unknown>;
      confirm: boolean;
    }): Promise<unknown>;
  };
}

declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
    codingTools?: CodingToolsApi;
  }
}
'''
    replace_once(path, marker, addition)


def patch_icons() -> None:
    path = Path("desktop-electron/src/icons.tsx")
    replace_once(
        path,
        '  | "mcp"\n  | "minus"',
        '  | "mcp"\n  | "providers"\n  | "orchestrator"\n  | "minus"',
    )
    replace_once(
        path,
        '      {name === "mcp" ? <><path {...common} d="M8 7.5 12 4l4 3.5v5L12 16l-4-3.5v-5Z" /><path {...common} d="m8 12.5-3 2.7v3.3L8 21l3-2.5V16M16 12.5l3 2.7v3.3L16 21l-3-2.5V16" /></> : null}\n      {name === "minus"',
        '      {name === "mcp" ? <><path {...common} d="M8 7.5 12 4l4 3.5v5L12 16l-4-3.5v-5Z" /><path {...common} d="m8 12.5-3 2.7v3.3L8 21l3-2.5V16M16 12.5l3 2.7v3.3L16 21l-3-2.5V16" /></> : null}\n      {name === "providers" ? <><rect {...common} x="3" y="5" width="8" height="6" rx="2" /><rect {...common} x="13" y="5" width="8" height="6" rx="2" /><rect {...common} x="8" y="14" width="8" height="6" rx="2" /><path {...common} d="M7 11v1.5h10V11M12 12.5V14" /></> : null}\n      {name === "orchestrator" ? <><circle {...common} cx="5" cy="6" r="2" /><circle {...common} cx="19" cy="6" r="2" /><circle {...common} cx="12" cy="18" r="2" /><path {...common} d="M7 6h10M6.5 7.5 10.8 16M17.5 7.5 13.2 16" /></> : null}\n      {name === "minus"',
    )


def patch_app() -> None:
    path = Path("desktop-electron/src/App.tsx")
    replace_once(
        path,
        'import { Icon, type IconName } from "./icons";\nimport type {',
        'import { Icon, type IconName } from "./icons";\nimport { ProviderCenterSurface, OrchestratorSurface } from "./features/ProviderOrchestratorSurfaces";\nimport type {',
    )

    mcp_block = '''                <SidebarItem
                  active={surface === "mcp"}
                  badge={mcpOptional ? <ActionDot tone="optional" /> : null}
                  icon="mcp"
                  label="MCP"
                  onClick={() => {
                    setMcpTargetMode(null);
                    navigateSurface("mcp");
                  }}
                />
              </SidebarGroup>
'''
    mcp_with_provider = '''                <SidebarItem
                  active={surface === "mcp"}
                  badge={mcpOptional ? <ActionDot tone="optional" /> : null}
                  icon="mcp"
                  label="MCP"
                  onClick={() => {
                    setMcpTargetMode(null);
                    navigateSurface("mcp");
                  }}
                />
                <SidebarItem
                  active={surface === "providers"}
                  icon="providers"
                  label={language === "zh-TW" ? "供應商" : language === "zh-CN" ? "供应商" : language === "ja" ? "プロバイダー" : "Providers"}
                  onClick={() => navigateSurface("providers")}
                />
                <SidebarItem
                  active={surface === "orchestrator"}
                  icon="orchestrator"
                  label={language === "zh-TW" ? "Orchestrator 編排" : language === "zh-CN" ? "Orchestrator 编排" : language === "ja" ? "オーケストレーター" : "Orchestrator"}
                  onClick={() => navigateSurface("orchestrator")}
                />
              </SidebarGroup>
'''
    replace_once(path, mcp_block, mcp_with_provider)

    activity_block = '''            {surface === "activity" ? (
              <ActivitySurface copy={copy} language={language} logs={logs} setError={setError} />
            ) : null}
            {surface === "settings" ? (
'''
    activity_with_surfaces = '''            {surface === "activity" ? (
              <ActivitySurface copy={copy} language={language} logs={logs} setError={setError} />
            ) : null}
            {surface === "providers" ? (
              <ProviderCenterSurface language={language} setError={setError} />
            ) : null}
            {surface === "orchestrator" ? (
              <OrchestratorSurface language={language} setError={setError} />
            ) : null}
            {surface === "settings" ? (
'''
    replace_once(path, activity_block, activity_with_surfaces)


def main() -> None:
    patch_types()
    patch_icons()
    patch_app()


if __name__ == "__main__":
    main()
