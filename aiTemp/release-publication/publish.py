"""Publish only the pinned, tested Windows bytes. No deletion or asset replacement."""
from pathlib import Path
import hashlib, io, json, os, subprocess, urllib.parse, zipfile

REPO = 'p90-lover/coding-tools-mcp'
SOURCE = '3aa7e27b017f3f0ef402f569e7b14b5aa0faad23'
RUN = 34329651000
VERSION = '0.4.2-rc.1'
TAG = 'v' + VERSION
BRANCH = 'release/codex-local-tools-0.4.2-rc.1'
ROOT = Path('aiTemp/publication')
OUT = ROOT/'assets'
OUT.mkdir(parents=True, exist_ok=True)

def sha(b): return hashlib.sha256(b).hexdigest()
def put(path, data):
    if path.exists(): assert path.read_bytes() == data, f'Refusing replacement: {path}'
    else:
        with path.open('xb') as f: f.write(data)
def api(path, method='GET', body=None):
    args=['gh','api',f'repos/{REPO}/{path}','--method',method]
    payload=None
    if body is not None: args+=['--input','-'];payload=json.dumps(body).encode()
    return json.loads(subprocess.check_output(args,input=payload,timeout=90))

run=api(f'actions/runs/{RUN}')
assert run['head_sha']==SOURCE and run['status']=='completed' and run['conclusion']=='success'
jobs=api(f'actions/runs/{RUN}/jobs?per_page=100')
assert jobs['total_count']==len(jobs['jobs'])
win=[j for j in jobs['jobs'] if j['name']=='windows']
assert len(win)==1 and win[0]['conclusion']=='success'
for step in ['Frontend and focused resource, question and connection tests','Build and inspect Windows EXE']:
    found=[s for s in win[0]['steps'] if s['name']==step]
    assert len(found)==1 and found[0]['conclusion']=='success'
assert api('git/ref/heads/'+BRANCH)['object']['sha']==SOURCE
meta=api(f'actions/runs/{RUN}/artifacts?per_page=100')
assert meta['total_count']==len(meta['artifacts'])
archives={}
for prefix in ['integrated-source','integrated-windows','integrated-evidence']:
    found=[a for a in meta['artifacts'] if a['name']==f'{prefix}-{RUN}']
    assert len(found)==1 and not found[0]['expired']
    a=found[0]
    raw=subprocess.check_output(['gh','api',f'repos/{REPO}/actions/artifacts/{a["id"]}/zip'],timeout=120)
    assert a['digest']=='sha256:'+sha(raw)
    put(ROOT/(prefix+'.zip'),raw)
    archives[prefix]=zipfile.ZipFile(io.BytesIO(raw))
source=archives['integrated-source']
assert source.read('source-sha.txt').decode().strip()==SOURCE
source_files=zipfile.ZipFile(io.BytesIO(source.read('source.zip')))
assert json.loads(source_files.read('package.json'))['version']==VERSION
assert b'2025-11-25' in source_files.read('src-tauri/src/mcp/protocol.rs')
installer=archives['integrated-windows']
proof=json.loads(installer.read('proof.json'))
assert proof['source_commit']==SOURCE and proof['workflow_run']==RUN and proof['version']==VERSION
assert proof['focused_native_tests']==8 and proof['codex_invoked'] is False
assert proof['all_upstream_tools_integrated'] is False and proof['live_user_connection_verified'] is False
name=f'Coding.Tools.MCP_{VERSION}_x64-setup.exe'
assert proof['asset']==name
binary=installer.read(name)
assert binary.startswith(b'MZ') and len(binary)==proof['size'] and sha(binary)==proof['sha256']
put(OUT/name,binary)
put(OUT/'release-provenance.json',(json.dumps(proof,indent=2)+'\n').encode())
evidence=archives['integrated-evidence']
assert all(Path(n).suffix in ['.txt','.json'] for n in evidence.namelist())
assert json.loads(evidence.read('proof.json'))==proof
for file,n in [('local-tools-tests.txt',3),('connection-tests.txt',3),('catalog.txt',2)]:
    assert f'{n} passed; 0 failed' in evidence.read(file).decode('utf-8-sig')
put(OUT/'validation-evidence.zip',(ROOT/'integrated-evidence.zip').read_bytes())
buf=io.BytesIO()
with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as docs:
    for name in ['codex-local-tools.en.md','codex-local-tools.zh-Hant.md','mcp-connection-repair.md']:
        data=installer.read(name)
        assert data==source_files.read('docs/guides/'+name)
        info=zipfile.ZipInfo(name, (2026,9,9,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
        docs.writestr(info,data)
put(OUT/'English-TraditionalChinese-guides.zip',buf.getvalue())
checks=''.join(f'{sha(p.read_bytes())}  {p.name}\n' for p in sorted(OUT.iterdir()) if p.name!='SHA256SUMS.txt')
put(OUT/'SHA256SUMS.txt',checks.encode())
files=sorted(OUT.iterdir());assert len(files)==5
expected={p.name:(p.stat().st_size,'sha256:'+sha(p.read_bytes())) for p in files}
notes='''## English

Windows release candidate: quota-free local tool integration and MCP connection/protocol repair.

Adds working list_mcp_resources, list_mcp_resource_templates, read_mcp_resource, request_user_input, read_user_input, clock_sleep and wait_for_environment handlers. Includes a local human-question panel, bounded listener-owned resources, permission-interruptible waits and a pinned upstream capability inventory. Existing commands, patches, files, Git, planning, vision and approved computer control remain available according to workspace policy. No Codex/model/AI-review calls were used.

MCP now negotiates implemented 2025-03-26 / 2025-06-18 / 2025-11-25 handshake revisions rather than always returning 2025-06-18. Unsupported subsequent HTTP protocol headers are rejected explicitly. OAuth 401 replies include discovery challenges; accepted notifications use empty HTTP 202; unsupported SSE GET requests return authenticated 405. Catalog hashes and protocol diagnostics distinguish actual server output from the client's approved snapshot. Permission-only changes preserve the listener, credentials, catalog definitions and fingerprint.

A protocol fallback is not automatically a failure: disconnect is appropriate when the client cannot support the selected revision. tools.listChanged=false means no push notifications, not permanent caching. It remains false because no catalog SSE stream is provided. The five v0.4.1 tools are present in core/read-only/advanced profiles. Refresh/review the existing ChatGPT app where supported; do not delete a connector merely because a model reports no tools. Host registration, selected mode, approved action snapshots and account policy remain separate controls.

Eight focused native tests passed on Windows, including real loopback HTTP initialization/notifications/catalog/token checks, version negotiation, profile coverage, same-listener permission updates, real command-output resources, question isolation/answers and bounded waits. Frontend checks/build, bilingual documentation checks, native EXE build and binary-version verification passed. Every release asset was re-downloaded and hash-verified before publication.

Install this EXE and restart the desktop application once to load the new binary. Retain workspace, OAuth and tunnel configuration. A one-time tool-definition refresh is distinct from future permission-only changes. Screenshots stay application-level memory-only. Windows is publisher-unsigned. The user's live PC, tunnel endpoint and ChatGPT registration were not verified end to end.

This is not every internal Codex tool or the unfinished native inference bridge: model/subagent inference, host context management, host plugin installation, autonomous Paseo/Anneal engines and the unverified native command sandbox are not represented as working features. codex_tools_status reports all_upstream_tools_integrated=false and the exact capability boundaries; no fake executors or permission bypasses are provided. The 2026 stateless MCP revision is not claimed. English and Traditional Chinese workflow/learning guides are included.

## 繁體中文

Windows 候選版本：免 Codex 配額的本機工具整合，以及 MCP 連線／協定修正。

新增可實際使用的 list_mcp_resources、list_mcp_resource_templates、read_mcp_resource、request_user_input、read_user_input、clock_sleep 及 wait_for_environment。包含本機人類問答面板、有界且屬於指定監聽服務的資源、可被權限變更中斷的等待，以及固定上游版本的能力清單。原有命令、Patch、檔案、Git、計劃、視覺及已批准電腦操作依工作區權限保留，沒有呼叫 Codex／模型／AI 審查。

MCP 現協商已實作的 2025-03-26／2025-06-18／2025-11-25 握手版本，不再一律回傳 2025-06-18；初始化後不支援的 HTTP 版本標頭會明確拒絕。OAuth 401 附帶探索挑戰；已接受的通知使用空白 HTTP 202；不支援的 SSE GET 經認證後回傳 405。目錄雜湊及協定紀錄可用來區分伺服器實際輸出與用戶端已批准的快照。只修改權限時保留監聽服務、憑證、工具定義及其指紋。

協定降版不等於必定失敗；只有用戶端不支援所選版本時才應斷線。tools.listChanged=false 代表沒有推送通知，不是永久快取；本版本沒有工具目錄 SSE 串流，因此保持 false。五個 v0.4.1 工具均存在於 core／read-only／advanced 目錄。在介面支援的情況下刷新／審查既有 ChatGPT App，不要單憑模型說沒有工具就刪除連接。註冊、對話模式、已批准工具快照及帳戶政策仍是不同層面的控制。

Windows 上八項重點原生測試通過，包括真實本機 HTTP 初始化／通知／目錄／Token 檢查、版本協商、設定檔覆蓋、同一監聽服務的即時權限變更、真實命令輸出資源、問答隔離及有界等待。前端檢查／建置、雙語文件檢查、原生 EXE 建置及執行檔版本驗證均通過。公開前已重新下載所有發佈資產並驗證雜湊。

安裝 EXE 後重新啟動桌面程式一次以載入新版，保留工作區、OAuth 及隧道設定。一次性的工具定義刷新，與日後單純修改權限不同。截圖在應用程式層面仍只留記憶體。Windows 安裝程式没有發佈者簽署；使用者實機、隧道端點及 ChatGPT 註冊尚未完成端到端驗證。

這不是每項 Codex 內部工具，亦不是未完成的原生推論橋接版本。模型／子 Agent 推論、主機上下文管理、主機 Plugin 安裝、Paseo／Anneal 自主引擎及未驗證的原生命令沙箱，不會被描述成已可使用。codex_tools_status 會回傳 all_upstream_tools_integrated=false 及精確限制，不提供假成功執行器或繞過權限。亦不宣稱實作 2026 無狀態 MCP 協定。附有英文及繁體中文工作流程／學習指南。
'''
refs=api('git/matching-refs/tags/'+TAG)
existing=[r for r in refs if r['ref']=='refs/tags/'+TAG]
if existing: assert len(existing)==1 and existing[0]['object']['sha']==SOURCE
else: api('git/refs','POST',{'ref':'refs/tags/'+TAG,'sha':SOURCE})
page=1; matches=[]
while True:
    releases=api(f'releases?per_page=100&page={page}')
    matches.extend(r for r in releases if r['tag_name']==TAG)
    if len(releases)<100:break
    page+=1
assert len(matches)<=1
if matches:
    release=api('releases/'+str(matches[0]['id']))
    assert release['prerelease'] and release['target_commitish']==SOURCE
else:
    release=api('releases','POST',{'tag_name':TAG,'target_commitish':SOURCE,'name':'Coding Tools MCP '+TAG+' — local tools + connection repair','body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
ident=release['id'];put(ROOT/'release-id.txt',(str(ident)+'\n').encode())
assets={a['name']:a for a in release['assets']}
assert len(assets)==len(release['assets']) and set(assets)<=set(expected)
for path in files:
    if path.name in assets: asset=assets[path.name]
    else:
        assert release['draft']
        url=f'https://uploads.github.com/repos/{REPO}/releases/{ident}/assets?name={urllib.parse.quote(path.name)}'
        asset=json.loads(subprocess.check_output(['gh','api',url,'--method','POST','--header','Content-Type: application/octet-stream','--input',str(path)],timeout=120))
    assert asset['state']=='uploaded' and (asset['size'],asset['digest'])==expected[path.name]
    data=subprocess.check_output(['gh','api',f'repos/{REPO}/releases/assets/{asset["id"]}','--header','Accept: application/octet-stream'],timeout=120)
    assert (len(data),'sha256:'+sha(data))==expected[path.name]
assert api('git/ref/tags/'+TAG)['object']['sha']==SOURCE
assert api('git/ref/heads/'+BRANCH)['object']['sha']==SOURCE
current=api('releases/'+str(ident))
assert {a['name']:(a['size'],a['digest']) for a in current['assets']}==expected
if current['draft']:api('releases/'+str(ident),'PATCH',{'draft':False,'prerelease':True,'make_latest':'false'})
public=api('releases/tags/'+TAG)
assert not public['draft'] and public['published_at'] and public['id']==ident
assert {a['name']:(a['size'],a['digest']) for a in public['assets']}==expected
receipt={'source_commit':SOURCE,'build_run':RUN,'publication_run':int(os.environ['GITHUB_RUN_ID']),'release_id':ident,'draft':False,'prerelease':True,'url':public['html_url'],'assets':[{k:a[k] for k in ['name','size','digest','browser_download_url']} for a in public['assets']]}
put(ROOT/'publication-receipt.json',(json.dumps(receipt,indent=2)+'\n').encode())
print(json.dumps(receipt,indent=2))
