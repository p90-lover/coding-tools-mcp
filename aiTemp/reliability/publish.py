"""Require scoped source, real evidence and uploaded-byte readback before publication."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,zipfile
REPO='p90-lover/coding-tools-mcp';BASE='13410a4cd4b148e2fa94462102056017119c94af'
BRANCH='fix/integration-reliability-0.4.4-rc.3';VERSION='0.4.4-rc.3';TAG='v'+VERSION
SOURCE=os.environ['SOURCE'];RUN=os.environ['GITHUB_RUN_ID']
assert os.environ['GITHUB_REPOSITORY']==REPO
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==SOURCE
subprocess.run(['git','merge-base','--is-ancestor',BASE,SOURCE],check=True)
assert not subprocess.check_output(['git','diff','--diff-filter=D','--name-only',BASE,SOURCE]).strip()
subprocess.run(['git','diff','--exit-code',BASE,SOURCE,'--','src-tauri/src/auth','src-tauri/src/mcp','src-tauri/src/integrations','src-tauri/src/tools/sandbox_runner.rs','src-tauri/src/tools/sandbox_process.rs','src-tauri/src/tools/policy.rs','src-tauri/src/tools/approval.rs','src-tauri/src/tools/live_policy.rs','native-helpers','aiTemp/timeout-recovery'],check=True)
base_native=subprocess.check_output(['git','show',BASE+':src-tauri/src/tools/native_sandbox.rs']).decode().rstrip()
assert Path('src-tauri/src/tools/native_sandbox.rs').read_text().startswith(base_native),'Native grant/dispatch implementation must be unchanged before the appended test include'
def api(path,body=None,method=None):
    args=['gh','api',f'repos/{REPO}/{path}'];data=None
    if body is not None:args+=['--method',method or 'POST','--input','-'];data=json.dumps(body).encode()
    return json.loads(subprocess.check_output(args,input=data,timeout=90))
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def download(name,dest):subprocess.run(['gh','run','download',RUN,'--repo',REPO,'--name',name,'--dir',str(dest)],check=True,timeout=120)
jobs=api('actions/runs/'+RUN+'/jobs?per_page=100')['jobs']
for name in ['prepare','windows']:
    assert len([j for j in jobs if j['name']==name and j['conclusion']=='success'])==1,name
assert not api('git/matching-refs/tags/'+TAG),'Do not replace an existing release'
assert api('git/ref/heads/main')['object']['sha']==BASE,'Concurrent main changed; stop without overwriting'
assert api('git/ref/heads/'+BRANCH)['object']['sha']==SOURCE
root=Path('aiTemp/reliability-publication');root.mkdir(parents=True,exist_ok=False)
download('reliability-installer-'+RUN,root/'installer');download('reliability-evidence-'+RUN,root/'evidence')
proof=json.loads((root/'installer/proof.json').read_text())
assert proof['source_commit']==SOURCE and proof['version']==VERSION and proof['workflow_run']==int(RUN)
assert proof['reliability_rust_groups_passed']==2 and proof['integration_state_group_passed']
assert proof['task_event_schema_validated'] and proof['schema_samples_validated']==4 and proof['read_only_adapter_tests_passed']==3
assert not proof['rejected_snapshot_inputs_consume_slots'] and not proof['existing_failed_snapshots_removed']
assert proof['recovery_groups_passed']==3 and proof['recovery_output_schema_validated'] and not proof['automatic_retries']
assert proof['catalog_counts']=={'core':58,'read_only':42,'advanced':71}
assert proof['oauth_regressions_passed']==5 and proof['snapshot_contract_groups_passed']==3 and proof['snapshot_native_groups_passed']==3
assert proof['snapshot_helper_embedded'] and proof['binary_verification']['all_other_bytes_identical']
assert not proof['codex_executable_invoked'] and proof['model_requests']==0 and not proof['publisher_signed']
assert not proof['full_autonomous_engines_added'] and not proof['live_user_connection_verified']
ui=json.loads((root/'evidence/integration-browser.json').read_text());assert ui==proof['integration_browser']
assert ui['source']==SOURCE and ui['passed'] and not ui['console_errors']
for name,count in [('reliability-tests.txt',2),('recovery-tests.txt',3),('oauth-tests.txt',5),('snapshot-contract.txt',3),('adapter-tests.txt',3)]:
    assert f'{count} passed; 0 failed' in (root/'evidence'/name).read_text(encoding='utf-8-sig'),name
name='Coding.Tools.MCP_'+VERSION+'_x64-setup.exe';binary=root/'installer'/name
assert proof['asset']==name and binary.stat().st_size==proof['size'] and digest(binary)==proof['sha256']
assets=root/'assets';assets.mkdir();shutil.copy2(binary,assets/name)
provenance={'version':VERSION,'source_commit':SOURCE,'main_commit':SOURCE,'workflow_run':int(RUN),
    'preserved_main':BASE,'windows':proof,'extension_source':'b0d4db553227fa3c7300050b8edff6e2eb9afee4',
    'extension_version':'0.0.7','live_user_connection_verified':False,'model_requests':0}
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
release=api('releases',{'tag_name':TAG,'target_commitish':SOURCE,'name':'Coding Tools MCP '+TAG+' — integration reliability and result schemas','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
Path('aiTemp/reliability-release-draft.json').write_text(json.dumps({'release_id':release['id'],'source':SOURCE}))
for p in files:subprocess.run(['gh','release','upload',TAG,str(p),'--repo',REPO],check=True,timeout=120)
readback=root/'readback';readback.mkdir()
subprocess.run(['gh','release','download',TAG,'--repo',REPO,'--dir',str(readback)],check=True,timeout=120)
assert {p.name for p in readback.iterdir()}=={p.name for p in files}
for p in files:assert digest(readback/p.name)==digest(p)
assert api('git/ref/heads/main')['object']['sha']==BASE
api('git/refs/heads/main',{'sha':SOURCE,'force':False},'PATCH')
refs=api('git/matching-refs/tags/'+TAG)
if not refs:api('git/refs',{'ref':'refs/tags/'+TAG,'sha':SOURCE})
else:assert len(refs)==1 and refs[0]['object']['sha']==SOURCE
public=api('releases/'+str(release['id']),{'draft':False,'prerelease':True,'make_latest':'false'},'PATCH')
assert not public['draft'] and public['published_at']
assert api('git/ref/tags/'+TAG)['object']['sha']==SOURCE and api('git/ref/heads/main')['object']['sha']==SOURCE
receipt={'release_url':public['html_url'],'source_commit':SOURCE,'main_updated':True,'tag':TAG,'readback_verified':True,
    'assets':[{'name':p.name,'size':p.stat().st_size,'sha256':digest(p)} for p in files]}
Path('aiTemp/reliability-release-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
