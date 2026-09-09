"""Publish an exact-source candidate after independent artifact checks; never overwrite."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import zipfile

REPO='p90-lover/coding-tools-mcp';VERSION='0.4.3-rc.1';TAG='v'+VERSION
BRANCH='release/workflow-sync-0.4.3-rc.1'
EXPECTED_MAIN='aabd5acf8cceba7b7a18320eba3765754c5780fe'
SOURCE=os.environ['SOURCE'];RUN=os.environ['GITHUB_RUN_ID']
assert os.environ['GITHUB_REPOSITORY']==REPO and re.fullmatch('[0-9a-f]{40}',SOURCE)
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==SOURCE

def api(path,method='GET',body=None,missing=False):
    command=['gh','api',f'repos/{REPO}/{path}','--method',method]
    if body is not None:command+=['--input','-']
    result=subprocess.run(command,input=None if body is None else json.dumps(body),capture_output=True,text=True,timeout=120)
    if result.returncode:
        if missing and 'HTTP 404' in result.stderr:return None
        raise RuntimeError(f'GitHub {method} {path} failed: {result.stderr[:800]}')
    return json.loads(result.stdout) if result.stdout.strip() else None

def gh(*args):return subprocess.check_output(['gh',*args],text=True,timeout=180)
def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

root=Path('aiTemp/release-downloads');root.mkdir(parents=True,exist_ok=False)
assets=Path('aiTemp/release-assets');assets.mkdir(parents=True,exist_ok=False)
proofs={}
for platform in ['windows-x64','macos-aarch64']:
    target=root/platform
    gh('run','download',RUN,'--repo',REPO,'--name',f'workflow-043-installer-{platform}-{RUN}','--dir',str(target))
    proof=json.loads((target/'proof.json').read_text())
    assert proof['source_commit']==SOURCE and proof['version']==VERSION and proof['platform']==platform
    assert proof['workflow_run']==int(RUN)
    for field in ['native_command_readonly_write_denial_verified','native_command_consent_and_retry_verified','real_persistent_workflow_dispatch_verified','live_permission_revocation_verified','mcp_http_regressions_passed','catalog_truthful_annotations_verified']:
        assert proof[field] is True,field
    assert proof['codex_agent_invoked'] is False
    assert proof['model_or_thread_requests']==0 and proof['provider_requests']==0
    assert re.fullmatch('[0-9a-f]{64}',proof['native_command_runtime_sha256'])
    name='Coding.Tools.MCP_'+VERSION+('_x64-setup.exe' if platform=='windows-x64' else '_aarch64.dmg')
    assert proof['asset']==name
    binary=target/name;assert binary.is_file() and not binary.is_symlink()
    assert binary.stat().st_size==proof['size'] and sha(binary)==proof['sha256']
    shutil.copy2(binary,assets/name)
    (assets/f'proof-{platform}.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
    proofs[platform]=proof
    gh('run','download',RUN,'--repo',REPO,'--name',f'workflow-043-evidence-{platform}-{RUN}','--dir',str(root/f'evidence-{platform}'))
board=root/'board'
gh('run','download',RUN,'--repo',REPO,'--name',f'workflow-043-board-{RUN}','--dir',str(board))
result=json.loads((board/'board-ui-result.json').read_text())
assert result['passed'] and result['source']==SOURCE and result['console_errors']==[]
assert 'quiet remote refresh preserves unsubmitted draft' in result['checks']
assert 'MCP observation is visibly separate from human approval' in result['checks']
with zipfile.ZipFile(assets/'validation-evidence.zip','x',compression=zipfile.ZIP_DEFLATED) as archive:
    for folder in [board,root/'evidence-windows-x64',root/'evidence-macos-aarch64']:
        for p in sorted(folder.rglob('*')):
            assert not p.is_symlink()
            if p.is_file():
                assert p.stat().st_size<16*1024*1024 and p.suffix in {'.txt','.json','.png'},p
                archive.write(p,p.relative_to(root).as_posix())
(assets/'provenance.json').write_text(json.dumps({'version':VERSION,'source_commit':SOURCE,'workflow_run':int(RUN),'platforms':proofs,'board':result,'live_chatgpt_verified':False,'model_or_thread_requests':0,'provider_requests':0},indent=2)+'\n',encoding='utf-8')
files=sorted(assets.iterdir())
(assets/'SHA256SUMS.txt').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in files),encoding='utf-8')
files=sorted(assets.iterdir());assert len(files)==7
assert api('git/ref/heads/'+BRANCH)['object']['sha']==SOURCE,'Candidate changed during verification'
assert api('git/ref/heads/main')['object']['sha'] in [EXPECTED_MAIN,SOURCE],'main changed; reconcile without force'
assert api(f'releases/tags/{TAG}',missing=True) is None,'Do not overwrite an existing release'
assert api(f'git/ref/tags/{TAG}',missing=True) is None,'Do not replace an existing tag'
notes=Path('docs/releases/v0.4.3-rc.1.md').read_text(encoding='utf-8')
notes+=f'\n\nSource: `{SOURCE}`\n\nVerification: https://github.com/{REPO}/actions/runs/{RUN}\n'
api('git/refs','POST',{'ref':'refs/tags/'+TAG,'sha':SOURCE})
release=api('releases','POST',{'tag_name':TAG,'target_commitish':SOURCE,'name':f'Coding Tools MCP {TAG} — Shared workflow + model-free native commands','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
Path('aiTemp/draft-id.txt').write_text(str(release['id'])+'\n')
for p in files:gh('release','upload',TAG,str(p),'--repo',REPO)
readback=Path('aiTemp/release-readback');readback.mkdir(exist_ok=False)
gh('release','download',TAG,'--repo',REPO,'--dir',str(readback))
assert {p.name for p in readback.iterdir()}=={p.name for p in files}
for p in files:assert sha(readback/p.name)==sha(p),p.name
assert api('git/ref/heads/'+BRANCH)['object']['sha']==SOURCE
head=api('git/ref/heads/main')['object']['sha'];assert head in [EXPECTED_MAIN,SOURCE]
if head!=SOURCE:api('git/refs/heads/main','PATCH',{'sha':SOURCE,'force':False})
assert api('git/ref/heads/main')['object']['sha']==SOURCE
api(f'releases/{release["id"]}','PATCH',{'draft':False,'prerelease':True,'make_latest':'false'})
public=api('releases/tags/'+TAG)
assert not public['draft'] and public['prerelease'] and public['published_at']
assert api('git/ref/tags/'+TAG)['object']['sha']==SOURCE
actual={a['name']:(a['size'],a['digest']) for a in public['assets']}
assert actual=={p.name:(p.stat().st_size,'sha256:'+sha(p)) for p in files}
receipt={'release':public['html_url'],'id':public['id'],'source_commit':SOURCE,'tag':TAG,'main_updated':True,'downloaded_assets_verified':True,'assets':[{'name':p.name,'sha256':sha(p),'size':p.stat().st_size} for p in files]}
Path('aiTemp/release-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
print('PUBLISHED_VERIFIED_RELEASE '+public['html_url'])
