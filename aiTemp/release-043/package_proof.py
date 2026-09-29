"""Inspect the real installer and bind it to model-free command/workflow evidence."""
from pathlib import Path
import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys

root=Path('aiTemp/evidence')
required={
 'native-command-contract.txt':['1 passed; 0 failed'],
 'native-command-real.txt':['PASS: real native command/exec, read-only write denial, exact replay receipt, zero model/provider requests, zero threads, and Stop revocation','1 passed; 0 failed'],
 'workflow-tests.txt':['2 passed; 0 failed'],
 'connection-tests.txt':['test result: ok.'],
 'catalog-tests.txt':['2 passed; 0 failed'],
 'frontend.txt':['0 errors'],
}
for name,markers in required.items():
    text=(root/name).read_text(encoding='utf-8')
    assert all(marker in text for marker in markers),name
    assert not re.search(r'test result: FAILED|error\[E\d+\]',text),name
native=json.loads((root/'native-codex-provenance.json').read_text())
assert native['tag']=='rust-v0.153.4' and native['source_commit']==os.environ['SOURCE']
pinned=os.environ['CODING_TOOLS_COMMAND_NATIVE_SHA256']
assert re.fullmatch('[0-9a-f]{64}',pinned) and pinned==native['binary_sha256']
subprocess.run([sys.executable,'aiTemp/release-verification/package_control_core.py'],check=True)
base=Path(os.environ['CARGO_TARGET_DIR'])/'release'
windows=os.environ['PLATFORM']=='windows-x64'
compiled=base/'coding-tools-mcp-desktop.exe' if windows else next(base.glob('bundle/macos/*.app/Contents/MacOS/coding-tools-mcp-desktop'))
assert pinned.encode() in compiled.read_bytes(),'Release executable must contain the tested command-runtime digest'
expected={
 'Paseo-LICENSE':Path('third_party/licenses/Paseo-LICENSE'),
 'Anneal-LICENSE':Path('third_party/licenses/Anneal-LICENSE'),
 'CONTROL_CENTER_NOTICES.md':Path('third_party/CONTROL_CENTER_NOTICES.md'),
}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
mount=None
if windows: inspect=Path('aiTemp/core-installer-inspection')
else:
    dmgs=list(base.glob('bundle/dmg/*.dmg'));assert len(dmgs)==1
    info=plistlib.loads(subprocess.check_output(['hdiutil','attach','-readonly','-nobrowse','-plist',str(dmgs[0])]))
    mounts=[Path(e['mount-point']) for e in info['system-entities'] if 'mount-point' in e];assert len(mounts)==1
    mount=mounts[0];apps=list(mount.glob('*.app'));assert len(apps)==1;inspect=apps[0]
licenses={}
try:
    for name,path in expected.items():
        copies=list(inspect.rglob(name));assert len(copies)==1 and sha(copies[0])==sha(path),name
        licenses[name]=sha(path)
finally:
    if mount:subprocess.run(['hdiutil','detach',str(mount)],check=True)
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({
 'native_fixture_verified':False,
 'native_desktop_input_regression_rerun':False,
 'codex_agent_invoked':False,
 'native_codex_process_invoked':True,
 'native_command_protocol':'command/exec',
 'native_command_runtime_sha256':pinned,
 'native_command_readonly_write_denial_verified':True,
 'model_or_thread_requests':0,
 'provider_requests':0,
 'native_command_consent_and_retry_verified':True,
 'real_persistent_workflow_dispatch_verified':True,
 'live_permission_revocation_verified':True,
 'mcp_http_regressions_passed':True,
 'catalog_truthful_annotations_verified':True,
 'bundled_license_sha256':licenses,
 'workflow_run':int(os.environ['GITHUB_RUN_ID']),
 'verification_boundary':'Isolated GitHub-hosted native commands and persistence, not user-machine/live ChatGPT acceptance',
})
for name in ['aiTemp/installer/proof.json','aiTemp/evidence/proof.json']:
    Path(name).write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('PASS: packaged source/version/native digest, model-free native commands, scoped workflow, and bundled licenses')
