"""Publish exact-source artifacts only after all required jobs pass; never overwrite releases."""
from pathlib import Path
import hashlib,json,os,re,shutil,subprocess,zipfile
REPO='p90-lover/coding-tools-mcp';BASE='aec0c3fce7086a44eff7efdfc1de018a67ae654e'
SOURCE=os.environ['SOURCE'];RUN=os.environ['GITHUB_RUN_ID'];VERSION='0.4.3-rc.2';TAG='v'+VERSION
assert re.fullmatch('[0-9a-f]{40}',SOURCE) and RUN.isdecimal() and os.environ['GITHUB_REPOSITORY']==REPO
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==SOURCE

def api(path,body=None,method=None):
    args=['gh','api',f'repos/{REPO}/{path}'];data=None
    if body is not None:args+=['--method',method or 'POST','--input','-'];data=json.dumps(body).encode()
    return json.loads(subprocess.check_output(args,input=data,timeout=90))
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def download(name,target):
    subprocess.run(['gh','run','download',RUN,'--repo',REPO,'--name',name,'--dir',str(target)],check=True,timeout=120)
root=Path('aiTemp/catalog-release');root.mkdir(parents=True,exist_ok=False)
download('catalog-installer-'+RUN,root/'installer')
download('catalog-windows-evidence-'+RUN,root/'windows')
download('catalog-browser-evidence-'+RUN,root/'browser')
proof=json.loads((root/'installer/proof.json').read_text())
assert proof['source_commit']==SOURCE and proof['version']==VERSION and proof['workflow_run']==int(RUN)
assert proof['catalog_regressions_passed']==2 and proof['codex_executable_invoked'] is False and proof['model_requests']==0
ui=json.loads((root/'browser/browser-result.json').read_text())
assert ui['passed'] and ui['source']==SOURCE and ui['console_errors']==[]
assert 'PROFILE_SELECTION_MISSING: core' in (root/'browser/profile-red.txt').read_text()
assert 'PASS: actual Svelte SSR' in (root/'browser/profile-green.txt').read_text()
name='Coding.Tools.MCP_'+VERSION+'_x64-setup.exe';assert proof['asset']==name
binary=root/'installer'/name;assert binary.stat().st_size==proof['size'] and digest(binary)==proof['sha256']
assets=root/'assets';assets.mkdir()
shutil.copy2(binary,assets/name)
(assets/'provenance.json').write_text(json.dumps({'version':VERSION,'source_commit':SOURCE,'workflow_run':int(RUN),'windows':proof,'browser':ui,'client_connection_verified':False},indent=2)+'\n')
with zipfile.ZipFile(assets/'validation-evidence.zip','x',zipfile.ZIP_DEFLATED) as z:
    for directory in [root/'windows',root/'browser']:
        for p in sorted(directory.rglob('*')):
            assert not p.is_symlink()
            if p.is_file():
                assert p.suffix in {'.json','.txt'} and p.stat().st_size<16*1024*1024
                z.write(p,p.relative_to(root).as_posix())
files=sorted(assets.iterdir())
(assets/'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in files))
files=sorted(assets.iterdir());assert len(files)==4
# New publication only. Keep old tags/assets and fail on concurrent main changes.
assert not api('git/matching-refs/tags/'+TAG),'Existing tags must not be replaced'
assert api('git/ref/heads/fix/tool-exposure-0.4.3-rc.2')['object']['sha']==SOURCE
assert api('git/ref/heads/main')['object']['sha']==BASE
jobs=api(f'actions/runs/{RUN}/jobs?per_page=100')
assert jobs['total_count']==len(jobs['jobs'])
for expected in ['prepare','windows','browser']:
    matches=[j for j in jobs['jobs'] if j['name']==expected]
    assert len(matches)==1 and matches[0]['conclusion']=='success',expected
notes=Path('docs/releases/'+TAG+'.md').read_text(encoding='utf-8')
notes+=f'\n\nSource: `{SOURCE}`\nValidation: https://github.com/{REPO}/actions/runs/{RUN}\n'
release=api('releases',{'tag_name':TAG,'target_commitish':SOURCE,'name':'Coding Tools MCP '+TAG+' — Accurate tool exposure','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
Path('aiTemp/catalog-draft.json').write_text(json.dumps({'release_id':release['id'],'source':SOURCE,'tag':TAG}))
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
assert public['draft'] is False and public['published_at']
assert api('git/ref/tags/'+TAG)['object']['sha']==SOURCE
assert api('git/ref/heads/main')['object']['sha']==SOURCE
receipt={'url':public['html_url'],'source_commit':SOURCE,'tag':TAG,'main_updated':True,'assets_retrieved_and_verified':True,'assets':[{'name':p.name,'size':p.stat().st_size,'sha256':digest(p)} for p in files]}
Path('aiTemp/catalog-publication-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
