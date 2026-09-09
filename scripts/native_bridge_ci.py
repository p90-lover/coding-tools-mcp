"""Candidate build gates. Uses preserved aiTemp paths; never launches paid inference."""
from __future__ import annotations
import base64
import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request

BASE = 'fa7f323aa52ee5b5c143f61ff46fc534264f79ff'
VERSION = '0.4.2-rc.1'
NATIVE_TAG = 'rust-v0.153.4'
PACKED_SHA = '8cbe342b60087080597e3f5273cb4c2add774c798ab3aedd5e4fae4e0ee39e45'
FIXTURE_PATCH_SHA = 'e45f73ed611fb0d909c0fdd223b85fdf65b8e5787c1697c696e78805158d0346'

def digest(path: Path) -> str:
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()

def git(*args: str) -> str:
    return subprocess.check_output(['git', *args], text=True).strip()

def preserve(path: Path) -> None:
    if path.exists():
        backup = Path('aiTemp/Trash/native-codex-before') / os.environ['GITHUB_RUN_ID'] / path
        backup.parent.mkdir(parents=True, exist_ok=True)
        if not backup.exists():
            shutil.copy2(path, backup)

def apply_patch(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    subprocess.run(['git', 'apply', '--check', str(path)], check=True)
    subprocess.run(['git', 'apply', str(path)], check=True)

def prepare() -> None:
    Path('aiTemp/prepared').mkdir(parents=True, exist_ok=True)
    staged: list[str] = []
    if not Path('src-tauri/src/codex_bridge/mod.rs').exists():
        packed = base64.b64decode(''.join(Path(f'aiTemp/native-codex-delivery/source.patch.xz.b64.part{i}').read_text().strip() for i in range(1,4)), validate=True)
        assert hashlib.sha256(packed).hexdigest() == PACKED_SHA
        data = lzma.decompress(packed, memlimit=128*1024*1024)
        assert len(data) < 2*1024*1024
        payload = json.loads(data)
        assert payload['base_commit'] == BASE and len(payload['files']) == 20
        assert hashlib.sha256(payload['patch'].encode()).hexdigest() == payload['patch_sha256']
        for name, identity in payload['files'].items():
            p = Path(name)
            assert not p.is_absolute() and '..' not in p.parts
            assert name.startswith(('src/', 'src-tauri/src/', 'docs/')) or name in ('README.md','README.en.md')
            if identity['before'] is None:
                assert not p.exists(), name
            else:
                assert digest(p) == identity['before'], name
                preserve(p)
        apply_patch(Path('aiTemp/prepared/source.patch'), payload['patch'])
        for name, identity in payload['files'].items():
            assert digest(Path(name)) == identity['after'], name
        staged.extend(payload['files'])
    if 'mod native_turn_fixture;' not in Path('src-tauri/src/codex_bridge/mod.rs').read_text():
        data = lzma.decompress(base64.b64decode(Path('aiTemp/native-codex-delivery/native-fixture.patch.xz.b64').read_text(), validate=True), memlimit=128*1024*1024)
        assert hashlib.sha256(data).hexdigest() == FIXTURE_PATCH_SHA
        for name in ('src-tauri/src/commands/codex_runtime.rs','src-tauri/src/codex_bridge/mod.rs'):
            preserve(Path(name))
        apply_patch(Path('aiTemp/prepared/native-fixture.patch'), data.decode('utf-8'))
        staged.extend(['src-tauri/src/codex_bridge/mod.rs','src-tauri/src/commands/codex_runtime.rs','aiTemp/release-verification/native_turn_fixture.rs'])
    for name in ('package.json','package-lock.json','src-tauri/tauri.conf.json'):
        p=Path(name); data=json.loads(p.read_text())
        assert data['version'] in ('0.4.1-rc.1', VERSION)
        if data['version'] != VERSION:
            preserve(p); data['version']=VERSION
            if name=='package-lock.json': data['packages']['']['version']=VERSION
            p.write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8'); staged.append(name)
    for name in ('src-tauri/Cargo.toml','src-tauri/Cargo.lock'):
        p=Path(name); text=p.read_text(); pattern=r'(name = "coding-tools-mcp-desktop"\nversion = ")0\.4\.1-rc\.1(")'
        updated,count=re.subn(pattern,lambda m:m[1]+VERSION+m[2],text)
        assert count in (0,1)
        assert f'name = "coding-tools-mcp-desktop"\nversion = "{VERSION}"' in updated
        if count:
            preserve(p); p.write_text(updated,encoding='utf-8'); staged.append(name)
    roots=['src-tauri/src/codex_bridge/mod.rs','src-tauri/src/tools/codex_runtime.rs','src-tauri/src/commands/codex_runtime.rs']
    for name in [*roots,'src-tauri/src/codex_bridge/process.rs','aiTemp/release-verification/native_turn_fixture.rs']:
        preserve(Path(name))
    subprocess.run(['rustfmt','--edition','2021',*roots],check=True)
    staged.extend([*roots,'src-tauri/src/codex_bridge/process.rs','aiTemp/release-verification/native_turn_fixture.rs'])
    subprocess.run(['git','add','--',*sorted(set(staged))],check=True)
    assert not git('diff','--cached','--diff-filter=D','--name-only')
    subprocess.run(['git','diff','--cached','--check'],check=True)

def probe_init() -> None:
    p=Path('aiTemp/bridge-probe');p.mkdir(parents=True,exist_ok=True)
    Path('aiTemp/evidence').mkdir(parents=True,exist_ok=True)
    (p/'Cargo.toml').write_text('''[package]
name = "native-bridge-contract-probe"
version = "0.1.0"
edition = "2021"
[lib]
path = "../../src-tauri/src/codex_bridge/mod.rs"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
[target.'cfg(unix)'.dependencies]
libc = "0.2"
[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = ["Win32_Foundation", "Win32_Security", "Win32_System_Threading", "Win32_System_JobObjects"] }
''',encoding='utf-8')

def download_native() -> None:
    root=Path(os.environ['GITHUB_WORKSPACE'])/'aiTemp/native-codex-package';root.mkdir(parents=True,exist_ok=False)
    headers={'User-Agent':'coding-tools-mcp-native-verification','Authorization':'Bearer '+os.environ['GH_TOKEN']}
    req=urllib.request.Request(f'https://api.github.com/repos/openai/codex/releases/tags/{NATIVE_TAG}',headers=headers)
    with urllib.request.urlopen(req,timeout=30) as response: release=json.load(response)
    assert release['tag_name']==NATIVE_TAG and not release['draft'] and not release['prerelease']
    matches=[a for a in release['assets'] if a['name']==os.environ['NATIVE_ASSET']]; assert len(matches)==1
    asset=matches[0]; expected=asset.get('digest',''); assert re.fullmatch('sha256:[0-9a-f]{64}',expected)
    assert asset['browser_download_url'].startswith(f'https://github.com/openai/codex/releases/download/{NATIVE_TAG}/')
    archive=root/asset['name']
    with urllib.request.urlopen(asset['browser_download_url'],timeout=60) as response,archive.open('xb') as output:
        count=0
        while chunk:=response.read(1024*1024):
            count+=len(chunk);assert count<=256*1024*1024; output.write(chunk)
    assert archive.stat().st_size==asset['size'] and 'sha256:'+digest(archive)==expected
    with tarfile.open(archive) as tf: tf.extractall(root/'unpacked',filter='data')
    names={'codex.exe','codex-x86_64-pc-windows-msvc.exe'} if os.name=='nt' else {'codex','codex-aarch64-apple-darwin'}
    candidates={p.resolve() for p in (root/'unpacked').rglob('*') if p.is_file() and p.name in names}; assert len(candidates)==1
    binary=candidates.pop();binary.chmod(binary.stat().st_mode|0o111)
    with open(os.environ['GITHUB_ENV'],'a',encoding='utf-8') as env: env.write(f'NATIVE_CODEX_PROBE_BIN={binary}\nNATIVE_CODEX_PROBE_SHA256={digest(binary)}\n')
    Path('aiTemp/evidence/native-codex-provenance.json').write_text(json.dumps({'tag':NATIVE_TAG,'asset':asset['name'],'archive_sha256':expected[7:],'binary_sha256':digest(binary),'source_commit':os.environ['SOURCE'],'live_provider_acceptance_tested':False},indent=2),encoding='utf-8')

def proofs() -> None:
    expected={'bridge-contracts.txt':['3 passed; 0 failed; 2 ignored'], 'native-handshake.txt':['1 passed; 0 failed','zero model-control requests'], 'native-turns-fixture.txt':['1 passed; 0 failed','loopback synthetic Responses only']}
    for name,markers in expected.items():
        text=Path('aiTemp/evidence',name).read_text()
        assert all(m in text for m in markers),name
    p=Path('aiTemp/evidence/native-codex-provenance.json');data=json.loads(p.read_text())
    data.update({'native_turns_tested':True,'responses_provider':'isolated_loopback_fixture','paid_inference_configured':False})
    p.write_text(json.dumps(data,indent=2),encoding='utf-8')

def installer() -> None:
    subprocess.run([sys.executable,'aiTemp/release-verification/package_control_core.py'],check=True)
    source=Path('aiTemp/installer');proof=json.loads((source/'proof.json').read_text())
    proof.update({'version':VERSION,'codex_agent_invoked':True,'native_app_server_invoked':True,'responses_provider':'isolated_loopback_fixture','live_provider_acceptance_tested':False,'paid_inference_configured':False,'release_published':False,'status':'candidate_not_full_internal_tool_parity'})
    for directory in ('aiTemp/installer','aiTemp/evidence'):
        Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
    print('PASS: actual candidate installer/version/binary; native protocol fixture only, no live provider acceptance claim')

if __name__=='__main__':
    actions={'prepare':prepare,'probe-init':probe_init,'download-native':download_native,'proofs':proofs,'installer':installer}
    if len(sys.argv)!=2 or sys.argv[1] not in actions:
        raise SystemExit('Use: native_bridge_ci.py prepare|probe-init|download-native|proofs|installer')
    actions[sys.argv[1]]()
