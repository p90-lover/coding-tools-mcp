"""Publish exact tested rc5 bytes; do not overwrite concurrent main or earlier releases."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,zipfile
REPO='p90-lover/coding-tools-mcp';BASE='ccfa3e7cee5f917f3ad4584c5ec2a5a91d87f8f4'
BRANCH='fix/oauth-form-origin-0.4.3-rc.5';VERSION='0.4.3-rc.5';TAG='v'+VERSION
SOURCE=os.environ['SOURCE'];RUN=os.environ['GITHUB_RUN_ID']
assert os.environ['GITHUB_REPOSITORY']==REPO
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==SOURCE
subprocess.run(['git','merge-base','--is-ancestor',BASE,SOURCE],check=True)
assert not subprocess.check_output(['git','diff','--diff-filter=D','--name-only',BASE,SOURCE]).strip()
def api(path,body=None,method=None):
    args=['gh','api',f'repos/{REPO}/{path}'];data=None
    if body is not None:args+=['--method',method or 'POST','--input','-'];data=json.dumps(body).encode()
    return json.loads(subprocess.check_output(args,input=data,timeout=90))
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def download(run,name,destination):
    subprocess.run(['gh','run','download',run,'--repo',REPO,'--name',name,'--dir',str(destination)],check=True,timeout=120)
jobs=api('actions/runs/'+RUN+'/jobs?per_page=100')['jobs']
assert len([j for j in jobs if j['name']=='windows' and j['conclusion']=='success'])==1
assert not api('git/matching-refs/tags/'+TAG)
assert api('git/ref/heads/main')['object']['sha']==BASE,'Concurrent main changed; preserve it and stop'
assert api('git/ref/heads/'+BRANCH)['object']['sha']==SOURCE
root=Path('aiTemp/origin-publication');root.mkdir(parents=True,exist_ok=False)
download(RUN,'origin-repair-installer-'+RUN,root/'installer')
download(RUN,'origin-repair-evidence-'+RUN,root/'evidence')
proof=json.loads((root/'installer/proof.json').read_text())
assert proof['source_commit']==SOURCE and proof['workflow_run']==int(RUN) and proof['version']==VERSION
assert proof['oauth_regressions_passed']==5 and proof['browser_origin_cases_passed']==3
assert proof['null_origin_still_denied'] and proof['form_referrer_policy']=='strict-origin'
assert not proof['codex_executable_invoked'] and proof['model_requests']==0
assert proof['binary_verification']['all_other_bytes_identical'] and not proof['publisher_signed']
assert proof['catalog_counts']=={'core':57,'advanced':70}
browser=json.loads((root/'evidence/browser-live.json').read_text())
assert browser==proof['browser'] and browser['source']==SOURCE and browser['passed'] and browser['forged_origin_denied']
assert browser['external_browser_network_blocked'] and not browser['live_account']
assert [(c['case'],c['post']['status']) for c in browser['cases']]==[('manual',303),('extension',303),('old_no_referrer',403)]
red=json.loads((root/'evidence/referrer-red.json').read_text())
assert red['observations'][0]['origin']=='null' and red['observations'][0]['consent_cookie_present']
assert '5 passed; 0 failed' in (root/'evidence/oauth-tests.txt').read_text(encoding='utf-8-sig')
name='Coding.Tools.MCP_'+VERSION+'_x64-setup.exe';binary=root/'installer'/name
assert proof['asset']==name and binary.stat().st_size==proof['size'] and digest(binary)==proof['sha256']
assets=root/'assets';assets.mkdir();shutil.copy2(binary,assets/name)
provenance={'version':VERSION,'source_commit':SOURCE,'main_commit':SOURCE,'workflow_run':int(RUN),
    'regression_run':34467925847,'preserved_main':BASE,'windows':proof,'browser':browser,
    'extension_source':proof['extension_source'],'extension_version':'0.0.7','live_user_connection_verified':False,'model_requests':0}
(assets/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
with zipfile.ZipFile(assets/'validation-evidence.zip','x',zipfile.ZIP_DEFLATED) as z:
    for path in sorted((root/'evidence').rglob('*')):
        assert not path.is_symlink()
        if path.is_file():
            assert path.suffix in {'.json','.txt'} and path.stat().st_size<16*1024*1024
            z.write(path,path.relative_to(root/'evidence').as_posix())
(assets/'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(assets.iterdir())))
files=sorted(assets.iterdir());assert len(files)==4
notes=Path('docs/releases/'+TAG+'.md').read_text(encoding='utf-8')
notes+=f'\n\nSource / 原始碼: `{SOURCE}`\nBuild / 建置: https://github.com/{REPO}/actions/runs/{RUN}\n'
release=api('releases',{'tag_name':TAG,'target_commitish':SOURCE,'name':'Coding Tools MCP '+TAG+' — local OAuth Origin repair','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
Path('aiTemp/origin-release-draft.json').write_text(json.dumps({'release_id':release['id'],'source':SOURCE}))
for path in files:subprocess.run(['gh','release','upload',TAG,str(path),'--repo',REPO],check=True,timeout=120)
readback=root/'readback';readback.mkdir()
subprocess.run(['gh','release','download',TAG,'--repo',REPO,'--dir',str(readback)],check=True,timeout=120)
assert {p.name for p in readback.iterdir()}=={p.name for p in files}
for path in files:assert digest(readback/path.name)==digest(path)
assert api('git/ref/heads/main')['object']['sha']==BASE
api('git/refs/heads/main',{'sha':SOURCE,'force':False},'PATCH')
refs=api('git/matching-refs/tags/'+TAG)
if not refs:api('git/refs',{'ref':'refs/tags/'+TAG,'sha':SOURCE})
else:assert len(refs)==1 and refs[0]['object']['sha']==SOURCE
published=api('releases/'+str(release['id']),{'draft':False,'prerelease':True,'make_latest':'false'},'PATCH')
assert not published['draft'] and published['published_at']
assert api('git/ref/tags/'+TAG)['object']['sha']==SOURCE and api('git/ref/heads/main')['object']['sha']==SOURCE
receipt={'release_url':published['html_url'],'source_commit':SOURCE,'main_updated':True,'tag':TAG,
    'readback_verified':True,'assets':[{'name':p.name,'size':p.stat().st_size,'sha256':digest(p)} for p in files]}
Path('aiTemp/origin-release-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
