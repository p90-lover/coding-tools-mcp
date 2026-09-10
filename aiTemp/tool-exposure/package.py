"""Inspect this focused Windows installer, without launching Codex or model fixtures."""
from pathlib import Path
import hashlib,json,os,re,subprocess,sys
PIN='444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b'
assert os.environ['CODING_TOOLS_COMMAND_NATIVE_SHA256']==PIN
assert os.environ['PLATFORM']=='windows-x64'
root=Path('aiTemp/evidence')
clean=lambda text:re.sub(r'\x1b\[[0-9;]*m','',text)
log=clean((root/'catalog-tests.txt').read_text(encoding='utf-8'))
assert '2 passed; 0 failed' in log
lines=[line.split('CATALOG_EVIDENCE ',1)[1] for line in log.splitlines() if 'CATALOG_EVIDENCE ' in line]
assert len(lines)==1
catalog=json.loads(lines[0]);assert catalog['core']['advertised_count']==57 and catalog['full']['advertised_count']==70
assert catalog['full']['registered_count']==70 and catalog['full']['hidden_by_profile']==[]
assert catalog['full']['client_loaded_tools'] is None and catalog['full']['client_registration_verified'] is False
assert 'test result: ok.' in clean((root/'connection-tests.txt').read_text(encoding='utf-8'))
assert '0 errors and 0 warnings' in clean((root/'frontend.txt').read_text(encoding='utf-8'))
subprocess.run([sys.executable,'aiTemp/release-verification/package_control_core.py'],check=True)
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
assert proof['version']==os.environ['VERSION'] and proof['source_commit']==os.environ['SOURCE']
compiled=Path(os.environ['CARGO_TARGET_DIR'])/'release/coding-tools-mcp-desktop.exe'
assert PIN.encode() in compiled.read_bytes(),'Previously verified command runtime identity must remain compiled in'
for name,source in [('Paseo-LICENSE','third_party/licenses/Paseo-LICENSE'),('Anneal-LICENSE','third_party/licenses/Anneal-LICENSE'),('CONTROL_CENTER_NOTICES.md','third_party/CONTROL_CENTER_NOTICES.md')]:
    found=list(Path('aiTemp/core-installer-inspection').rglob(name));assert len(found)==1,name
    assert hashlib.sha256(found[0].read_bytes()).digest()==hashlib.sha256(Path(source).read_bytes()).digest(),name
proof.update({'native_fixture_verified':False,'native_input_rerun':False,'native_command_rerun':False,
    'retained_command_runtime_sha256':PIN,'codex_executable_invoked':False,'model_requests':0,
    'live_user_chatgpt_connection_verified':False,'catalog_regressions_passed':2,
    'catalog_counts':{'core':57,'advanced':70},'scope':'catalog selection and local diagnostics, not new engine integration',
    'workflow_run':int(os.environ['GITHUB_RUN_ID'])})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
(root/'catalog-evidence.json').write_text(json.dumps(catalog,indent=2)+'\n',encoding='utf-8')
print('PASS: catalog evidence, preserved native-command identity, packaged binary and license bytes')
