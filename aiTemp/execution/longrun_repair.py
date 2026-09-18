"""Apply only reproduced long-run fixes. Retain originals; never grant control."""
from pathlib import Path
import os,shutil,subprocess
changed=[]
def once(name,old,new):
 p=Path(name);s=p.read_text(encoding='utf-8')
 if new in s:return
 assert s.count(old)==1,(name,old[:80],s.count(old))
 backup=Path('aiTemp/Trash/execution-longrun')/os.environ['GITHUB_RUN_ID']/p
 if name not in changed:
  backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists() and not p.is_symlink();shutil.copy2(p,backup);changed.append(name)
 p.write_text(s.replace(old,new,1),encoding='utf-8')
p='src-tauri/src/integrations/execution/model.rs'
once(p,'  self.pending=Some(key.into());self.phase=phase;self.revision=next;', '''  self.pending=Some(key.into());self.phase=phase;self.revision=next;
  // Count admission, not receipt delivery. An unanswered start can already have
  // finished remotely; a later idle observation must require review, not restart.
  if matches!(action,Action::Start|Action::Resume){self.attempts+=1;}''')
once(p,'let mut attempts=self.attempts;','let attempts=self.attempts;')
once(p,'attempts=attempts.checked_add(1).ok_or("Attempt counter exhausted")?;','// Attempt was already counted before transmission.\n')
once(p,'let phase=if self.phase==Phase::Accepted {Phase::Accepted}', '''let phase=if self.phase==Phase::Accepted && o.quiescent
      && self.run_id==o.run_id && self.last_status.as_deref()==Some(o.status.as_str()) {Phase::Accepted}''')
p='src-tauri/src/integrations/execution/transport.rs'
once(p,'Action::Close=>if value["task"]["id"].as_str()!=request.record_id.as_deref()||!value["task"]["archivedAt"].is_string()', 'Action::Close=>if value["id"].as_str()!=request.record_id.as_deref()||!value["archivedAt"].is_string()')
p='src/lib/components/ComputerOverlay.svelte'
once(p,"  let mode = $state('live');","  let mode = $state('agent');\n  let previewEpoch = 0;")
once(p,"if (result.session_id !== status.session_id) { agentFrame = null; liveFrame = null; }","if (result.session_id !== status.session_id) { previewEpoch++; agentFrame = null; liveFrame = null; }")
once(p,"} catch (e) { status = { state: 'stopped' }; agentFrame = null; liveFrame = null; message = String(e); }", "} catch (e) { previewEpoch++; status = { state: 'unavailable' }; agentFrame = null; liveFrame = null; message = String(e); }")
once(p,"    if (status.state !== 'active') return;\n    const sessionId = status.session_id;", "    if (mode !== 'live' || document.hidden || status.state !== 'active' || status.action) return;\n    const sessionId = status.session_id, epoch = previewEpoch;")
once(p,"if (status.state === 'active' && status.session_id === sessionId) { liveFrame = result; message = ''; }", "if (mode === 'live' && !document.hidden && epoch === previewEpoch && status.state === 'active' && status.session_id === sessionId) { liveFrame = result; message = ''; }")
once(p,"  async function stop() {\n    try", "  async function stop() {\n    previewEpoch++;agentFrame=null;liveFrame=null;\n    try")
once(p,"  async function pause() { try", "  async function pause() { previewEpoch++;agentFrame=null;liveFrame=null;try")
once(p,"return () => { disposed = true; clearInterval(heartbeat); clearInterval(images); };", "return () => { previewEpoch++;disposed = true; clearInterval(heartbeat); clearInterval(images); };")
p='src/lib/computer-view.js'
once(p,"export function controlLabel(status) {", "export function controlLabel(status) {\n  if (status?.state === 'unavailable') return 'Status unavailable — use Stop to revoke · 狀態未確認，可按停止撤銷';")
p='src/lib/components/ComputerControl.svelte'
once(p,'    <legend class="mb-2 font-medium">Local approval · 本機授權</legend>', '''    <legend class="mb-2 font-medium">Local approval · 本機授權</legend>
    <button type="button" class="tx-btn-secondary" onclick={()=>{alwaysEnabled=true;rememberApp=true;restoreOnStart=true;}}>Long-task preset · 長任務設定</button>
    <p class="text-xs opacity-70">Preset selects Always enabled + Remember app + Restore after restart. Access is granted only after you select a window and confirm Enable. Stop/Pause still suspend restoration. · 設定會勾選持續啟用、記住程式及重啟恢復；選擇視窗並確認啟用後才授權。停止／暫停仍會阻止自動恢復。</p>''')
for name in changed:
 if name.endswith('.rs'):subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*changed],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('LONGRUN_REPAIRS: admitted attempts retained; real archive response; passive exact-frame default; preview load reduced without relaxing input consent')
