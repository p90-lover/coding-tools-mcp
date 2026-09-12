"""Materialize only the reviewed updater, navigation, registration and version edits.
Existing originals are retained under aiTemp/Trash; no cleanup or model invocation.
"""
from pathlib import Path
import json,os,shutil,subprocess
root=Path.cwd();backup=root/'aiTemp/Trash/task-monitor-before'/os.environ['GITHUB_RUN_ID']
def save(name,text):
    path=root/name
    if path.read_text(encoding='utf-8')==text:return
    before=backup/name;before.parent.mkdir(parents=True,exist_ok=True)
    assert not path.is_symlink()
    if not before.exists():shutil.copy2(path,before)
    path.write_text(text,encoding='utf-8')
    subprocess.run(['git','add','--',name],check=True)
def once(name,old,new):
    text=(root/name).read_text(encoding='utf-8')
    if new in text:return
    assert text.count(old)==1,(name,old,text.count(old))
    save(name,text.replace(old,new,1))
name='src-tauri/src/update/mod.rs';text=(root/name).read_text(encoding='utf-8')
if 'semver::Version::parse' not in text:
    start=text.index('/// Compare two semver-like');end=text.index('pub fn parse_latest_release(')
    save(name,text[:start]+'''/// Compare release precedence, including numeric prerelease identifiers.
/// Build metadata is not part of precedence; malformed versions are rejected.
pub fn compare_versions(left: &str, right: &str) -> Option<Ordering> {
    let mut left = semver::Version::parse(&normalize_tag(left)).ok()?;
    let mut right = semver::Version::parse(&normalize_tag(right)).ok()?;
    left.build = semver::BuildMetadata::EMPTY;
    right.build = semver::BuildMetadata::EMPTY;
    Some(left.cmp(&right))
}

'''+text[end:])
once('src-tauri/Cargo.toml','serde_json = "1"','serde_json = "1"\nsemver = "1"')
for name in ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','README.md','README.en.md']:
    text=(root/name).read_text(encoding='utf-8');save(name,text.replace('0.4.4-rc.5','0.4.5'))
name='src-tauri/Cargo.lock';text=(root/name).read_text(encoding='utf-8');start=text.index('name = "coding-tools-mcp-desktop"');end=text.index('\n[[package]]',start);chunk=text[start:end]
if ' "semver",' not in chunk:
    assert chunk.count(' "serde",')==1
    chunk=chunk.replace(' "serde",',' "semver",\n "serde",');save(name,text[:start]+chunk+text[end:])
once('src-tauri/src/harness/state.rs','\nfn workspace_id(root: &Path) -> String {','\npub(super) fn workspace_id(root: &Path) -> String {')
once('src-tauri/src/harness/mod.rs','pub mod tools;','pub mod tools;\npub(crate) mod monitor;')
name='src-tauri/src/harness/mod.rs';text=(root/name).read_text(encoding='utf-8')
if 'task-monitor/monitor_contract.rs' not in text:
    save(name,text+'\n#[cfg(test)]\ninclude!(concat!(env!("CARGO_MANIFEST_DIR"), "/../aiTemp/task-monitor/monitor_contract.rs"));\n')
once('src-tauri/src/commands/mod.rs','mod control_center;','mod task_monitor;\npub use task_monitor::task_monitor_read;\nmod control_center;')
once('src-tauri/src/lib.rs','\n    update_workspace,\n','\n    task_monitor_read, update_workspace,\n')
once('src-tauri/src/lib.rs','            control_board_change,','            control_board_change,\n            task_monitor_read,')
once('src/routes/work/+page.svelte','<header class="cc-page-heading">','<header class="cc-page-heading"><a class="cc-button ghost" href="/tasks">{t($locale, \'Task monitor\', \'任務監察\')}</a>')
once('src/lib/components/AppShell.svelte',"{path:'/sessions',en:'Agent sessions'","{path:'/tasks',en:'Task monitor',zh:'任務監察',icon:Monitor},{path:'/sessions',en:'Agent sessions'")
for name in ['src-tauri/src/update/mod.rs','src-tauri/src/commands/task_monitor.rs','src-tauri/src/harness/monitor.rs']:
    subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
    subprocess.run(['git','add','--',name],check=True)
assert json.loads(Path('package.json').read_text())['version']=='0.4.5'
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('TASK_MONITOR_SOURCE: main-window monitoring, bounded history, stable version and prerelease precedence connected; original files retained')
