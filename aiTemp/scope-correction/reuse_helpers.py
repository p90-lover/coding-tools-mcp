"""Reuse a pinned helper artifact only after source and build-step verification.

This does not waive the native isolation test; that runs again in this workflow.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

repo=os.environ['GITHUB_REPOSITORY']
origin='918d56936340055d3482ece655e3952c2227565c'
run_id=34206606095
upstream='3caf9f9586baedb4158a7b91545ead3dd320c348'
def api(path):
    return json.loads(subprocess.check_output(['gh','api',f'repos/{repo}/{path}'],timeout=60))
run=api(f'actions/runs/{run_id}')
assert run['head_sha']==origin and run['head_repository']['full_name']==repo and run['event']=='push'
response=api(f'actions/runs/{run_id}/jobs?per_page=100')
assert response['total_count']==len(response['jobs'])
jobs=[j for j in response['jobs'] if j['name']=='native (windows-latest, windows-x64)']
assert len(jobs)==1
for name in ('Compile only pinned sandbox helpers','Preserve compiled helpers before isolation testing'):
    steps=[s for s in jobs[0]['steps'] if s['name']==name]
    assert len(steps)==1 and steps[0]['conclusion']=='success',name
inputs=['native-helpers/prepare_upstream.py','native-helpers/codex_sandbox_bridge.rs','native-helpers/retained_files.rs','native-helpers/LICENSE-Codex','native-helpers/NOTICE.md','.github/workflows/remembered-control-release.yml','aiTemp/release-verification/run_step.py']
verified={}
for name in inputs:
    p=Path(name);assert p.is_file() and not p.is_symlink()
    data=p.read_bytes()
    expected=api(f'contents/{name}?ref={origin}')['sha']
    actual=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
    assert actual==expected,'Helper build input changed: '+name
    verified[name]=actual
source=Path('aiTemp/helper-artifact')
manifest=(source/'manifest.json').read_bytes()
assert len(manifest)<8192
spec=json.loads(manifest)
assert spec['upstream_commit']==upstream
names={'coding-tools-codex-sandbox.exe','codex-command-runner.exe','codex-windows-sandbox-setup.exe'}
assert set(spec['files'])==names
assert {p.name for p in source.iterdir()}==names|{'manifest.json','LICENSE-Codex','NOTICE.md'}
for name in names:
    p=source/name
    assert p.is_file() and not p.is_symlink() and 0<p.stat().st_size<150_000_000
    assert hashlib.sha256(p.read_bytes()).hexdigest()==spec['files'][name]
for name in ('LICENSE-Codex','NOTICE.md'):
    assert (source/name).read_bytes()==Path('native-helpers',name).read_bytes()
dest=Path('src-tauri/aiTemp/native-sandbox')
dest.mkdir(parents=True,exist_ok=False)
for p in source.iterdir():
    assert p.is_file() and not p.is_symlink()
    shutil.copy2(p,dest/p.name)
digest=hashlib.sha256(manifest).hexdigest()
with open(os.environ['GITHUB_ENV'],'a',encoding='utf-8') as f:
    f.write('CODING_TOOLS_SANDBOX_MANIFEST_SHA256='+digest+'\n')
Path('aiTemp/native-bundle.json').write_text(json.dumps({'bundle':{'resources':{dest.resolve().as_posix()+'/':'native-sandbox/'}}}),encoding='utf-8')
Path('aiTemp/evidence/sandbox-manifest.json').write_bytes(manifest)
proof={'source_commit':origin,'workflow_run':run_id,'upstream_commit':upstream,'manifest_sha256':digest,'identical_source_blobs':verified,'native_test_waived':False}
Path('aiTemp/evidence/sandbox-build-origin.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('PASS: exact prior helper build, unchanged adapter inputs, manifest and every binary digest; native tests still required')
