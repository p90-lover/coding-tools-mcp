"""Package proof for this release only. Never claims live-provider acceptance."""
from pathlib import Path
import hashlib
import json
import os
import plistlib
import subprocess
import sys


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


root = Path('aiTemp/evidence')
required = {
    'native-contracts.txt': ['4 passed; 0 failed'],
    'native-lifecycle.txt': ['PASS: real native start/send/review/compact/interrupt/unsubscribe', 'test result: ok.'],
    'connection-tests.txt': ['test result: ok.'],
    'catalog-tests.txt': ['test result: ok.', '1 passed; 0 failed'],
    'frontend.txt': ['0 errors'],
}
for name, markers in required.items():
    text = (root / name).read_text(encoding='utf-8')
    assert all(marker in text for marker in markers), name
provenance = json.loads((root/'native-codex-provenance.json').read_text())
assert provenance['tag'] == 'rust-v0.153.4'
assert provenance['source_commit'] == os.environ['SOURCE']
subprocess.run([sys.executable, 'aiTemp/release-verification/package_control_core.py'], check=True)

expected_licenses = {
    'Paseo-LICENSE': Path('third_party/licenses/Paseo-LICENSE'),
    'Anneal-LICENSE': Path('third_party/licenses/Anneal-LICENSE'),
    'CONTROL_CENTER_NOTICES.md': Path('third_party/CONTROL_CENTER_NOTICES.md'),
}
mount = None
if os.environ['PLATFORM'] == 'windows-x64':
    inspect = Path('aiTemp/core-installer-inspection')
else:
    dmgs = list((Path(os.environ['CARGO_TARGET_DIR'])/'release/bundle/dmg').glob('*.dmg'))
    assert len(dmgs) == 1
    info = plistlib.loads(subprocess.check_output(['hdiutil','attach','-readonly','-nobrowse','-plist',str(dmgs[0])]))
    mounts = [Path(e['mount-point']) for e in info['system-entities'] if 'mount-point' in e]
    assert len(mounts) == 1
    mount = mounts[0]
    apps = list(mount.glob('*.app'))
    assert len(apps) == 1
    inspect = apps[0]
licenses = {}
try:
    for name, original in expected_licenses.items():
        found = list(inspect.rglob(name))
        assert len(found) == 1 and digest(found[0]) == digest(original), name
        licenses[name] = digest(original)
finally:
    if mount is not None:
        subprocess.run(['hdiutil','detach',str(mount)],check=True)
proof = json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({
    'native_fixture_verified': False,
    'native_codex_lifecycle_verified': True,
    'native_codex_tag': provenance['tag'],
    'native_codex_binary_sha256': provenance['binary_sha256'],
    'native_desktop_input_regression_rerun': False,
    'codex_agent_invoked': True,
    'responses_provider': 'isolated_loopback_synthetic_fixture',
    'paid_inference_configured': False,
    'live_provider_acceptance_tested': False,
    'mcp_http_regressions_passed': True,
    'full_catalog_verified': True,
    'bundled_license_sha256': licenses,
    'workflow_run': int(os.environ['GITHUB_RUN_ID']),
    'verification_boundary': 'GitHub-hosted native protocol and packaging, not user-machine/live ChatGPT acceptance',
})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory, 'proof.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('PASS: release source, native lifecycle, MCP catalog and actual bundled licenses agree')
