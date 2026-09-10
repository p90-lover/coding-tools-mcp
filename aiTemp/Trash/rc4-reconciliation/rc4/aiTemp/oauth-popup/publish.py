"""Publish verified rc.4 bytes; do not delete, overwrite a release, or force main."""
from pathlib import Path
import hashlib,json,os,re,shutil,subprocess,zipfile
REPO='p90-lover/coding-tools-mcp';BASE='07faa97255e6b60d909f956fa2cebd3b829bbf97'
BRANCH='fix/main-preservation-0.4.3-rc.4';VERSION='0.4.3-rc.4';TAG='v'+VERSION
SOURCE=os.environ['SOURCE'];RUN=os.environ['GITHUB_RUN_ID']
assert re.fullmatch('[0-9a-f]{40}',SOURCE) and RUN.isdecimal()
assert os.environ['GITHUB_REPOSITORY']==REPO
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==SOURCE

def api(path,body=None,method=None):
    args=['gh','api',f'repos/{REPO}/{path}'];data=None
    if body is not None:args+=['--method',method or 'POST','--input','-'];data=json.dumps(body).encode()
    return json.loads(subprocess.check_output(args,input=data,timeout=90))
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def download(name,dest):
    subprocess.run(['gh','run','download',RUN,'--repo',REPO,'--name',name,'--dir',str(dest)],check=True,timeout=120)
root=Path('aiTemp/oauth-popup-publication');root.mkdir(parents=True,exist_ok=False)
download('oauth-popup-installer-'+RUN,root/'installer')
download('oauth-popup-windows-evidence-'+RUN,root/'windows')
download('oauth-popup-origin-evidence-'+RUN,root/'origin')
download('oauth-popup-browser-evidence-'+RUN,root/'browser')
proof=json.loads((root/'installer/proof.json').read_text())
assert proof['source_commit']==SOURCE and proof['version']==VERSION and proof['workflow_run']==int(RUN)
assert proof['oauth_regressions_passed']==4 and proof['catalog_regressions_passed']==2
assert not proof['codex_executable_invoked'] and proof['model_requests']==0
assert proof['file_safety_regressions_passed']==3
assert '3 passed; 0 failed' in (root/'windows/file-safety.txt').read_text()
assert '3 passed; 0 failed' in (root/'origin/green.txt').read_text()
assert 'POPUP_ORIGIN_BLOCKED' in (root/'origin/released-red.txt').read_text()
assert 'HOST_MUST_NOT_SELECT_TRUST' in (root/'origin/main-red.txt').read_text()
browser=json.loads((root/'browser/browser-csp.json').read_text())
assert browser['source']==SOURCE and browser['passed'] and not browser['live_chatgpt_account'] and browser['model_requests']==0
assert browser['external_network_blocked'] and browser['screenshots_written']==0
assert [(c['case'],c['callback_reached']) for c in browser['cases']]==[('old_policy',False),('fixed_policy',True),('wrong_destination',False)]
name=f'Coding.Tools.MCP_{VERSION}_x64-setup.exe';assert proof['asset']==name
binary=root/'installer'/name;assert digest(binary)==proof['sha256'] and binary.stat().st_size==proof['size']
assets=root/'assets';assets.mkdir();shutil.copy2(binary,assets/name)
(assets/'provenance.json').write_text(json.dumps({'version':VERSION,'source_commit':SOURCE,'workflow_run':int(RUN),'preserved_main':BASE,'windows':proof,'browser':browser,'live_chatgpt_account_verified':False},indent=2)+'\n')
with zipfile.ZipFile(assets/'validation-evidence.zip','x',zipfile.ZIP_DEFLATED) as z:
    for directory in [root/'windows',root/'origin',root/'browser']:
        for p in sorted(directory.rglob('*')):
            assert not p.is_symlink()
            if p.is_file():
                assert p.suffix in {'.txt','.json'} and p.stat().st_size<16*1024*1024
                z.write(p,p.relative_to(root).as_posix())
(assets/'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(assets.iterdir())))
files=sorted(assets.iterdir());assert len(files)==4
assert not api('git/matching-refs/tags/'+TAG),'Existing release tag is not replaceable'
assert api('git/ref/heads/'+BRANCH)['object']['sha']==SOURCE
assert api('git/ref/heads/main')['object']['sha']==BASE,'main changed; reconcile before publishing'
jobs=api(f'actions/runs/{RUN}/jobs?per_page=100');assert jobs['total_count']==len(jobs['jobs'])
for required in ['prepare','origin','windows','browser']:
    matches=[j for j in jobs['jobs'] if j['name']==required]
    assert len(matches)==1 and matches[0]['conclusion']=='success',required
notes=Path(f'docs/releases/{TAG}.md').read_text(encoding='utf-8')+f'\n\nSource: `{SOURCE}`\nValidation: https://github.com/{REPO}/actions/runs/{RUN}\n'
release=api('releases',{'tag_name':TAG,'target_commitish':SOURCE,'name':f'Coding Tools MCP {TAG} — Preserved features, OAuth and file-safety repair','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
Path('aiTemp/oauth-popup-draft.json').write_text(json.dumps({'id':release['id'],'source':SOURCE,'tag':TAG}))
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
assert api('git/ref/tags/'+TAG)['object']['sha']==SOURCE
assert api('git/ref/heads/main')['object']['sha']==SOURCE
receipt={'release_url':public['html_url'],'source_commit':SOURCE,'tag':TAG,'main_updated':True,'verified_uploaded_bytes':True,
    'assets':[{'name':p.name,'sha256':digest(p),'size':p.stat().st_size} for p in files]}
Path('aiTemp/oauth-popup-publication-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
