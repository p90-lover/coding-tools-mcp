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
# Dedicated helper binary, not the Codex CLI or an agent. Workspace dependency pins remain intact.
p=crate/'Cargo.toml';with_bin=p.read_text(encoding='utf-8')+'\n[[bin]]\nname = "coding-tools-codex-sandbox"\npath = "src/bin/coding_tools_bridge.rs"\n'
patch('Cargo.toml',p.read_text(encoding='utf-8'),with_bin)
shutil.copy2(source,crate/'src/bin/coding_tools_bridge.rs')
print('Prepared pinned sandbox-only library adapter; no Codex executable invoked')
