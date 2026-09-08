"""Publish exact verified installers; no rebuild, file deletion, or model calls."""
import base64, hashlib, json, os, re, shutil, subprocess, zipfile
from pathlib import Path

repo=os.environ['GITHUB_REPOSITORY'];source=os.environ['VERIFIED_SOURCE'];build_run=int(os.environ['VERIFIED_RUN'])
version='0.3.6-rc.1';tag='v'+version;upstream='3caf9f9586baedb4158a7b91545ead3dd320c348'
source_branch='release/remembered-control-network'
def api(path,method='GET',body=None):
    args=['gh','api',f'repos/{repo}/{path}','--method',method];data=None
    if body is not None:args+=['--input','-'];data=json.dumps(body).encode()
    return json.loads(subprocess.check_output(args,input=data,timeout=90))
def require(condition,message):
    if not condition:raise RuntimeError(message)
require(re.fullmatch('[a-f0-9]{40}',source),'Exact source commit required')
run=api(f'actions/runs/{build_run}')
require(run['status']=='completed' and run['conclusion']=='success' and run['head_sha']==source,'Exact native verification run must be green')
require(run['head_repository']['full_name']==repo and run['event']=='push','Unexpected verification origin')
require(run['head_branch']==source_branch and run['path']=='.github/workflows/remembered-network-verify.yml','Wrong native workflow')
response=api(f'actions/runs/{build_run}/jobs?per_page=100')
require(response['total_count']==len(response['jobs']),'Incomplete job listing')
jobs={j['name']:j for j in response['jobs']}
for name in ('native (windows-latest, windows-x64)','native (macos-14, macos-arm64)'):
    require(name in jobs and jobs[name]['conclusion']=='success','Native job missing: '+name)
for step in ('Compile only pinned sandbox helpers','Native isolation with positive controls','Real Windows background observation and input','Build and verify actual installer resources'):
    matches=[s for s in jobs['native (windows-latest, windows-x64)']['steps'] if s['name']==step]
    require(len(matches)==1 and matches[0]['conclusion']=='success','Native gate failed: '+step)
root=Path('aiTemp/installers');evidence=Path('aiTemp/evidence');dest=Path('aiTemp/release-assets');dest.mkdir(parents=True,exist_ok=False)
proofs=[json.loads(p.read_text(encoding='utf-8')) for p in root.glob('*/proof.json')]
require(len(proofs)==2 and {p['platform'] for p in proofs}=={'windows-x64','macos-arm64'},'Both installer platforms required')
for p in proofs:
    require(p['source_commit']==source and p['version']==version,'Installer identity mismatch')
    require(p['screenshot_storage']=='memory_only' and p['codex_agent_invoked'] is False,'Unexpected execution/storage contract')
    if p['platform']=='windows-x64':
        require(p['native_fixture_verified'] and p['native_sandbox_verified'],'Missing Windows native verification')
        require(re.fullmatch('[a-f0-9]{64}',p['sandbox_manifest_sha256']),'Helper manifest digest missing')
    require(Path(p['asset']).name==p['asset'],'Unsafe asset name')
    assets=list(root.glob('*/'+p['asset']));require(len(assets)==1,'Installer must be unique');asset=assets[0]
    require(asset.is_file() and not asset.is_symlink(),'Invalid installer')
    require(asset.stat().st_size==p['size'] and hashlib.sha256(asset.read_bytes()).hexdigest()==p['sha256'],'Installer bytes changed')
    shutil.copy2(asset,dest/asset.name)
windows=[p for p in evidence.iterdir() if p.is_dir() and 'windows-x64' in p.name]
require(len(windows)==1,'Windows evidence must be unique');we=windows[0]
isolation=json.loads((we/'sandbox-proof.json').read_text(encoding='utf-8'))
require(isolation['native_verified'] is True and isolation['model_session_invoked'] is False and isolation['upstream_commit']==upstream,'Missing isolation evidence')
require(set(isolation['checks'])=={'native_allowed_read','native_write_handle_denied','native_private_acl_read_denied','native_shared_read_scope_reported','native_loopback_denied_with_positive_control','maintenance_file_retained'},'Native positive/negative controls incomplete')
require(isolation.get('read_scope')=='sandbox_account_acl_not_path_whitelist' and isolation.get('maintenance_retention_verified') is True,'Read boundary or maintenance retention not verified')
smoke=(we/'native-smoke.txt').read_text(encoding='utf-8')
require('1 passed; 0 failed' in smoke and 'background discovery/UIA/RAM capture without focus' in smoke and 'identical local/MCP pixels' in smoke,'Desktop smoke incomplete')
folders=[p for p in evidence.iterdir() if p.is_dir()]
require(len(folders)==2,'Exactly two platform evidence directories required')
for folder in folders:
    require(json.loads((folder/'proof.json').read_text(encoding='utf-8'))['source_commit']==source,'Evidence source mismatch')
    for filename in ('computer-tests.txt','sandbox-contract.txt','vision-tests.txt','catalog.txt'):
        require(re.search(r'test result: ok\. [1-9][0-9]* passed; 0 failed',(folder/filename).read_text(encoding='utf-8')),'No passing tests: '+filename)
manifest=(we/'sandbox-manifest.json').read_bytes();wp=next(p for p in proofs if p['platform']=='windows-x64')
require(hashlib.sha256(manifest).hexdigest()==wp['sandbox_manifest_sha256'] and json.loads(manifest)['upstream_commit']==upstream,'Packaged helper manifest mismatch')
origin=json.loads((we/'sandbox-build-origin.json').read_text(encoding='utf-8'))
require(origin['source_commit']==source and origin['workflow_run']==build_run and origin['fresh_build'] is True,'Helpers must be freshly built with this source')
require(origin['upstream_commit']==upstream and origin['manifest_sha256']==wp['sandbox_manifest_sha256'] and origin['native_test_waived'] is False,'Helper build provenance mismatch')
require(origin['network_policy']=='app_owned_offline_ale_v4_v6_no_direct_ip','Mandatory network adapter missing')
inputs={'native-helpers/prepare_upstream.py','native-helpers/prepare_network.py','native-helpers/codex_sandbox_bridge.rs','native-helpers/retained_files.rs','native-helpers/LICENSE-Codex','native-helpers/NOTICE.md','.github/workflows/remembered-control-release.yml','aiTemp/release-verification/run_step.py','.github/workflows/remembered-network-verify.yml'}
require(set(origin['identical_source_blobs'])==inputs,'Incomplete helper build inputs')
for name,digest in origin['identical_source_blobs'].items():
    require(api(f'contents/{name}?ref={source}')['sha']==digest,'Helper source changed: '+name)
provenance={'version':version,'source_commit':source,'workflow_run':build_run,'publication_run':int(os.environ['GITHUB_RUN_ID']),'prerelease':True,'sandbox_upstream_commit':upstream,'sandbox_build_origin':origin,'sandbox_read_scope':isolation['read_scope'],'installers':proofs}
(dest/'release-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n',encoding='utf-8')
with zipfile.ZipFile(dest/'computer-use-validation.zip','x',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(evidence.rglob('*')):
        if p.is_file():
            require(not p.is_symlink() and p.suffix in {'.json','.txt'},'Unexpected evidence file')
            z.write(p,p.relative_to(evidence).as_posix())
files=sorted(dest.iterdir())
(dest/'SHA256SUMS.txt').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files),encoding='utf-8')
require(api('git/ref/heads/'+source_branch)['object']['sha']==source,'Release source branch advanced')
require(not api('git/matching-refs/tags/'+tag),'Existing tags are never replaced')
notes=base64.b64decode(api(f'contents/docs/releases/{tag}.md?ref={source}')['content']).decode('utf-8')
require('not a path whitelist' in notes and 'Windows Filtering Platform' in notes and 'read-only workspace/platform access' not in notes,'Release notes must describe actual read/network boundaries')
notes+='\n\nVerified before publication: matching-source Windows and macOS installers; native positive/negative controls for workspace/shared reads, denied workspace write handles, denied ACL-private reads and denied direct TCP loopback connections; real Windows background discovery/UIA/input/RAM-image fixture; old sandbox report preserved byte-for-byte in protected Trash; packaged helper manifests and binary hashes. All release assets were downloaded again and checked before becoming public.\n\n公開前已驗證：相同來源的 Windows／macOS 安裝程式、原生正反向讀取／寫入／私人 ACL／直接 TCP 迴路封鎖測試、真實 Windows 背景視窗／UIA／輸入／記憶體圖片測試、舊沙箱報告完整保留於受保護 Trash，以及實際打包的輔助程式清單與雜湊。所有發佈檔案均重新下載核對，才公開發佈。\n'
api('git/refs','POST',{'ref':'refs/tags/'+tag,'sha':source})
draft=api('releases','POST',{'tag_name':tag,'target_commitish':source,'name':f'Coding Tools MCP {tag} — remembered control, background vision and native sandbox','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
ident=draft['id'];Path('aiTemp/draft-id.txt').write_text(str(ident)+'\n');expected={}
for p in sorted(dest.iterdir()):
    digest='sha256:'+hashlib.sha256(p.read_bytes()).hexdigest();expected[p.name]=(p.stat().st_size,digest)
    url=f'https://uploads.github.com/repos/{repo}/releases/{ident}/assets?name={p.name}'
    asset=json.loads(subprocess.check_output(['gh','api',url,'--method','POST','--header','Content-Type: application/octet-stream','--input',str(p)],timeout=180))
    require(asset['name']==p.name and (asset['size'],asset['digest'])==expected[p.name],'Upload mismatch')
    downloaded=subprocess.check_output(['gh','api',f'repos/{repo}/releases/assets/{asset["id"]}','--header','Accept: application/octet-stream'],timeout=180)
    require(len(downloaded)==p.stat().st_size and 'sha256:'+hashlib.sha256(downloaded).hexdigest()==digest,'Downloaded asset mismatch')
current=api('releases/'+str(ident))
require(current['draft'] and current['tag_name']==tag,'Draft identity mismatch')
require({a['name']:(a['size'],a['digest']) for a in current['assets']}==expected,'Asset inventory mismatch')
require(api('git/ref/tags/'+tag)['object']['sha']==source and api('git/ref/heads/'+source_branch)['object']['sha']==source,'Release source moved')
api('releases/'+str(ident),'PATCH',{'draft':False,'prerelease':True,'make_latest':'false','target_commitish':source})
public=api('releases/tags/'+tag)
require(public['id']==ident and public['draft'] is False and public['published_at'],'Publication not confirmed')
require({a['name']:(a['size'],a['digest']) for a in public['assets']}==expected and api('git/ref/tags/'+tag)['object']['sha']==source,'Published asset or tag mismatch')
receipt={'source_commit':source,'release_id':ident,'url':public['html_url'],'draft':False,'prerelease':True,'assets':[{k:a[k] for k in ('name','size','digest','browser_download_url')} for a in public['assets']]}
Path('aiTemp/publication-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps(receipt,indent=2))
