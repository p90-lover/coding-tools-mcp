"""Apply app-owned, fail-closed native network restrictions to pinned sandbox source.

Only the dedicated offline account is matched. Never alter global firewall state,
Codex-owned WFP identities, or the user's proxy/browser/network permissions.
"""
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

root=Path(sys.argv[1]).resolve()
assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()=='3caf9f9586baedb4158a7b91545ead3dd320c348'
crate=root/'codex-rs/windows-sandbox-rs'
backup=root/'aiTemp/Trash/before-app-network-policy'
def write(name,content):
    path=crate/name
    assert path.is_file() and not path.is_symlink()
    prior=backup/name
    prior.parent.mkdir(parents=True,exist_ok=True)
    assert not prior.exists(), 'Network adapter must run exactly once'
    shutil.copy2(path,prior)
    path.write_text(content,encoding='utf-8')
def identity(name):
    return '0x'+uuid.uuid5(uuid.NAMESPACE_URL,'https://github.com/p90-lover/coding-tools-mcp/native-sandbox/'+name).hex

path=crate/'src/wfp.rs';text=path.read_text(encoding='utf-8')
for old,new in [('0x2e31d31c_3948_4753_9117_e5d1a6496f41',identity('provider-v1')),('0xe65054fd_4d32_4c7c_95ef_621f0cf6431a',identity('sublayer-v1'))]:
    assert text.count(old)==1
    text=text.replace(old,new)
text=text.replace('Codex Windows Sandbox WFP','Coding Tools MCP Sandbox WFP')
text=text.replace('Codex Windows sandbox filters','Coding Tools MCP Windows sandbox filters')
write('src/wfp.rs',text)

path=crate/'src/wfp/filter_specs.rs';text=path.read_text(encoding='utf-8')
start=text.index('pub(super) const FILTER_SPECS: &[FilterSpec] = &[')
head=text[:start]
head='use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::{FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6};\n'+head
specs=[]
for suffix,layer in [('connect_v4','FWPM_LAYER_ALE_AUTH_CONNECT_V4'),('connect_v6','FWPM_LAYER_ALE_AUTH_CONNECT_V6'),('receive_v4','FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4'),('receive_v6','FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6')]:
    specs.append('''    FilterSpec {
        key: GUID::from_u128(%s),
        name: "coding_tools_mcp_offline_%s",
        description: "Deny dedicated sandbox account direct networking, including loopback",
        layer_key: %s,
        conditions: &[ConditionSpec::User],
    },
'''%(identity('offline-'+suffix+'-v1'),suffix,layer))
text=head+'// App policy permits no direct IP networking or proxy exceptions.\n// ALE user matching is mandatory; other desktop accounts remain unaffected.\npub(super) const FILTER_SPECS: &[FilterSpec] = &[\n'+''.join(specs)+'];\n'
assert text.count('conditions: &[ConditionSpec::User]')==4
write('src/wfp/filter_specs.rs',text)

path=crate/'src/bin/setup_main/win/firewall.rs';text=path.read_text(encoding='utf-8')
assert 'codex_sandbox_offline' in text
write('src/bin/setup_main/win/firewall.rs',text.replace('codex_sandbox_offline','coding_tools_mcp_offline'))

# Offline WFP enforcement is mandatory, not best effort.
path=crate/'src/bin/setup_main/win.rs';text=path.read_text(encoding='utf-8')
old='''    if repairing_disabled_accounts {
        // Ordinary setup keeps its best-effort WFP behavior. Recovery must not reopen logons
        // after cleanup removed protections unless restoring those protections succeeded.
        wfp_result?;'''
new='''    // Never write a successful setup marker or re-enable an account if the
    // mandatory app-owned direct-network filters could not install.
    wfp_result?;
    if repairing_disabled_accounts {'''
assert text.count(old)==1
write('src/bin/setup_main/win.rs',text.replace(old,new))

# Old development provisioning must not be accepted as proof of the new policy.
# Only the explicit local preparation UI can create the new setup marker.
path=crate/'src/setup.rs';text=path.read_text(encoding='utf-8')
old='pub const SETUP_VERSION: u32 = 5;'
assert text.count(old)==1
write('src/setup.rs',text.replace(old,'pub const SETUP_VERSION: u32 = 1006;'))
print('Applied app-owned IPv4/IPv6 ALE connect/receive denial; successful WFP installation and fresh local provisioning are mandatory')
