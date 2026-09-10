"""Expand reviewed source before compiling; preserve originals and validate canonical Git bytes."""
from pathlib import Path
import ast,base64,hashlib,json,lzma,os,shutil,subprocess
BASE='35b13594ddb3ba70011b2c47cec840e6a0dba3e1'
EXPECTED='3ef1d7aaf89ecb2ecc8d8c01a87b75a27a00dc99160489d11019aa17d026f5c4'
ROOT=Path('aiTemp/sandbox-permissions')
PATHS='''src-tauri/src/tools/native_sandbox.rs
src-tauri/src/tools/sandbox_snapshot.rs
src-tauri/src/tools/sandbox_runner.rs
aiTemp/sandbox-permissions/contract.rs
native-helpers/app-container/main.cpp
native-helpers/app-container/CMakeLists.txt
aiTemp/completion/native_test.py
aiTemp/completion/native_probe.cpp
src-tauri/Cargo.toml
src-tauri/src/commands/sandbox.rs
src-tauri/src/tools/live_policy.rs
src-tauri/src/runtime/supervisor.rs
src-tauri/src/tools/approval.rs
src-tauri/src/tools/registry_definitions.rs
src-tauri/src/tools/registry.rs
src/lib/components/SandboxControl.svelte
docs/features/native-command-sandbox.md
docs/features/native-sandbox-read-boundary.md
native-helpers/NOTICE.md
docs/releases/v0.4.4-rc.1.md
package.json
package-lock.json
src-tauri/Cargo.lock
src-tauri/tauri.conf.json
README.md
README.en.md
aiTemp/sandbox-permissions/impact.md'''.splitlines()
def sha(data):return hashlib.sha256(data).hexdigest()
def backup(path):
    if path.exists():
        target=Path('aiTemp/Trash/snapshot-before')/os.environ['GITHUB_RUN_ID']/path
        target.parent.mkdir(parents=True,exist_ok=True)
        assert not target.exists() and not path.is_symlink()
        shutil.copy2(path,target)
def once(s,old,new):
    assert s.count(old)==1,(old,s.count(old))
    return s.replace(old,new,1)
encoded=''.join((ROOT/f'candidate.part{i}').read_text().strip() for i in range(3))
assert len(encoded)==41376,'Truncated staged source'
unpacker=lzma.LZMADecompressor(memlimit=128*1024*1024)
decoded=unpacker.decompress(base64.b64decode(encoded,validate=True),max_length=1024*1024)
assert unpacker.eof and not unpacker.unused_data and sha(decoded)==EXPECTED,'Staged source hash mismatch'
payload=json.loads(decoded)
assert payload['base']==BASE and set(payload['before_sha256'])==set(PATHS)
canonical={};normalized=[]
for name,expected in payload['before_sha256'].items():
    path=Path(name);assert not path.is_symlink()
    if expected is None:
        assert not path.exists(),name
        continue
    blob=subprocess.check_output(['git','show','HEAD:'+name])
    assert sha(blob)==expected,'Committed source changed: '+name
    working=path.read_bytes()
    assert working in (blob,blob.replace(b'\n',b'\r\n')),'Unexpected working-tree edit: '+name
    canonical[name]=blob
    if working!=blob:normalized.append(name)
# Preserve CRLF checkout bytes; apply against the exact verified Git content.
for name in PATHS:backup(Path(name))
for name,blob in canonical.items():Path(name).write_bytes(blob)
patch=ROOT/'expanded.patch';assert not patch.exists()
patch.write_bytes(payload['patch'].encode('utf-8'))
subprocess.run(['git','-c','core.autocrlf=false','apply','--check',str(patch)],check=True)
subprocess.run(['git','-c','core.autocrlf=false','apply',str(patch)],check=True)
name='src-tauri/src/tools/registry_definitions.rs';s=Path(name).read_text()
for constant in ['CORE_READ_ONLY_TOOLS','READ_ONLY_TOOLS']:
    start=s.index(f'pub const {constant}:');end=s.index('];',start)
    section=once(s[start:end],'    "sandbox_exec",\n','')
    s=s[:start]+section+s[end:]
Path(name).write_text(s)
name='src-tauri/src/tools/catalog.rs';path=Path(name);backup(path);s=path.read_text()
s=once(s,'.filter(|n| *n == "sandbox_exec").collect::<Vec<_>>()', '.filter(|n| *n == "sandbox_exec" && !crate::tools::native_sandbox::available()).collect::<Vec<_>>()')
s=once(s,'assert_eq!(describe("read-only")["advertised_count"], 42);','''assert_eq!(describe("read-only")["advertised_count"], 41);
        assert!(!describe("read-only")["advertised_names"].as_array().unwrap().iter().any(|n| n == "sandbox_exec"));
        assert_eq!(full["advertised_but_unavailable"].as_array().unwrap().is_empty(), crate::tools::native_sandbox::available());''')
path.write_text(s);PATHS.append(name)
# A stop request is not proof that every child has already joined.
name='src/lib/components/SandboxControl.svelte';s=Path(name).read_text()
s=once(s,'Stopped all snapshot jobs and revoked saved approvals. Files retained. · 已停止所有快照工作並撤銷授權，檔案保留。','Stop requested; saved approvals revoked. Owned processes are being terminated; files retained. · 已要求停止並撤銷授權，正在終止所屬程序，檔案保留。')
Path(name).write_text(s)
name='src-tauri/src/tools/sandbox_runner.rs';s=Path(name).read_text()
s=once(s,'value["original_workspace_modified"]=json!(false);','value["direct_workspace_access_granted"]=json!(false); value["original_workspace_modified"]=Value::Null;')
Path(name).write_text(s)
name='src-tauri/src/tools/native_sandbox.rs';s=Path(name).read_text()
s=once(s,'if profile.runtime.permission_mode=="read-only"','if crate::tools::policy::PolicySettings::from_runtime(&profile.runtime).canonical_permission_mode()=="read-only"')
Path(name).write_text(s)
for name in PATHS:
    if name.endswith('.rs'):subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
ast.parse(Path('aiTemp/completion/native_test.py').read_text())
assert json.loads(Path('package.json').read_text())['version']=='0.4.4-rc.1'
subprocess.run(['git','add','--',*PATHS],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
changed=set(subprocess.check_output(['git','diff','--cached','--name-only'],text=True).splitlines())
assert changed==set(PATHS),(sorted(changed-set(PATHS)),sorted(set(PATHS)-changed))
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
subprocess.run(['git','diff','--exit-code',BASE,'--','src-tauri/src/auth','src-tauri/src/mcp','aiTemp/origin-repair'],check=True)
Path('aiTemp/evidence').mkdir(parents=True,exist_ok=True)
Path('aiTemp/evidence/materialization.json').write_text(json.dumps({'base':BASE,'payload_sha256':EXPECTED,'expanded_reviewable_files':PATHS,'normalized_checkout_line_endings':normalized,'deleted_paths':[]},indent=2)+'\n')
print('Expanded verified Git source; checkout originals preserved; OAuth implementation unchanged.')
