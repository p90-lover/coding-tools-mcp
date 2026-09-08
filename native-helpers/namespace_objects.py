"""Use application-owned OS object identities; never rewrite an installed Codex sandbox."""
from pathlib import Path
import re
import shutil
import sys
import uuid

crate = Path(sys.argv[1]).resolve()
backup = crate.parents[1] / 'aiTemp/Trash/namespace-originals'

def save(name, text):
    path = crate / name
    original = path.read_text(encoding='utf-8')
    assert text != original, name
    target = backup / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists(): shutil.copy2(path, target)
    path.write_text(text, encoding='utf-8')

for name in ['src/bin/setup_main/win/firewall.rs', 'src/uninstall_windows/firewall.rs']:
    text = (crate / name).read_text(encoding='utf-8')
    assert text.count('"codex_sandbox_offline_') == 4, name
    save(name, text.replace('"codex_sandbox_offline_', '"coding_tools_mcp_sandbox_offline_'))
for name in ['src/bin/command_runner/win.rs', 'src/bin/setup_main/win/read_acl_mutex.rs']:
    text = (crate / name).read_text(encoding='utf-8')
    assert text.count('CodexSandboxReadAcl') == 1, name
    save(name, text.replace('CodexSandboxReadAcl', 'CodingToolsMcpSandboxReadAcl'))
old_ids, new_ids = set(), set()
for name, count in [('src/wfp.rs', 2), ('src/wfp/filter_specs.rs', 12)]:
    text = (crate / name).read_text(encoding='utf-8')
    def remap(match):
        original = match.group(1).replace('_', '')
        assert len(original) == 32 and original not in old_ids
        value = uuid.uuid5(uuid.NAMESPACE_URL, 'https://github.com/p90-lover/coding-tools-mcp/windows-sandbox/' + original).hex
        assert value not in new_ids and value != original
        old_ids.add(original); new_ids.add(value)
        return 'GUID::from_u128(0x' + value + ')'
    text, actual = re.subn(r'GUID::from_u128\(0x([0-9a-f_]{36})\)', remap, text)
    assert actual == count, (name, actual)
    text = text.replace('Codex Windows Sandbox WFP', 'Coding Tools MCP Sandbox WFP')
    text = text.replace('Codex Windows sandbox filters', 'Coding Tools MCP Windows sandbox filters')
    save(name, text)
assert len(old_ids) == 14 and old_ids.isdisjoint(new_ids)
print('Namespaced four firewall rules, fourteen WFP identities and the read-ACL mutex')
