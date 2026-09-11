"""Publish only verified installer bytes after readback; no forced refs or asset replacement."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,zipfile
REPO='p90-lover/coding-tools-mcp';BASE='df473181ed46d764f4f54de4f597fe71c550b9a7'
BRANCH='fix/live-refresh-long-tasks-0.4.4-rc.5';VERSION='0.4.4-rc.5';TAG='v'+VERSION
SOURCE=os.environ['SOURCE'];RUN=os.environ['GITHUB_RUN_ID']
assert os.environ['GITHUB_REPOSITORY']==REPO
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==SOURCE
subprocess.run(['git','merge-base','--is-ancestor',BASE,SOURCE],check=True)
assert not subprocess.check_output(['git','diff','--diff-filter=D','--name-only',BASE,SOURCE]).strip()
subprocess.run(['git','diff','--exit-code',BASE,SOURCE,'--','src-tauri/src/auth','src-tauri/src/runtime','src-tauri/src/tunnel','src-tauri/src/integrations','src-tauri/src/tools/native_sandbox.rs','src-tauri/src/tools/sandbox_runner.rs','src-tauri/src/tools/sandbox_snapshot.rs','src-tauri/src/tools/policy.rs','native-helpers','aiTemp/quicktunnel','aiTemp/reliability','aiTemp/timeout-recovery'],check=True)
def api(path,body=None,method=None):
 args=['gh','api',f'repos/{REPO}/{path}'];data=None
 if body is not None:args+=['--method',method or 'POST','--input','-'];data=json.dumps(body).encode()
 return json.loads(subprocess.check_output(args,input=data,timeout=90))
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def download(name,dest):subprocess.run(['gh','run','download',RUN,'--repo',REPO,'--name',name,'--dir',str(dest)],check=True,timeout=120)
jobs=api('actions/runs/'+RUN+'/jobs?per_page=100')['jobs']
for name in ['prepare','windows']:
 assert len([j for j in jobs if j['name']==name and j['conclusion']=='success'])==1,name
assert not api('git/matching-refs/tags/'+TAG),'Existing release must not be overwritten'
assert api('git/ref/heads/main')['object']['sha']==BASE,'Concurrent main changed; reconcile before publishing'
assert api('git/ref/heads/'+BRANCH)['object']['sha']==SOURCE
root=Path('aiTemp/live-refresh-publication');root.mkdir(parents=True,exist_ok=False)
download('live-installer-'+RUN,root/'installer');download('live-evidence-'+RUN,root/'evidence')
proof=json.loads((root/'installer/proof.json').read_text())
assert proof['source_commit']==SOURCE and proof['version']==VERSION and proof['workflow_run']==int(RUN)
assert proof['live_refresh_http_and_scan_groups_passed']==2 and proof['context_budget_group_passed']
assert proof['workspace_refresh_coalescing_passed'] and proof['operation_cache_bound_to_root_revision']
assert not proof['automatic_linking_of_all_profiles'] and not proof['baseline_partial_acceptance']
assert not proof['stored_task_or_event_truncated'] and not proof['live_user_stall_root_cause_confirmed']
ui=json.loads((root/'evidence/refresh-browser.json').read_text());assert ui==proof['live_refresh_browser']
assert ui['source']==SOURCE and ui['passed'] and not ui['console_errors'] and ui['runtime_restarts']==0
for name,count in [('live-tests.txt',2),('context-green.txt',1),('quick-tests.txt',3),('recovery-tests.txt',3),('oauth-tests.txt',5),('snapshot-contract.txt',3)]:
 assert f'{count} passed; 0 failed' in (root/'evidence'/name).read_text(encoding='utf-8-sig'),name
assert proof['quick_groups_passed']==3 and proof['recovery_groups_passed']==3 and not proof['automatic_retries']
assert proof['oauth_regressions_passed']==5 and proof['snapshot_native_groups_passed']==3
assert proof['snapshot_helper_embedded'] and proof['binary_verification']['all_other_bytes_identical']
assert not proof['publisher_signed'] and proof['model_requests']==0 and not proof['codex_executable_invoked']
assert proof['catalog_counts']=={'core':58,'read_only':42,'advanced':71}
name='Coding.Tools.MCP_'+VERSION+'_x64-setup.exe';exe=root/'installer'/name
assert proof['asset']==name and digest(exe)==proof['sha256'] and exe.stat().st_size==proof['size']
assets=root/'assets';assets.mkdir();shutil.copy2(exe,assets/name)
provenance={'version':VERSION,'source_commit':SOURCE,'main_commit':SOURCE,'workflow_run':int(RUN),'preserved_main':BASE,
 'windows':proof,'extension_version':'0.0.7','live_user_connection_verified':False,'model_requests':0}
(assets/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
with zipfile.ZipFile(assets/'validation-evidence.zip','x',zipfile.ZIP_DEFLATED) as z:
 for p in sorted((root/'evidence').rglob('*')):
  assert not p.is_symlink()
  if p.is_file():
   assert p.suffix in {'.json','.txt'} and p.stat().st_size<16*1024*1024
   z.write(p,p.relative_to(root/'evidence').as_posix())
(assets/'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(assets.iterdir())))
files=sorted(assets.iterdir());assert len(files)==4
notes=Path('docs/releases/'+TAG+'.md').read_text(encoding='utf-8')
notes+=f'\n\nExact source / 原始碼: `{SOURCE}`\nBuild / 建置: https://github.com/{REPO}/actions/runs/{RUN}\n'
release=api('releases',{'tag_name':TAG,'target_commitish':SOURCE,'name':'Coding Tools MCP '+TAG+' — live permissions and bounded long-task reads','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
Path('aiTemp/live-release-draft.json').write_text(json.dumps({'release_id':release['id'],'source':SOURCE}))
for p in files:subprocess.run(['gh','release','upload',TAG,str(p),'--repo',REPO],check=True,timeout=120)
readback=root/'readback';readback.mkdir()
subprocess.run(['gh','release','download',TAG,'--repo',REPO,'--dir',str(readback)],check=True,timeout=120)
assert {p.name for p in readback.iterdir()}=={p.name for p in files}
for p in files:assert digest(readback/p.name)==digest(p),p.name
assert api('git/ref/heads/main')['object']['sha']==BASE
api('git/refs/heads/main',{'sha':SOURCE,'force':False},'PATCH')
refs=api('git/matching-refs/tags/'+TAG)
if not refs:api('git/refs',{'ref':'refs/tags/'+TAG,'sha':SOURCE})
else:assert len(refs)==1 and refs[0]['object']['sha']==SOURCE
public=api('releases/'+str(release['id']),{'draft':False,'prerelease':True,'make_latest':'false'},'PATCH')
assert not public['draft'] and public['published_at']
assert api('git/ref/tags/'+TAG)['object']['sha']==SOURCE and api('git/ref/heads/main')['object']['sha']==SOURCE
receipt={'release_url':public['html_url'],'source_commit':SOURCE,'tag':TAG,'main_updated':True,'readback_verified':True,
 'assets':[{'name':p.name,'size':p.stat().st_size,'sha256':digest(p)} for p in files]}
Path('aiTemp/live-release-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
