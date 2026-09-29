"""Small local documentation gate: language pairs, real links and tool names."""
from pathlib import Path
import re
files = [Path('README.en.md'), Path('README.md'), Path('docs/guides/ai-human-workflow.en.md'), Path('docs/guides/ai-human-workflow.zh-Hant.md')]
for p in files:
    text = p.read_text(encoding='utf-8')
    assert text.startswith('# '), p
    assert text.count('```') % 2 == 0, p
    assert 'policy_only' in text and 'Codex' in text, p
    assert 'history_session_checkpoint' in text, p
    for target in re.findall(r'\]\(([^)]+)\)', text):
        if target.startswith(('https://','http://','#','mailto:')):
            continue
        target = target.split('#',1)[0]
        assert (p.parent / target).exists(), (str(p), target)
    if p.name.endswith('.en.md'):
        assert 'human' in text.lower() and 'weights' in text.lower(), p
    else:
        assert '人類' in text and '權重' in text and '繁體中文' in text, p
names = ['codex_tools_status','tool_search','get_current_time','get_plan','update_plan']
registry = Path('src-tauri/src/tools/registry_definitions.rs').read_text(encoding='utf-8')
handler = Path('src-tauri/src/tools/local_tools.rs').read_text(encoding='utf-8')
for name in names:
    assert f'"{name}"' in registry and f'"{name}"' in handler
    assert f'`{name}`' in files[0].read_text() and f'`{name}`' in files[1].read_text()
print('PASS: English/Traditional Chinese README and workflow guide, local links, fenced examples and implemented tool coverage')
