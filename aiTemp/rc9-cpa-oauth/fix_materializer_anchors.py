from __future__ import annotations

from pathlib import Path

SOURCE = Path("aiTemp/rc9-cpa-oauth/apply_patch.py")
REPAIRS = Path("aiTemp/rc9-cpa-oauth/apply_regression_repairs.py")
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

newline_join_anchor = 'join("\\n")'
newline_join_count = source.count(newline_join_anchor)
if newline_join_count < 6:
    raise SystemExit(f"expected at least six model-list join anchors, found {newline_join_count}")
source = source.replace(newline_join_anchor, 'join("\\\\n")')

repairs = REPAIRS.read_text(encoding="utf-8")
repairs = repairs.replace("from __future__ import annotations\n\n", "", 1)
repair_root = "ROOT = Path(__file__).resolve().parents[2]"
if repairs.count(repair_root) != 1:
    raise SystemExit(f"expected one repair-root anchor, found {repairs.count(repair_root)}")
repairs = repairs.replace(repair_root, "ROOT = Path(__file__).resolve().parents[3]", 1)

sequence_old = '''path = ROOT / "desktop-electron/electron/cpa-oauth-adapter.cjs"
source = path.read_text(encoding="utf-8")
old_sequence = \'\'\'      boundAuthFileId,
      identity,
      requireBound,
\'\'\'
new_sequence = \'\'\'      boundAuthFileId,
      boundAuthFileName,
      boundAuthFileIndex,
      identity,
      requireBound,
\'\'\'
count = source.count(old_sequence)
if count != 2:
    raise SystemExit(f"expected two CPA login resolution anchors, found {count}")
source = source.replace(old_sequence, new_sequence)
'''
sequence_new = '''path = ROOT / "desktop-electron/electron/cpa-oauth-adapter.cjs"
source = path.read_text(encoding="utf-8")
import_old = \'\'\'      boundAuthFileId,
      identity,
      requireBound,
\'\'\'
import_new = \'\'\'      boundAuthFileId,
      boundAuthFileName,
      boundAuthFileIndex,
      identity,
      requireBound,
\'\'\'
if source.count(import_old) != 1:
    raise SystemExit(f"expected one CPA import resolution anchor, found {source.count(import_old)}")
source = source.replace(import_old, import_new, 1)
oauth_old = \'\'\'        boundAuthFileId,
        identity,
        requireBound,
\'\'\'
oauth_new = \'\'\'        boundAuthFileId,
        boundAuthFileName,
        boundAuthFileIndex,
        identity,
        requireBound,
\'\'\'
if source.count(oauth_old) != 1:
    raise SystemExit(f"expected one CPA OAuth resolution anchor, found {source.count(oauth_old)}")
source = source.replace(oauth_old, oauth_new, 1)
'''
if repairs.count(sequence_old) != 1:
    raise SystemExit(f"expected one CPA resolution repair block, found {repairs.count(sequence_old)}")
repairs = repairs.replace(sequence_old, sequence_new, 1)
source += "\n\n# Post-materialization regression repairs.\n" + repairs

TARGET.parent.mkdir(parents=True, exist_ok=True)
TARGET.write_text(source, encoding="utf-8")
print("RC9_MATERIALIZER_ANCHORS_FIXED")
