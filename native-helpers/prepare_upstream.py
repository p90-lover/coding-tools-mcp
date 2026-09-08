"""Apply only reviewed adapter patches to the immutable upstream checkout in aiTemp."""
from pathlib import Path
import hashlib, shutil, subprocess, sys
root=Path(sys.argv[1]).resolve();source=Path(sys.argv[2]).resolve()
assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()=='3caf9f9586baedb4158a7b91545ead3dd320c348'
crate=root/'codex-rs/windows-sandbox-rs';backup=root/'aiTemp/Trash/adapter-originals'
def patch(name,old,new):
    p=crate/name;s=p.read_text(encoding='utf-8');assert old in s,name
    b=backup/name
    if not b.exists():b.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,b)
    p.write_text(s.replace(old,new),encoding='utf-8')
patch('src/setup.rs','"CodexSandboxOffline"','"CTMcpSandboxOffline"')
patch('src/setup.rs','"CodexSandboxOnline"','"CTMcpSandboxOnline"')
patch('src/winutil.rs','"CodexSandboxUsers"','"CodingToolsMcpSandboxUsers"')
patch('src/setup.rs', '''fn run_elevated_setup_inner(
    request: SandboxSetupRequest<'_>,
    offline_proxy_settings_override: Option<&OfflineProxySettings>,
) -> Result<()> {''','''fn run_elevated_setup_inner(
    request: SandboxSetupRequest<'_>,
    offline_proxy_settings_override: Option<&OfflineProxySettings>,
) -> Result<()> {
    // Adapter boundary: MCP execution never launches UAC or repairs OS accounts.
    if std::env::var("CODING_TOOLS_LOCAL_SANDBOX_SETUP").as_deref() != Ok("1") {
        anyhow::bail!("Sandbox provisioning/repair must be initiated in the local desktop UI");
    }''')
patch('src/elevated_impl.rs','OutputStream::Stdout => stdout.extend_from_slice(&bytes),','OutputStream::Stdout => { let n = bytes.len().min(262144usize.saturating_sub(stdout.len())); stdout.extend_from_slice(&bytes[..n]); },')
patch('src/elevated_impl.rs','OutputStream::Stderr => stderr.extend_from_slice(&bytes),','OutputStream::Stderr => { let n = bytes.len().min(262144usize.saturating_sub(stderr.len())); stderr.extend_from_slice(&bytes[..n]); },')
p=crate/'src/logging.rs';s=p.read_text(encoding='utf-8');start=s.index('fn preview(command: &[String]) -> String {');end=s.index('\n}\n',start)+2
patch('src/logging.rs',s[start:end],'''fn preview(_command: &[String]) -> String {
    "[sandbox command arguments omitted]".to_string()
}''')

# Preserve old owned files at the adapter boundary; keep NT/ACL protections intact.
module=source.parent/'retained_files.rs'
assert module.is_file(), 'Missing preservation adapter source'
shutil.copy2(module,crate/'src/retained_files.rs')
patch('src/lib.rs', '#[cfg(target_os = "windows")]\nmod file_write;', '#[cfg(target_os = "windows")]\nmod file_write;\n#[cfg(target_os = "windows")]\npub mod retained_files;')
for name,old,new in [
    ('src/env.rs','fs::remove_file(&p)','crate::retained_files::preserve_owned_file(&p)'),
    ('src/identity.rs','fs::remove_file(&path)','crate::retained_files::preserve_owned_file(&path)'),
    ('src/helper_materialization.rs','fs::remove_file(destination)','crate::retained_files::preserve_owned_file(destination)'),
    ('src/setup_error.rs','fs::remove_file(&path)','crate::retained_files::preserve_owned_file(&path)'),
    ('src/bin/setup_main/win/sandbox_users.rs','std::fs::remove_file(&marker_path)','codex_windows_sandbox::retained_files::preserve_owned_file(&marker_path)'),
    ('src/bin/setup_main/win.rs','std::fs::remove_file(&legacy_users)','codex_windows_sandbox::retained_files::preserve_owned_file(&legacy_users)'),
]: patch(name,old,new)
# Never remove an unexpected regular directory to create a working-directory link.
patch('src/bin/command_runner/win/cwd_junction.rs', 'std::fs::remove_dir(&junction_path)', 'Err::<(), _>(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Existing directory retained; junction replacement refused"))')
# Maintenance uninstall is deliberately unavailable in this bundled helper API.
p=crate/'src/uninstall_windows.rs';s=p.read_text(encoding='utf-8');i=s.index('    let _setup_lock =');j=s.rindex('\n}')
patch('src/uninstall_windows.rs',s[i:j], '    let _ = (codex_home, clean_up_desktop);\n    anyhow::bail!("Adapter preserves existing files and accounts; destructive uninstall is not exposed")')
# Keep NT directory-pin guard files, rather than deleting them on handle close.
patch('src/no_reparse_dir.rs','FILE_NON_DIRECTORY_FILE | FILE_DELETE_ON_CLOSE,','FILE_NON_DIRECTORY_FILE,')
# Secure atomic-output errors retain the exact owned file handle in Trash.
p=crate/'src/file_write.rs';s=p.read_text(encoding='utf-8');i=s.index('    if result.is_err() {');j=s.index('    result.with_context',i)
patch('src/file_write.rs',s[i:j], '    if result.is_err() {\n        use std::os::windows::io::AsHandle;\n        let _ = crate::retained_files::preserve_open_file(parent, file.as_handle());\n    }\n')
# Temp helpers live in a no-reparse aiTemp child, and keep() disables implicit deletion.
patch('src/helper_materialization.rs','    let temp_path = NamedTempFile::new_in(destination_dir)', '''    let temp_dir = destination_dir.join("aiTemp");
    let _temp_directory = crate::open_directory_no_reparse(
        &temp_dir,
        windows_sys::Win32::Storage::FileSystem::FILE_TRAVERSE | windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES,
        windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE,
        crate::DirectoryOpenDisposition::OpenOrCreate,
    )?;
    let temp_path = NamedTempFile::new_in(&temp_dir)''')
patch('src/helper_materialization.rs','        .into_temp_path();','        .into_temp_path().keep().context("Retain temporary helper file")?;')
print('Applied no-delete maintenance adapter; retained files remain under protected Trash directories')

# Dedicated helper binary, not the Codex CLI or an agent. Workspace dependency pins remain intact.
p=crate/'Cargo.toml';with_bin=p.read_text(encoding='utf-8')+'\n[[bin]]\nname = "coding-tools-codex-sandbox"\npath = "src/bin/coding_tools_bridge.rs"\n'
patch('Cargo.toml',p.read_text(encoding='utf-8'),with_bin)
shutil.copy2(source,crate/'src/bin/coding_tools_bridge.rs')
print('Prepared pinned sandbox-only library adapter; no Codex executable invoked')
