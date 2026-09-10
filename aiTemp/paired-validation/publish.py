"""Publish exact retained EXE bytes only after independent paired browser validation.
Build and validation commits/runs are deliberately distinct and recorded, never relabeled.
"""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,zipfile
REPO='p90-lover/coding-tools-mcp';BASE='07faa97255e6b60d909f956fa2cebd3b829bbf97'
BUILD='9c749e1eb7030c25a6f84cc81e4719b6e01bef7d';BUILD_RUN='34456274103'
EXT='b0d4db553227fa3c7300050b8edff6e2eb9afee4';TAG='v0.4.3-rc.3';VERSION='0.4.3-rc.3'
VALIDATION=os.environ['GITHUB_SHA'];RUN=os.environ['GITHUB_RUN_ID']
assert os.environ['GITHUB_REPOSITORY']==REPO
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==VALIDATION
subprocess.run(['git','merge-base','--is-ancestor',BUILD,VALIDATION],check=True)
changes=subprocess.check_output(['git','diff','--name-only',BUILD,VALIDATION],text=True).splitlines()
allowed={'.github/workflows/paired-browser-diagnostic.yml','.github/workflows/paired-release-recovery.yml'}
assert changes and all(path in allowed or path.startswith('aiTemp/paired-validation/') for path in changes),changes
assert not subprocess.check_output(['git','diff','--diff-filter=D','--name-only',BUILD,VALIDATION]).strip()

def api(path,body=None,method=None):
    args=['gh','api',f'repos/{REPO}/{path}'];data=None
    if body is not None:args+=['--method',method or 'POST','--input','-'];data=json.dumps(body).encode()
    return json.loads(subprocess.check_output(args,input=data,timeout=90))
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def download(run,name,dest):
    subprocess.run(['gh','run','download',run,'--repo',REPO,'--name',name,'--dir',str(dest)],check=True,timeout=120)
def require_jobs(run,names):
    snapshot=api(f'actions/runs/{run}/jobs?per_page=100')
    assert snapshot['total_count']==len(snapshot['jobs'])
    for name in names:
        jobs=[j for j in snapshot['jobs'] if j['name']==name]
        assert len(jobs)==1 and jobs[0]['conclusion']=='success',(run,name)
require_jobs(BUILD_RUN,['prepare','origin','windows'])
require_jobs(RUN,['validate'])
assert not api('git/matching-refs/tags/'+TAG),'Existing tag must never be overwritten'
assert api('git/ref/heads/main')['object']['sha']==BASE,'Concurrent main changes need reconciliation'
assert api('git/ref/heads/release/main-extension-0.4.3-rc.3')['object']['sha']==VALIDATION
root=Path('aiTemp/paired-publication');root.mkdir(parents=True,exist_ok=False)
for kind in ['installer','windows-evidence','origin-evidence']:
    download(BUILD_RUN,f'oauth-popup-{kind}-{BUILD_RUN}',root/kind)
download(RUN,'paired-browser-evidence-'+RUN,root/'browser')
download(RUN,'paired-extension-'+RUN,root/'extension')
proof=json.loads((root/'installer/proof.json').read_text())
assert proof['source_commit']==BUILD and proof['version']==VERSION and proof['workflow_run']==int(BUILD_RUN)
assert proof['oauth_regressions_passed']==4 and proof['catalog_regressions_passed']==2
assert not proof['codex_executable_invoked'] and proof['model_requests']==0
assert proof['validated_callback_csp'] and proof['binary_verification']['all_other_bytes_identical']
origin=root/'origin-evidence'
assert '3 passed; 0 failed' in (origin/'green.txt').read_text()
assert 'POPUP_ORIGIN_BLOCKED' in (origin/'released-red.txt').read_text()
assert 'HOST_MUST_NOT_SELECT_TRUST' in (origin/'main-red.txt').read_text()
browser=json.loads((root/'browser/browser-csp.json').read_text())
assert browser['source']==BUILD and browser['passed'] and not browser['live_chatgpt_account'] and browser['model_requests']==0
assert browser['validation_source']==VALIDATION and browser['validation_run']==int(RUN)
assert 'non-listening loopback proxy' in browser['network_isolation']
assert [(c['case'],c['callback_reached']) for c in browser['cases']]==[('old_policy',False),('fixed_policy',True),('wrong_destination',False)]
assert browser['extension_source']==EXT and browser['extension_helper_replayed'] and browser['profile_contract_checked']
ext=json.loads((root/'extension/extension-proof.json').read_text())
assert ext['source_commit']==EXT and ext['version']=='0.0.7' and ext['desktop_source']==BUILD
assert ext['workflow_run']==int(RUN) and ext['focused_groups_passed']==4 and ext['model_requests']==0
assert ext['actual_form_replay_passed'] and ext['profile_contract_checked']
name=f'Coding.Tools.MCP_{VERSION}_x64-setup.exe';binary=root/'installer'/name
assert proof['asset']==name and digest(binary)==proof['sha256'] and binary.stat().st_size==proof['size']
assert digest(binary)=='ef8916614c60098e0fa4c5c0a626b33754ab0f54a752cd164d7d39f9e1c176d6'
extname='coding-tools-mcp-extension-v0.0.7.zip';archive=root/'extension'/extname
assert digest(archive)==ext['sha256'] and archive.stat().st_size==ext['size']
assets=root/'assets';assets.mkdir();shutil.copy2(binary,assets/name);shutil.copy2(archive,assets/extname)
provenance={'version':VERSION,'source_commit':BUILD,'workflow_run':int(BUILD_RUN),'main_commit':VALIDATION,
    'validation_source':VALIDATION,'validation_run':int(RUN),'validation_only_changes':changes,
    'compiled_inputs_unchanged':True,'preserved_main':BASE,'windows':proof,'browser':browser,'extension':ext,
    'live_chatgpt_account_verified':False,'model_requests':0}
(assets/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
with zipfile.ZipFile(assets/'validation-evidence.zip','x',zipfile.ZIP_DEFLATED) as z:
    for directory in [root/'windows-evidence',origin,root/'browser']:
        for p in sorted(directory.rglob('*')):
            assert not p.is_symlink()
            if p.is_file():
                assert p.suffix in {'.txt','.json','.py'} and p.stat().st_size<16*1024*1024
                z.write(p,p.relative_to(root).as_posix())
    z.write(root/'extension/extension-proof.json','extension/extension-proof.json')
(assets/'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(assets.iterdir())))
files=sorted(assets.iterdir());assert len(files)==5
notes=Path(f'docs/releases/{TAG}.md').read_text(encoding='utf-8')
notes+=f'''\n\n## Exact build and validation / 精確建置與驗證

Installer source / 安裝程式原始碼: `{BUILD}`.
Build run / 建置紀錄: https://github.com/{REPO}/actions/runs/{BUILD_RUN}
Main and validation source / Main 與驗證原始碼: `{VALIDATION}`.
Paired validation / 配對驗證: https://github.com/{REPO}/actions/runs/{RUN}

The original browser replay missed redirect hops in Playwright routing and encountered a public Cloudflare challenge using synthetic callback data only. The corrected replay intercepts every hop with CDP Fetch and has a non-listening loopback proxy as an egress backstop. The actual extension and Desktop application code were unchanged. Main adds only validation/CI files after the exact installer commit; `provenance.json` records both commits and runs. The installer was not relabeled as a new build. Windows remains publisher-unsigned. No live user account or actual tool execution was verified.

原先瀏覽器重播未攔截 Playwright 重新導向的後續請求，僅以模擬回呼資料碰到公開 Cloudflare 驗證。修正後使用 CDP Fetch 攔截每次重新導向，並以無服務監聽的本機 Proxy 阻止未攔截請求對外連線。擴充功能及 Desktop 正式程式碼均未改動；Main 在安裝程式指定 Commit 之後只新增驗證／CI 檔案，`provenance.json` 分別記錄兩個 Commit 及執行紀錄，不會把既有安裝包冒充新建置。Windows 仍沒有發行者簽章，亦未驗證真實帳戶或實際工具執行。
'''
release=api('releases',{'tag_name':TAG,'target_commitish':BUILD,'name':f'Coding Tools MCP {TAG} — verified OAuth and extension pair','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
Path('aiTemp/paired-release-draft.json').write_text(json.dumps({'id':release['id'],'source':BUILD,'tag':TAG}))
for p in files:subprocess.run(['gh','release','upload',TAG,str(p),'--repo',REPO],check=True,timeout=120)
readback=root/'readback';readback.mkdir()
subprocess.run(['gh','release','download',TAG,'--repo',REPO,'--dir',str(readback)],check=True,timeout=120)
assert {p.name for p in readback.iterdir()}=={p.name for p in files}
for p in files:assert digest(readback/p.name)==digest(p),p.name
assert api('git/ref/heads/main')['object']['sha']==BASE
api('git/refs/heads/main',{'sha':VALIDATION,'force':False},'PATCH')
refs=api('git/matching-refs/tags/'+TAG)
if not refs:api('git/refs',{'ref':'refs/tags/'+TAG,'sha':BUILD})
else:assert len(refs)==1 and refs[0]['object']['sha']==BUILD
public=api('releases/'+str(release['id']),{'draft':False,'prerelease':True,'make_latest':'false'},'PATCH')
assert not public['draft'] and public['published_at']
assert api('git/ref/tags/'+TAG)['object']['sha']==BUILD
assert api('git/ref/heads/main')['object']['sha']==VALIDATION
receipt={'release_url':public['html_url'],'source_commit':BUILD,'main_commit':VALIDATION,'tag':TAG,'main_updated':True,
    'verified_uploaded_bytes':True,'validation_run':int(RUN),'assets':[{'name':p.name,'sha256':digest(p),'size':p.stat().st_size} for p in files]}
Path('aiTemp/paired-release-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
