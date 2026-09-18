from __future__ import annotations

from pathlib import Path


def replace_once(pathname: str, old: str, new: str) -> None:
    path = Path(pathname)
    source = path.read_text(encoding="utf-8")
    if new in source and old not in source:
        return
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"expected one repair anchor in {pathname}, found {count}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


replace_once(
    "src/lib/orchestrator-center.ts",
    "  'archived' | 'revision' | 'updated_at'\n> & { id: string | null };",
    "  'id' | 'archived' | 'revision' | 'updated_at'\n> & { id: string | null };",
)

replace_once(
    "src/lib/provider-center.ts",
    "  'generation' | 'revision' | 'updated_at' | 'archived'\n> & { id: string | null };",
    "  'id' | 'generation' | 'revision' | 'updated_at' | 'archived'\n> & { id: string | null };",
)

replace_once(
    "src/lib/components/AppShell.svelte",
    "onclick={async()=>{try{await openUrl(REPO_URL);}catch{repoError='Open the repository from your browser. / 請在瀏覽器開啟儲存庫。';}}><Github",
    "onclick={async()=>{try{await openUrl(REPO_URL);}catch{repoError='Open the repository from your browser. / 請在瀏覽器開啟儲存庫。';}}}><Github",
)

replace_once(
    "src/lib/components/control-center/OriginalUiPanel.svelte",
    "if (tool && !selected) selected = tool.long_run?.selected_section || tool.sections[0] ?? '';",
    "if (tool && !selected) selected = (tool.long_run?.selected_section || tool.sections[0]) ?? '';",
)

old_button = """    <button class=\"cc-button primary\" type=\"button\" disabled={busy !== null || service?.status === 'ready'} onclick={() => void run('start', async () => { onCatalog({ version: catalog?.version ?? 1, tools: (catalog?.tools ?? []).map((candidate) => candidate.id === 'commandcode-proxy' ? await invoke<FiveStackSnapshot>('five_stack_start', { toolId: 'commandcode-proxy' }) : candidate) }); })}>{t($locale, 'Start', '啟動')}</button>"""
new_button = """    <button class=\"cc-button primary\" type=\"button\" disabled={busy !== null || service?.status === 'ready'} onclick={() => void run('start', async () => {
      const next = await invoke<FiveStackSnapshot>('five_stack_start', { toolId: 'commandcode-proxy' });
      onCatalog({
        version: catalog?.version ?? 1,
        tools: (catalog?.tools ?? []).map((candidate) => candidate.id === 'commandcode-proxy' ? next : candidate),
      });
    })}>{t($locale, 'Start', '啟動')}</button>"""
replace_once(
    "src/lib/components/control-center/CommandCodeProxyPanel.svelte",
    old_button,
    new_button,
)

print("RC11_CPA_FRONTEND_REPAIR_APPLIED")
