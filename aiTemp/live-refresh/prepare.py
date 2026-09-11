"""Apply approved live-refresh fixes; preserve every replaced source file."""
from pathlib import Path
import os,shutil,subprocess
changed=set()
def save(name,text):
 p=Path(name)
 if p.read_text(encoding='utf-8')==text:return
 backup=Path('aiTemp/Trash/live-refresh-before')/os.environ['GITHUB_RUN_ID']/name
 backup.parent.mkdir(parents=True,exist_ok=True)
 assert not backup.exists() and not p.is_symlink()
 shutil.copy2(p,backup);p.write_text(text,encoding='utf-8');changed.add(name)
def once(s,old,new):
 assert s.count(old)==1,(old[:100],s.count(old))
 return s.replace(old,new,1)
# Baseline errors are propagated through every authority-producing caller.
p='src-tauri/src/harness/state.rs';s=Path(p).read_text()
s=s.replace('use std::fs;','#[cfg(test)]\nuse std::fs;').replace('use std::process::Command;\n','').replace('use walkdir::WalkDir;\n','')
s=s.replace('capture_baseline(&self.workspace_root);','capture_baseline(&self.workspace_root)?;')
s=s.replace('capture_baseline(&self.workspace_root).worktree_fingerprint','capture_baseline(&self.workspace_root)?.worktree_fingerprint')
a=s.index('pub fn capture_baseline(');b=s.index('\nfn workspace_id(',a)
s=s[:a]+'''pub fn capture_baseline(root: &Path) -> HarnessResult<ProjectBaseline> {
    super::bounded_scan::capture(root)
}
'''+s[b:]
s=s.replace('    BaselineEntry, CapabilityStatus,','    CapabilityStatus,')
# clean must refer to the full scanned result, never just its truncated display.
s=once(s,'        let truncated = files.len() > max_files.max(1);','        let clean = files.iter().all(|f| f.status == "unchanged");\n        let truncated = files.len() > max_files.max(1);')
s=once(s,'            clean: files.iter().all(|f| f.status == "unchanged"),','            clean,')
save(p,s)
p='src-tauri/src/harness/mod.rs';s=Path(p).read_text();s+='\npub(crate) mod bounded_scan;\n#[cfg(test)]\ninclude!(concat!(env!("CARGO_MANIFEST_DIR"), "/../aiTemp/live-refresh/scan_contract.rs"));\n';save(p,s)
# Freeze approved mappings per request; subsequent requests always load new mappings.
p='src-tauri/src/tools/workspace.rs';s=Path(p).read_text()
s=once(s,'pub struct Workspace {\n    root: PathBuf,\n}','pub struct Workspace {\n    root: PathBuf,\n    linked_snapshot: Option<Vec<LinkedProject>>,\n}')
s=once(s,'        Ok(Self { root })','        Ok(Self { root, linked_snapshot: None })')
s=once(s,'''        list_linked_projects_for_root(&self.root)
    }

    fn linked_project_by_alias''','''        self.linked_snapshot.clone().unwrap_or_else(|| list_linked_projects_for_root(&self.root))
    }

    pub fn request_snapshot(&self) -> Self {
        Self { root: self.root.clone(), linked_snapshot: Some(list_linked_projects_for_root(&self.root)) }
    }

    pub fn roots_revision(&self) -> String {
        use sha2::{Digest,Sha256};
        let mut hash=Sha256::new();
        hash.update(self.root.to_string_lossy().as_bytes());
        for project in self.linked_projects() {
            for value in [&project.alias,&project.name,&project.path,&project.mode] {
                hash.update((value.len() as u64).to_le_bytes());hash.update(value.as_bytes());
            }
        }
        format!("{:x}",hash.finalize())
    }

    pub fn ensure_roots_current(&self) -> WorkspaceResult<()> {
        if self.linked_snapshot.as_ref().is_some_and(|roots| *roots != list_linked_projects_for_root(&self.root)) {
            return Err(WorkspaceError::Tool {code:"WORKSPACE_ROOTS_CHANGED",message:"Approved project mappings changed during this request. Inspect state before reassessing; an already-submitted effect cannot be undone and must not be automatically replayed.".into(),category:"permission",retryable:false});
        }
        Ok(())
    }

    fn linked_project_by_alias''')
for signature in ['    pub fn resolve_read_path(&self, raw_path: &str) -> WorkspaceResult<ResolvedPath> {','    pub fn resolve_for_write(&self, raw_path: &str) -> WorkspaceResult<ResolvedPath> {']:
 s=once(s,signature,signature+'\n        self.ensure_roots_current()?;')
s=once(s,'''    ) -> WorkspaceResult<ResolvedPath> {
        let raw = if raw_path.is_empty() { "." } else { raw_path };''','''    ) -> WorkspaceResult<ResolvedPath> {
        self.ensure_roots_current()?;
        let raw = if raw_path.is_empty() { "." } else { raw_path };''')
save(p,s)
p='src-tauri/src/workspace/linked_projects.rs';s=Path(p).read_text()
s=once(s,'            .cmp(&b.name.to_ascii_lowercase())','            .cmp(&b.name.to_ascii_lowercase()).then_with(|| a.alias.cmp(&b.alias))')
# Reject line-injection before producing an explicitly approved mapping.
s=once(s,'    let base_alias = slugify(&name);','''    if name.contains(['\\r','\\n']) || friendly_path(&target).contains(['\\r','\\n']) {
        return Err(AppError::Message("Linked project names and paths cannot contain newlines".into()));
    }
    let base_alias = slugify(&name);''')
save(p,s)
p='src-tauri/src/tools/live_policy.rs';s=Path(p).read_text()
s=once(s,'        request.permission_mode = request.policy.canonical_permission_mode().into();','''        drop(live); // Never hold the policy lock while reading filesystem mappings.
        request.workspace = self.workspace.request_snapshot();
        let cwd = request.default_cwd_path();
        if cwd != request.workspace.root()
            && request.workspace.resolve_existing(&cwd.to_string_lossy()).is_err() {
            request.set_default_cwd(request.workspace.root().to_path_buf());
        }
        request.permission_mode = request.policy.canonical_permission_mode().into();''')
s=once(s,'        let guard = self.live_policy.read().map_err(|_| unavailable())?;','        self.workspace.ensure_roots_current()?;\n        let guard = self.live_policy.read().map_err(|_| unavailable())?;')
s=once(s,'    !name.starts_with("computer_")','    !refreshable_observation(name)\n        && !name.starts_with("computer_")')
pos=s.index('pub fn fence_entire_call(')
s=s[:pos]+'''pub fn refreshable_observation(name: &str) -> bool {
    matches!(name,"project_state"|"harness_status"|"read_file"|"search_text"|"grep_text"|"grep"|"list_dir"|"list_files")
}

'''+s[pos:]
save(p,s)
p='src-tauri/src/tools/dispatch.rs';s=Path(p).read_text()
s=once(s,'    let mut result = call_tool_snapshot(ctx, name, args);','''    let mut result = call_tool_snapshot(ctx, name, args);
    if crate::tools::live_policy::refreshable_observation(name)
        && ctx.current_policy_revision().ok()!=Some(ctx.policy_revision) {
        return tool_err_code("PERMISSION_CHANGED_DURING_READ","Live permissions changed during this observation; its result was withheld. Reassess under the new policy.","permission");
    }
    if let Err(error)=ctx.workspace.ensure_roots_current() { return tool_err(error); }
''')
s=once(s,'    if name == "server_info" {','''    if name == "server_info" {
        result["workspace_refresh"] = json!({"supported":true,"roots_revision":ctx.workspace.roots_revision(),"scope":"primary workspace and explicitly linked projects","reconnect_required":false,"new_root_access_inherits_live_policy":true,"external_process_revocation_on_manual_mapping_edit":false});
        result["long_task_limits"] = json!({"baseline_file_bytes":33554432,"baseline_total_bytes":134217728,"baseline_entries":20000,"baseline_cooperative_deadline_seconds":8,"use_command_id_for_long_processes":true,"automatic_operation_replay":false});''')
a=s.index('    if let Ok(mut status) = ctx.harness.status() {',s.index('fn attach_harness_status('));b=s.index('\n    output\n}',a)
s=s[:a]+'''    // Never turn a quick error or a baseline timeout into another full scan.
    let task=ctx.harness.current_task().ok().flatten();
    if let Some(object)=output.as_object_mut() {
        object.insert("harness".into(),json!({"task_id":task.as_ref().map(|t|&t.id),"baseline_matches":null,"writable":null,"status":"not_rescanned","reason":"Error recovery does not rescan the entire project. Inspect the original error or existing operation receipt.","next_actions":filter_exposed_actions(ctx,vec!["task_context".into(),"mcp_operation_status".into()])}));
    }
    if standalone { attach_standalone_metadata(&mut output,"Inspect the recorded error or command output; do not repeat an unchanged failing operation."); }
'''+s[b:]
save(p,s)
p='src-tauri/src/mcp/listener.rs';s=Path(p).read_text();s+='\n#[cfg(test)]\n#[path="../../../aiTemp/live-refresh/http_contract.rs"]\nmod live_refresh_contract;\n';save(p,s)
# UI applies explicit control changes, never hydration/defaults; one save at a time.
p='src/lib/components/RuntimePolicyForm.svelte';s=Path(p).read_text()
s=once(s,'  import { untrack } from "svelte";','  import { untrack, tick } from "svelte";')
s=once(s,'  let saving = $state(false);','  let saving = $state(false);\n  let saveError = $state("");\n  let applied = $state(false);')
s=once(s,'    saving = true;','    saving = true;saveError="";applied=false;')
s=once(s,'    } finally {\n      saving = false;','    } catch(error) {\n      saveError=String(error);\n    } finally {\n      saving = false;')
s=once(s,'allowScreenCapture: draftScreenCapture });','allowScreenCapture: draftScreenCapture });\n      applied=true;')
s=once(s,'\n</script>','\n  async function changed(){ await tick(); await save(); }\n</script>')
s=once(s,'>\n  <label class="grid gap-1">','>\n  <fieldset disabled={saving} class="grid gap-3" onchange={() => void changed()}>\n  <label class="grid gap-1">')
s=once(s,'\n</form>','\n  </fieldset>\n  {#if saveError}<p role="alert">{saveError} · Not applied; previous permissions remain. / 未套用，保留原有權限。</p>{/if}\n  <p role="status">{saving ? "Applying permissions… / 正在套用權限…" : applied ? "Applied live; no reconnect. / 已即時套用，毋須重連。" : "Changes apply automatically. / 修改後自動套用。"}</p>\n</form>')
save(p,s)
# Publish same-window metadata notifications after successful writes only.
p='src/lib/api/workspaces.ts';s=Path(p).read_text()
s='import { workspaceChanged } from "$lib/workspace-refresh";\n'+s
s=once(s,'  return invoke<WorkspaceProfile>("create_workspace", { path, name });','  const result=await invoke<WorkspaceProfile>("create_workspace", { path, name });\n  workspaceChanged();return result;')
s=once(s,'  return invoke<LinkedProject>("quick_add_linked_project", { id, path, name });','  const result=await invoke<LinkedProject>("quick_add_linked_project", { id, path, name });\n  workspaceChanged();return result;')
s=once(s,'  return invoke("update_workspace", { profile });','  await invoke("update_workspace", { profile });\n  workspaceChanged();')
save(p,s)
p='src/routes/+layout.svelte';s=Path(p).read_text()
s=once(s,'  import { onMount } from "svelte";','  import { onMount } from "svelte";\n  import { createWorkspaceRefresh } from "$lib/workspace-refresh";')
marker='    const stopGuard = startUiMemoryGuard();'
s=once(s,marker,'''    const registry=createWorkspaceRefresh(async()=>{
      const items=await listWorkspaces();
      const linked=await Promise.all(items.map(async item=>[item.id,await listLinkedProjects(item.id)] as const));
      return {items,linked};
    },value=>{
      workspaces.set(value.items);linkedProjectsByWorkspace.set(Object.fromEntries(value.linked));
    },()=>{workspaceLoadError.set("Workspace refresh unavailable; last verified list retained. / 工作區刷新未成功，保留上次已驗證清單。");});
    const refresh=()=>{void registry.run(true);};
    window.addEventListener('coding-tools-workspaces-changed',refresh);
    window.addEventListener('focus',refresh);
    const poll=setInterval(()=>{void registry.run(false);},5000);
'''+marker)
s=once(s,'      stopGuard();','      registry.stop();clearInterval(poll);\n      window.removeEventListener("coding-tools-workspaces-changed",refresh);window.removeEventListener("focus",refresh);\n      stopGuard();')
save(p,s)
# A late save must not overwrite another selected workspace's view.
p='src/routes/workspace/[id]/+page.svelte';s=Path(p).read_text()
s=once(s,'  async function saveMcpPolicy(draft: RuntimePolicyDraft) {\n    if (!profile) return;','  async function saveMcpPolicy(draft: RuntimePolicyDraft) {\n    if (!profile) return;\n    const targetId=workspaceId;')
s=once(s,'''    await updateWorkspace(next);
    profile = next;
    await load();
    showToast("Permissions applied live · 權限已即時生效；毋須重啟或重新連接 MCP", { kind: "success" });''','''    await updateWorkspace(next);
    if(workspaceId!==targetId)return;
    profile=next;
    workspaces.update(items=>items.map(item=>item.id===targetId?next:item));
    showToast("Permissions applied live · 權限已即時生效；毋須重啟或重新連接 MCP", { kind: "success" });''')
save(p,s)
for name in ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','README.md','README.en.md']:
 s=Path(name).read_text(encoding='utf-8');assert '0.4.4-rc.4' in s,name
 save(name,s.replace('0.4.4-rc.4','0.4.4-rc.5'))
changed.update(['src-tauri/src/harness/bounded_scan.rs','aiTemp/live-refresh/scan_contract.rs','aiTemp/live-refresh/http_contract.rs'])
for name in sorted(changed):
 if name.endswith('.rs'):subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*sorted(changed)],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('LIVE_REFRESH_PATCH: bounded baseline, post-read revocation, per-request linked roots and metadata-only UI refresh; no listener restart or model call')
