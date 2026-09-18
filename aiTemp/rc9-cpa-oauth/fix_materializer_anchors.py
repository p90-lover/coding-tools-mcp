from __future__ import annotations

from pathlib import Path

SOURCE = Path("aiTemp/rc9-cpa-oauth/apply_patch.py")
TARGET = Path("aiTemp/rc9-cpa-oauth/tmp/runtime_apply_patch.py")

source = SOURCE.read_text(encoding="utf-8")

root_anchor = "ROOT = Path(__file__).resolve().parents[2]"
if source.count(root_anchor) != 1:
    raise SystemExit(f"expected one repository-root anchor, found {source.count(root_anchor)}")
source = source.replace(root_anchor, "ROOT = Path(__file__).resolve().parents[3]", 1)

old = '''replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    \'\'\'    models: [],
    proxyMode: "inherit",
    subagentEnabled: true,
\'\'\',
    \'\'\'    models: [],
    proxyMode: "inherit",
    baseUrl: "http://127.0.0.1:8317",
    loginAdapters: [
      { id: "cpa-codex", kind: "cpa_oauth", label: "CPA / CLIProxyAPI OAuth", labelTraditionalChinese: "CPA／CLIProxyAPI OAuth", route: "codex-auth-url", cpaProvider: "codex" },
      { id: "native-browser", kind: "native_browser", label: "Native BrowserHost", labelTraditionalChinese: "原生 BrowserHost" },
    ],
    subagentEnabled: true,
\'\'\',
)
'''

new = '''replace_once(
    "desktop-electron/src/providers/provider-types.ts",
    \'\'\'  {
    id: "codex-oauth",
    name: "Codex OAuth",
    category: "oauth",
    auth: "oauth",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools"],
    models: [],
    proxyMode: "inherit",
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 100,
  },
\'\'\',
    \'\'\'  {
    id: "codex-oauth",
    name: "Codex OAuth",
    category: "oauth",
    auth: "oauth",
    protocol: "openai_responses",
    capabilities: ["text", "reasoning", "tools"],
    models: [],
    proxyMode: "inherit",
    baseUrl: "http://127.0.0.1:8317",
    loginAdapters: [
      { id: "cpa-codex", kind: "cpa_oauth", label: "CPA / CLIProxyAPI OAuth", labelTraditionalChinese: "CPA／CLIProxyAPI OAuth", route: "codex-auth-url", cpaProvider: "codex" },
      { id: "native-browser", kind: "native_browser", label: "Native BrowserHost", labelTraditionalChinese: "原生 BrowserHost" },
    ],
    subagentEnabled: true,
    paseoEnabled: true,
    annealEnabled: true,
    priority: 100,
  },
\'\'\',
)
'''

if new not in source:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"expected one ambiguous Codex materializer block, found {count}")
    source = source.replace(old, new, 1)

TARGET.parent.mkdir(parents=True, exist_ok=True)
TARGET.write_text(source, encoding="utf-8")
print("RC9_MATERIALIZER_ANCHORS_FIXED")
