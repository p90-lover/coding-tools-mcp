from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: Path, before: str, after: str) -> None:
    source = path.read_text(encoding="utf-8")
    if after in source:
        print(f"already applied: {path}")
        return
    if before not in source:
        raise SystemExit(f"required anchor missing in {path}: {before[:140]!r}")
    path.write_text(source.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {path}")


def patch_types() -> None:
    path = ROOT / "desktop-electron/src/types.ts"
    replace_once(
        path,
        'export type Surface = "browser" | "setup" | "mcp" | "providers" | "integrations" | "paseo" | "anneal" | "network" | "activity" | "settings";',
        'export type Surface = "browser" | "setup" | "mcp" | "apps" | "providers" | "integrations" | "paseo" | "anneal" | "network" | "activity" | "settings";',
    )


def patch_shell() -> None:
    path = ROOT / "desktop-electron/src/App.tsx"
    source = path.read_text(encoding="utf-8")

    import_anchor = 'import { ExternalServicesSurface } from "./features/ExternalServicesSurface";\n'
    import_line = import_anchor + 'import { IntegratedAppsSurface } from "./features/IntegratedAppsSurface";\n'
    if 'import { IntegratedAppsSurface } from "./features/IntegratedAppsSurface";' not in source:
        if import_anchor not in source:
            raise SystemExit("App.tsx integrated-app import anchor is missing")
        source = source.replace(import_anchor, import_line, 1)

    sidebar_pattern = re.compile(
        r'''\n\s*<SidebarItem\n\s*active=\{surface === "providers"\}.*?'''
        r'''onClick=\{\(\) => navigateSurface\("anneal"\)\}\n\s*/>''',
        re.DOTALL,
    )
    apps_item = '''
                <SidebarItem
                  active={surface === "apps"}
                  icon="orchestrator"
                  label={language === "zh-TW" ? "應用程式" : language === "zh-CN" ? "应用程序" : language === "ja" ? "アプリ" : "Apps"}
                  onClick={() => navigateSurface("apps")}
                />'''
    if 'active={surface === "apps"}' not in source:
        source, count = sidebar_pattern.subn(apps_item, source, count=1)
        if count != 1:
            raise SystemExit(f"expected one fragmented app-navigation block, found {count}")

    render_anchor = '''            {surface === "providers" ? (
              <ProviderCenterSurface language={language} setError={setError} />
            ) : null}
'''
    render_block = '''            {surface === "apps" ? (
              <IntegratedAppsSurface language={language} setError={setError} />
            ) : null}
''' + render_anchor
    if 'surface === "apps" ? (' not in source:
        if render_anchor not in source:
            raise SystemExit("App.tsx apps render anchor is missing")
        source = source.replace(render_anchor, render_block, 1)

    path.write_text(source, encoding="utf-8")
    print(f"patched: {path}")


def patch_external_services() -> None:
    path = ROOT / "desktop-electron/src/features/ExternalServicesSurface.tsx"
    source = path.read_text(encoding="utf-8")

    props_anchor = '''  openPaseo: () => void;
  openAnneal: () => void;
}'''
    props_replacement = '''  openPaseo: () => void;
  openAnneal: () => void;
  focusServiceId?: ExternalServiceId;
}'''
    if "focusServiceId?: ExternalServiceId;" not in source:
        if props_anchor not in source:
            raise SystemExit("ExternalServicesSurface props anchor is missing")
        source = source.replace(props_anchor, props_replacement, 1)

    destructure_anchor = '''  openProviders,
  openPaseo,
  openAnneal,
}: ExternalServicesSurfaceProps) {'''
    destructure_replacement = '''  openProviders,
  openPaseo,
  openAnneal,
  focusServiceId,
}: ExternalServicesSurfaceProps) {'''
    if "  focusServiceId,\n}: ExternalServicesSurfaceProps)" not in source:
        if destructure_anchor not in source:
            raise SystemExit("ExternalServicesSurface destructuring anchor is missing")
        source = source.replace(destructure_anchor, destructure_replacement, 1)

    source = source.replace(
        'const [selectedId, setSelectedId] = useState<ExternalServiceId>("codex-router");',
        'const [selectedId, setSelectedId] = useState<ExternalServiceId>(focusServiceId ?? "codex-router");',
        1,
    )

    rows_before = '''  const serviceRows = useMemo(() => services.services.map((service) => (
    service.id === "commandcode-proxy"
      ? {
          ...service,
          accountCount: commandCodeAccounts.length,
          connectedAccountCount: commandCodeAccounts.filter((account) => account.status === "connected").length,
          providerModelCount: commandCodeModels,
        }
      : service
  )), [services, commandCodeAccounts, commandCodeModels]);'''
    rows_after = '''  const serviceRows = useMemo(() => services.services
    .filter((service) => !focusServiceId || service.id === focusServiceId)
    .map((service) => (
      service.id === "commandcode-proxy"
        ? {
            ...service,
            accountCount: commandCodeAccounts.length,
            connectedAccountCount: commandCodeAccounts.filter((account) => account.status === "connected").length,
            providerModelCount: commandCodeModels,
          }
        : service
    )), [services, commandCodeAccounts, commandCodeModels, focusServiceId]);'''
    if rows_after not in source:
        if rows_before not in source:
            raise SystemExit("ExternalServicesSurface service rows anchor is missing")
        source = source.replace(rows_before, rows_after, 1)

    source = source.replace(
        'serviceSnapshot.services.find((service) => service.id === selectedId)',
        'serviceSnapshot.services.find((service) => service.id === (focusServiceId ?? selectedId))',
    )
    source = source.replace(
        'nextServices.services.find((service) => service.id === selectedId)',
        'nextServices.services.find((service) => service.id === (focusServiceId ?? selectedId))',
    )
    source = source.replace(
        'next.services.find((service) => service.id === selectedId)',
        'next.services.find((service) => service.id === (focusServiceId ?? selectedId))',
    )
    source = source.replace(
        '  }, [api, selectedId, setError]);',
        '  }, [api, focusServiceId, selectedId, setError]);',
        1,
    )

    focus_effect = '''
  useEffect(() => {
    if (focusServiceId) setSelectedId(focusServiceId);
  }, [focusServiceId]);

'''
    effect_anchor = '''  useEffect(() => {
    if (selected) {
'''
    if focus_effect.strip() not in source:
        if effect_anchor not in source:
            raise SystemExit("ExternalServicesSurface selection effect anchor is missing")
        source = source.replace(effect_anchor, focus_effect + effect_anchor, 1)

    source = source.replace(
        '<section className="external-services-surface">',
        '<section className={`external-services-surface${focusServiceId ? " is-focused" : ""}`}>',
        1,
    )

    path.write_text(source, encoding="utf-8")
    print(f"patched: {path}")


def patch_upstream_tool() -> None:
    path = ROOT / "desktop-electron/src/features/UpstreamToolSurface.tsx"
    source = path.read_text(encoding="utf-8")
    before = '''  useEffect(() => {
    let cancelled = false;
    if (!api) return;
    void api.upstreamToolsSnapshot().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      const current = toolFrom(next, toolId);
      if (current) {
        setEndpoint(current.endpoint);
        setSelectedSection(current.sections[0] || "");
      }
    }).catch((cause) => setError(messageOf(cause)));
    return () => { cancelled = true; };
  }, [api, setError, toolId]);'''
    after = '''  useEffect(() => {
    let cancelled = false;
    if (!api) return;
    void (async () => {
      try {
        await api.inspectUpstreamTool(toolId);
        const next = await api.upstreamToolsSnapshot();
        if (cancelled) return;
        setSnapshot(next);
        const current = toolFrom(next, toolId);
        if (!current) return;
        setEndpoint(current.endpoint);
        const section = current.sections[0] || "";
        setSelectedSection(section);
        if (current.status === "ready" && section) {
          const result = await api.openEmbeddedTool(toolId, section);
          if (cancelled) return;
          setFrameUrl(result.url);
          setSnapshot((value) => value
            ? {
                ...value,
                tools: value.tools.map((candidate) => candidate.id === result.tool.id ? result.tool : candidate),
              }
            : { version: 1, tools: [result.tool] });
        }
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [api, setError, toolId]);'''
    if after not in source:
        if before not in source:
            raise SystemExit("UpstreamToolSurface initialization anchor is missing")
        source = source.replace(before, after, 1)
    path.write_text(source, encoding="utf-8")
    print(f"patched: {path}")


def patch_manifests() -> None:
    paseo_path = ROOT / "desktop-electron/vendor/upstream/paseo.json"
    paseo = json.loads(paseo_path.read_text(encoding="utf-8"))
    paseo["sectionPaths"] = {
        "agents": "/sessions",
        "sessions": "/sessions",
        "workspaces": "/open-project",
        "providers": "/settings",
        "plugins": "/settings",
        "voice": "/settings",
        "settings": "/settings",
    }
    paseo_path.write_text(json.dumps(paseo, indent=2) + "\n", encoding="utf-8")

    anneal_path = ROOT / "desktop-electron/vendor/upstream/anneal.json"
    anneal = json.loads(anneal_path.read_text(encoding="utf-8"))
    anneal["sectionPaths"] = {
        section: f"#/{section}" for section in anneal.get("sections", [])
    }
    anneal_path.write_text(json.dumps(anneal, indent=2) + "\n", encoding="utf-8")
    print(f"patched: {paseo_path}")
    print(f"patched: {anneal_path}")


def patch_styles() -> None:
    path = ROOT / "desktop-electron/src/features/integrated-apps.css"
    source = path.read_text(encoding="utf-8")
    addition = '''

.integrated-app-panel-body .external-services-surface.is-focused .external-services-summary {
  display: none;
}

.integrated-app-panel-body .external-services-surface.is-focused .external-services-heading {
  padding-top: 20px;
}
'''
    if ".external-services-surface.is-focused .external-services-summary" not in source:
        path.write_text(source.rstrip() + addition.rstrip() + "\n", encoding="utf-8")
        print(f"patched: {path}")


def main() -> None:
    patch_types()
    patch_shell()
    patch_external_services()
    patch_upstream_tool()
    patch_manifests()
    patch_styles()
    print("RC10_APP_TABS_MATERIALIZED")


if __name__ == "__main__":
    main()
