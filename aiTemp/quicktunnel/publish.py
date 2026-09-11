"""Read back every asset before non-forced publication; preserve prior refs/files/releases."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,zipfile
REPO='p90-lover/coding-tools-mcp';BASE='24396cc79475d477e1dee159f62ef1d660598911'
BRANCH='fix/quicktunnel-fast-control-0.4.4-rc.4';VERSION='0.4.4-rc.4';TAG='v'+VERSION
SOURCE=os.environ['SOURCE'];RUN=os.environ['GITHUB_RUN_ID']
assert os.environ['GITHUB_REPOSITORY']==REPO
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==SOURCE
subprocess.run(['git','merge-base','--is-ancestor',BASE,SOURCE],check=True)
assert not subprocess.check_output(['git','diff','--diff-filter=D','--name-only',BASE,SOURCE]).strip()
subprocess.run(['git','diff','--exit-code',BASE,SOURCE,'--','src-tauri/src/auth','src-tauri/src/runtime','src-tauri/src/tunnel/recovery.rs','src-tauri/src/tunnel/supervisor.rs','src-tauri/src/integrations','src-tauri/src/tools/native_sandbox.rs','src-tauri/src/tools/sandbox_runner.rs','src-tauri/src/tools/sandbox_snapshot.rs','src-tauri/src/tools/policy.rs','src-tauri/src/tools/live_policy.rs','native-helpers','aiTemp/timeout-recovery','aiTemp/reliability'],check=True)
def api(path,body=None,method=None):
    args=['gh','api',f'repos/{REPO}/{path}'];data=None
    if body is not None:args+=['--method',method or 'POST','--input','-'];data=json.dumps(body).encode()
    return json.loads(subprocess.check_output(args,input=data,timeout=90))
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def download(name,dest):subprocess.run(['gh','run','download',RUN,'--repo',REPO,'--name',name,'--dir',str(dest)],check=True,timeout=120)
jobs=api('actions/runs/'+RUN+'/jobs?per_page=100')['jobs']
for name in ['prepare','windows']:
    assert len([j for j in jobs if j['name']==name and j['conclusion']=='success'])==1,name
assert not api('git/matching-refs/tags/'+TAG),'Existing tag must not be replaced'
assert api('git/ref/heads/main')['object']['sha']==BASE,'Concurrent main changed; stop and preserve'
assert api('git/ref/heads/'+BRANCH)['object']['sha']==SOURCE
root=Path('aiTemp/quick-publication');root.mkdir(parents=True,exist_ok=False)
download('quick-installer-'+RUN,root/'installer');download('quick-evidence-'+RUN,root/'evidence')
proof=json.loads((root/'installer/proof.json').read_text())
assert proof['source_commit']==SOURCE and proof['version']==VERSION and proof['workflow_run']==int(RUN)
assert proof['quick_groups_passed']==3 and proof['reserved_protocol_slots']==2 and proof['ordinary_tool_slots']==16
assert proof['quick_probe']['pooled_connections']==1 and proof['quick_probe']['parallel_requests']>=2
assert proof['quick_http']['auth_origin_protocol_checked'] and proof['quick_http']['read_only_profile_retained']
assert proof['recovered_output_schemas']==['read_file','operation_log'] and proof['branch_audit_count']==74
assert proof['recovery_groups_passed']==3 and proof['recovery_output_schema_validated'] and not proof['automatic_retries']
assert proof['reliability_rust_groups_passed']==2 and proof['task_event_schema_validated']
assert proof['oauth_regressions_passed']==5 and proof['snapshot_contract_groups_passed']==3 and proof['snapshot_native_groups_passed']==3
assert proof['catalog_counts']=={'core':58,'read_only':42,'advanced':71}
assert proof['snapshot_helper_embedded'] and proof['binary_verification']['all_other_bytes_identical']
assert not proof['publisher_signed'] and not proof['codex_executable_invoked'] and proof['model_requests']==0
assert not proof['full_autonomous_engines_added'] and not proof['live_user_connection_verified']
for name,count in [('quick-tests.txt',3),('reliability-tests.txt',2),('recovery-tests.txt',3),('oauth-tests.txt',5),('snapshot-contract.txt',3)]:
    assert f'{count} passed; 0 failed' in (root/'evidence'/name).read_text(encoding='utf-8-sig'),name
name='Coding.Tools.MCP_'+VERSION+'_x64-setup.exe';binary=root/'installer'/name
assert proof['asset']==name and digest(binary)==proof['sha256'] and binary.stat().st_size==proof['size']
assets=root/'assets';assets.mkdir();shutil.copy2(binary,assets/name)
report=Path('docs/audits/branch-recovery-2026-09-11.md')
assert digest(report)==proof['branch_report_sha256'];shutil.copy2(report,assets/'branch-recovery-audit.md')
provenance={'version':VERSION,'source_commit':SOURCE,'main_commit':SOURCE,'workflow_run':int(RUN),'preserved_main':BASE,
    'windows':proof,'extension_source':'b0d4db553227fa3c7300050b8edff6e2eb9afee4','extension_version':'0.0.7',
    'live_user_connection_verified':False,'public_network_benchmarked':False,'model_requests':0}
(assets/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
with zipfile.ZipFile(assets/'validation-evidence.zip','x',zipfile.ZIP_DEFLATED) as z:
    for path in sorted((root/'evidence').rglob('*')):
        assert not path.is_symlink()
        if path.is_file():
            assert path.suffix in {'.json','.txt'} and path.stat().st_size<16*1024*1024
            z.write(path,path.relative_to(root/'evidence').as_posix())
(assets/'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(assets.iterdir())))
files=sorted(assets.iterdir());assert len(files)==5
notes=Path('docs/releases/'+TAG+'.md').read_text(encoding='utf-8')
notes+=f'\n\nExact source / 原始碼: `{SOURCE}`\nBuild / 建置: https://github.com/{REPO}/actions/runs/{RUN}\n'
release=api('releases',{'tag_name':TAG,'target_commitish':SOURCE,'name':'Coding Tools MCP '+TAG+' — responsive control and branch recovery','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
Path('aiTemp/quick-release-draft.json').write_text(json.dumps({'release_id':release['id'],'source':SOURCE}))
for path in files:subprocess.run(['gh','release','upload',TAG,str(path),'--repo',REPO],check=True,timeout=120)
readback=root/'readback';readback.mkdir()
subprocess.run(['gh','release','download',TAG,'--repo',REPO,'--dir',str(readback)],check=True,timeout=120)
assert {p.name for p in readback.iterdir()}=={p.name for p in files}
for path in files:assert digest(readback/path.name)==digest(path),path.name
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
Path('aiTemp/quick-release-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
