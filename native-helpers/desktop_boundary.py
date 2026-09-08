"""Make private desktop access compatible with full read-restricted tokens."""
from pathlib import Path
import shutil
import sys

crate = Path(sys.argv[1]).resolve()
backup = crate.parents[1] / 'aiTemp/Trash/desktop-boundary-originals'
def replace(name, old, new):
    p = crate / name
    text = p.read_text(encoding='utf-8')
    assert text.count(old) == 1, f'Pinned desktop anchor changed: {name}'
    saved = backup / name
    if not saved.exists():
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, saved)
    p.write_text(text.replace(old, new), encoding='utf-8')

replace('src/desktop.rs',
    '    uses_write_capabilities: bool,\n',
    '    uses_write_capabilities: bool,\n    readonly_workspace_capability: Option<String>,\n')
replace('src/desktop.rs', '        Ok(Self {\n            uses_write_capabilities: request',
'''        Ok(Self {
            readonly_workspace_capability: if request.permissions.uses_write_capabilities_for_cwd(request.command_cwd, request.env_map) {
                None
            } else {
                Some(crate::cap::workspace_write_cap_sid_for_root(request.codex_home, request.command_cwd, request.command_cwd)?)
            },
            uses_write_capabilities: request''')
replace('src/desktop.rs', '        let policy = DesktopPolicy {\n',
    '        let policy = DesktopPolicy {\n            readonly_workspace_capability: None,\n')
replace('src/desktop.rs', '''    let sddl = to_wide(format!(
        "D:P(A;;0x{DESKTOP_ALL_ACCESS:x};;;{owner_user_sid})(A;;0x{DESKTOP_PARTICIPANT_ACCESS:x};;;{sandbox_sid})"
    ));''', '''    // The normal access check uses the sandbox user. The second, restricted
    // check needs this workspace's capability, not a shared platform capability
    // or Everyone. This does not grant access to the host Default desktop.
    let restricted_access = policy.readonly_workspace_capability.as_ref()
        .map(|sid| format!("(A;;0x{DESKTOP_PARTICIPANT_ACCESS:x};;;{sid})"))
        .unwrap_or_default();
    let sddl = to_wide(format!(
        "D:P(A;;0x{DESKTOP_ALL_ACCESS:x};;;{owner_user_sid})(A;;0x{DESKTOP_PARTICIPANT_ACCESS:x};;;{sandbox_sid}){restricted_access}"
    ));''')
replace('src/process.rs', '    let ok = CreateProcessAsUserW(\n', '''    // Loader errors must return an exit status, never wait on an invisible
    // system-error dialog in the private desktop. Children inherit this mode.
    let previous_error_mode = windows_sys::Win32::System::Diagnostics::Debug::SetErrorMode(0x0001 | 0x0002 | 0x8000);
    let ok = CreateProcessAsUserW(
''')
replace('src/process.rs', '''    if ok == 0 {
        let err = GetLastError() as i32;''', '''    let spawn_error = GetLastError();
    windows_sys::Win32::System::Diagnostics::Debug::SetErrorMode(previous_error_mode);
    if ok == 0 {
        let err = spawn_error as i32;''')
replace('src/desktop_tests.rs', '    let policy = DesktopPolicy {\n',
    '    let policy = DesktopPolicy {\n        readonly_workspace_capability: None,\n')
print('Applied workspace-only private desktop capability and non-modal loader errors')
