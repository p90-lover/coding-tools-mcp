from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected one match, found {count}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "desktop-electron/src/types.ts",
    'export type Surface = "browser" | "setup" | "mcp" | "providers" | "orchestrator" | "activity" | "settings";',
    'export type Surface = "browser" | "setup" | "mcp" | "providers" | "paseo" | "anneal" | "network" | "activity" | "settings";',
)

replace_once(
    "desktop-electron/src/App.tsx",
    'import { ProviderCenterSurface, OrchestratorSurface } from "./features/ProviderOrchestratorSurfaces";',
    '''import { ProviderCenterSurface } from "./features/ProviderOrchestratorSurfaces";
import { PaseoOrchestratorSurface } from "./features/PaseoOrchestratorSurface";
import { AnnealTasksSurface } from "./features/AnnealTasksSurface";
import { NetworkProxySurface } from "./features/NetworkProxySurface";''',
)

old_sidebar = '''                <SidebarItem
                  active={surface === "orchestrator"}
                  icon="orchestrator"
                  label={language === "zh-TW" ? "Orchestrator 編排" : language === "zh-CN" ? "Orchestrator 编排" : language === "ja" ? "オーケストレーター" : "Orchestrator"}
                  onClick={() => navigateSurface("orchestrator")}
                />'''
new_sidebar = '''                <SidebarItem
                  active={surface === "paseo"}
                  icon="orchestrator"
                  label={language === "zh-TW" ? "Paseo 協調器" : language === "zh-CN" ? "Paseo 协调器" : language === "ja" ? "Paseo オーケストレーター" : "Paseo Orchestrator"}
                  onClick={() => navigateSurface("paseo")}
                />
                <SidebarItem
                  active={surface === "anneal"}
                  icon="activity"
                  label={language === "zh-TW" ? "Anneal 任務" : language === "zh-CN" ? "Anneal 任务" : language === "ja" ? "Anneal タスク" : "Anneal Tasks"}
                  onClick={() => navigateSurface("anneal")}
                />
                <SidebarItem
                  active={surface === "network"}
                  icon="globe"
                  label={language === "zh-TW" ? "網路代理" : language === "zh-CN" ? "网络代理" : language === "ja" ? "ネットワークプロキシ" : "Network Proxy"}
                  onClick={() => navigateSurface("network")}
                />'''
replace_once("desktop-electron/src/App.tsx", old_sidebar, new_sidebar)

old_render = '''            {surface === "orchestrator" ? (
              <OrchestratorSurface language={language} setError={setError} />
            ) : null}'''
new_render = '''            {surface === "paseo" ? (
              <PaseoOrchestratorSurface language={language} setError={setError} />
            ) : null}
            {surface === "anneal" ? (
              <AnnealTasksSurface language={language} setError={setError} />
            ) : null}
            {surface === "network" ? (
              <NetworkProxySurface language={language} setError={setError} />
            ) : null}'''
replace_once("desktop-electron/src/App.tsx", old_render, new_render)

print("Applied separate Paseo, Anneal, and Network Electron surfaces.")
