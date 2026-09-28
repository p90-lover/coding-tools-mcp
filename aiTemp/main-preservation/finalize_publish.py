"""Publish the verified rc4 installer, preserving concurrent main and authentic build identity."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,zipfile
from finalize_source import BUILD,MAIN,BRANCH,REPO,verify_inputs
BUILD_RUN='34457693571'
VERSION='0.4.3-rc.4';TAG='v'+VERSION
VALIDATION=os.environ['VALIDATION_SOURCE'];RUN=os.environ['GITHUB_RUN_ID']
EXE_SHA='21796c974102105726c0ef4a99267bb05ec202d66583b6dc9db8780612551a81'
assert os.environ['GITHUB_REPOSITORY']==REPO
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==VALIDATION
for source in [MAIN,BUILD]:subprocess.run(['git','merge-base','--is-ancestor',source,VALIDATION],check=True)
input_proof=verify_inputs(VALIDATION)
def api(path,body=None,method=None):
    args=['gh','api',f'repos/{REPO}/{path}'];data=None
    if body is not None:args+=['--method',method or 'POST','--input','-'];data=json.dumps(body).encode()
    return json.loads(subprocess.check_output(args,input=data,timeout=90))
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def download(run,name,dest):subprocess.run(['gh','run','download',run,'--repo',REPO,'--name',name,'--dir',str(dest)],check=True,timeout=120)
def require_jobs(run,names):
    snapshot=api(f'actions/runs/{run}/jobs?per_page=100')
    assert snapshot['total_count']==len(snapshot['jobs'])
    for name in names:
        jobs=[j for j in snapshot['jobs'] if j['name']==name]
        assert len(jobs)==1 and jobs[0]['conclusion']=='success',(run,name)
require_jobs(BUILD_RUN,['prepare','origin','windows','browser'])
require_jobs(RUN,['reconcile_validate'])
assert not api('git/matching-refs/tags/'+TAG),'Never overwrite an existing tag or release'
assert api('git/ref/heads/main')['object']['sha']==MAIN,'Concurrent main changed again'
assert api('git/ref/heads/'+BRANCH)['object']['sha']==VALIDATION
root=Path('aiTemp/rc4-final-publication');root.mkdir(parents=True,exist_ok=False)
for kind in ['installer','windows-evidence','origin-evidence','browser-evidence']:
    download(BUILD_RUN,f'oauth-popup-{kind}-{BUILD_RUN}',root/kind)
download(RUN,'rc4-reconciliation-'+RUN,root/'reconciliation')
proof=json.loads((root/'installer/proof.json').read_text())
assert proof['source_commit']==BUILD and proof['version']==VERSION and proof['workflow_run']==int(BUILD_RUN)
assert proof['oauth_regressions_passed']==4 and proof['catalog_regressions_passed']==2 and proof['file_safety_regressions_passed']==3
assert proof['read_file_input_cap_bytes']==16777216
assert not proof['codex_executable_invoked'] and proof['model_requests']==0
assert proof['validated_callback_csp'] and proof['binary_verification']['all_other_bytes_identical']
assert proof['catalog_counts']=={'core':57,'advanced':70}
assert proof['publisher_signed'] is False and not proof['live_user_chatgpt_connection_verified']
for name,count in [('oauth-tests.txt',4),('catalog-tests.txt',2),('file-safety.txt',3),('connection-tests.txt',10)]:
    assert f'{count} passed; 0 failed' in (root/'windows-evidence'/name).read_text(encoding='utf-8-sig')
origin=root/'origin-evidence'
assert '3 passed; 0 failed' in (origin/'green.txt').read_text()
assert 'POPUP_ORIGIN_BLOCKED' in (origin/'released-red.txt').read_text()
assert 'HOST_MUST_NOT_SELECT_TRUST' in (origin/'main-red.txt').read_text()
for directory in ['browser-evidence','reconciliation']:
    browser=json.loads((root/directory/'browser-csp.json').read_text())
    assert browser['source']==BUILD and browser['passed'] and not browser['live_chatgpt_account'] and browser['model_requests']==0
    assert browser['external_network_blocked'] and browser['screenshots_written']==0
    assert [(c['case'],c['callback_reached']) for c in browser['cases']]==[('old_policy',False),('fixed_policy',True),('wrong_destination',False)]
    assert all(not call.get('has_post_body',False) for case in browser['cases'] for call in case['requests'] if call['target']=='callback')
reconciled=json.loads((root/'reconciliation/reconciled-inputs.json').read_text())
assert reconciled['main_commit']==VALIDATION and reconciled['source_commit']==BUILD and reconciled['preserved_main']==MAIN
assert reconciled['input_manifest']==input_proof['input_manifest'] and reconciled['production_and_build_inputs_identical']
assert reconciled['validation_run']==int(RUN) and reconciled['binary_rebuilt'] is False
name=f'Coding.Tools.MCP_{VERSION}_x64-setup.exe';binary=root/'installer'/name
assert proof['asset']==name and digest(binary)==proof['sha256']==EXE_SHA and binary.stat().st_size==proof['size']
assets=root/'assets';assets.mkdir();shutil.copy2(binary,assets/name)
provenance={'version':VERSION,'source_commit':BUILD,'workflow_run':int(BUILD_RUN),'main_commit':VALIDATION,
    'validation_source':VALIDATION,'validation_run':int(RUN),'preserved_main':MAIN,'binary_rebuilt':False,
    'compiled_inputs_unchanged':True,'input_equivalence':reconciled,'windows':proof,'browser':browser,
    'live_chatgpt_account_verified':False,'model_requests':0}
(assets/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
with zipfile.ZipFile(assets/'validation-evidence.zip','x',zipfile.ZIP_DEFLATED) as archive:
    for directory in [root/'windows-evidence',origin,root/'browser-evidence',root/'reconciliation']:
        for path in sorted(directory.rglob('*')):
            assert not path.is_symlink()
            if path.is_file():
                assert path.suffix in {'.txt','.json','.py'} and path.stat().st_size<16*1024*1024
                archive.write(path,path.relative_to(root).as_posix())
(assets/'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(assets.iterdir())))
files=sorted(assets.iterdir());assert len(files)==4
notes=Path('docs/releases/'+TAG+'.md').read_text(encoding='utf-8')
notes+='''\n\n## Reconciled main and original build / Main 整合及原始建置

The first publication attempt safely stopped because a concurrent verified Desktop/extension update reached main. Both histories and support files are now preserved. The Windows installer remains the exact rc.4 bytes built and tested at BUILD_SOURCE; it is not relabeled as a rebuild from FINAL_MAIN. A complete tracked-input manifest confirms that all application/build inputs are identical; only explicitly listed validation, release-support and archived support files differ. The release tag names the actual installer source, while main includes the preserved concurrent work. See provenance.json for both commits, workflow runs and the input-manifest digest. This does not install or test the user's local Desktop or live ChatGPT account.

首次發佈因另一項已驗證的 Desktop／擴充功能更新進入 main 而被安全檢查停止。現在已保留雙方歷史及支援檔案。Windows installer 仍是 BUILD_SOURCE 編譯及測試的確切 rc.4 檔案，不會冒稱由 FINAL_MAIN 重新編譯。完整受版控輸入清單確認所有正式程式及編譯輸入相同；只有明確列出的驗證、發佈支援及封存支援檔案不同。Release tag 指向真正 installer 原始碼，main 則包含並行更新；provenance.json 分別記錄 commit、工作流程及輸入清單雜湊。本次並未安裝或測試使用者本機 Desktop 或真實 ChatGPT 帳戶。
'''.replace('BUILD_SOURCE','`'+BUILD+'`').replace('FINAL_MAIN','`'+VALIDATION+'`')
release=api('releases',{'tag_name':TAG,'target_commitish':BUILD,'name':f'Coding Tools MCP {TAG} — preserved features and verified repairs','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
Path('aiTemp/rc4-draft.json').write_text(json.dumps({'id':release['id'],'tag':TAG,'source':BUILD}))
for path in files:subprocess.run(['gh','release','upload',TAG,str(path),'--repo',REPO],check=True,timeout=120)
readback=root/'readback';readback.mkdir()
subprocess.run(['gh','release','download',TAG,'--repo',REPO,'--dir',str(readback)],check=True,timeout=120)
assert {p.name for p in readback.iterdir()}=={p.name for p in files}
for path in files:assert digest(readback/path.name)==digest(path),path.name
assert api('git/ref/heads/main')['object']['sha']==MAIN
api('git/refs/heads/main',{'sha':VALIDATION,'force':False},'PATCH')
refs=api('git/matching-refs/tags/'+TAG)
if not refs:api('git/refs',{'ref':'refs/tags/'+TAG,'sha':BUILD})
else:assert len(refs)==1 and refs[0]['object']['sha']==BUILD
public=api('releases/'+str(release['id']),{'draft':False,'prerelease':True,'make_latest':'false'},'PATCH')
assert not public['draft'] and public['published_at']
assert api('git/ref/tags/'+TAG)['object']['sha']==BUILD
assert api('git/ref/heads/main')['object']['sha']==VALIDATION
receipt={'release_url':public['html_url'],'source_commit':BUILD,'main_commit':VALIDATION,'tag':TAG,
    'main_updated':True,'verified_uploaded_bytes':True,'validation_run':int(RUN),
    'assets':[{'name':p.name,'sha256':digest(p),'size':p.stat().st_size} for p in files]}
Path('aiTemp/rc4-publication-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
