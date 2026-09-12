"""Scoped repairs after reproduced failures; preserve originals and existing jobs."""
from pathlib import Path
import os,shutil,subprocess
changed=[]
def save(name,text):
 p=Path(name)
 if p.read_text(encoding='utf-8')==text:return
 backup=Path('aiTemp/Trash/load-before')/os.environ['GITHUB_RUN_ID']/name
 backup.parent.mkdir(parents=True,exist_ok=True)
 assert not backup.exists() and not p.is_symlink()
 shutil.copy2(p,backup);p.write_text(text,encoding='utf-8');changed.append(name)
def once(name,old,new):
 text=Path(name).read_text(encoding='utf-8')
 if new in text:return
 assert text.count(old)==1,(name,text.count(old),old[:80])
 save(name,text.replace(old,new,1))
once('src-tauri/src/mcp/mod.rs','mod listener;','mod listener;\npub(crate) mod request_log;')
once('src-tauri/src/mcp/listener.rs','use crate::tunnel::append_profile_log;','use super::request_log::append_profile_log;')
once('src-tauri/src/tunnel/supervisor.rs','''            if platform().find_pid_listening_on_port(port).ok().flatten()
                != Some(std::process::id())
            {
                budget.block("local_runtime_not_owned");
                continue;
            }
''','''            match platform().find_pid_listening_on_port(port) {
                Ok(Some(owner)) if owner == std::process::id() => {},
                Ok(_) => {
                    // A completed lookup establishes no owned local listener.
                    // Keep the fail-closed, explicit-start boundary unchanged.
                    budget.block("local_runtime_not_owned");
                    continue;
                }
                Err(_) => {
                    // OS enumeration can fail transiently. Unknown is not proof
                    // of a foreign owner: defer without starting any process,
                    // consuming a restart attempt or permanently blocking healing.
                    append_profile_log(&key.0, "connection-recovery.log",
                        "[recovery] ownership check unavailable; deferred; no restart or permanent block");
                    continue;
                }
            }
''')
once('src-tauri/src/commands/task_monitor.rs','"history":observed,"operations":runtime["operations"],','"history":observed,"request_log_diagnostics":crate::mcp::request_log::status(),"operations":runtime["operations"],')
name='src/routes/tasks/+page.svelte'
once(name,'type Snapshot = { workspace_id:string;', 'type Snapshot = { request_log_diagnostics?:{pending:number;dropped:number;truncated?:number;writer_available:boolean}; workspace_id:string;')
once(name,'    <div class="metrics">','''    {#if snapshot.request_log_diagnostics && (snapshot.request_log_diagnostics.pending > 32 || snapshot.request_log_diagnostics.dropped > 0)}
      <p class="cc-notice amber" role="status">{t($locale,'Diagnostic trace backlog','診斷追蹤積壓')}: {snapshot.request_log_diagnostics.pending} {t($locale,'pending','項等待')} · {snapshot.request_log_diagnostics.dropped} {t($locale,'omitted under backpressure. Tool outcomes must be checked in operation receipts, not inferred from missing logs.','項因佇列滿而未記錄。工具結果須查操作紀錄，不能從缺少日誌推斷。')}</p>
    {/if}
    <div class="metrics">''')
for name in ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','README.md','README.en.md']:
 text=Path(name).read_text(encoding='utf-8')
 if '0.4.5' in text:save(name,text.replace('0.4.5','0.4.6'))
for name in changed+['src-tauri/src/mcp/request_log.rs']:
 if name.endswith('.rs'):subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*changed,'src-tauri/src/mcp/request_log.rs'],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('LOAD_PATCH: MCP traces isolated from slow I/O; transient ownership errors defer safely; no auth changes, job restarts or branch merges')
