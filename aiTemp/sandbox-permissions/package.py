"""Extend actual NSIS inspection with native-helper and shared-dispatch evidence."""
from pathlib import Path
import hashlib,json,os,runpy
root=Path('aiTemp/evidence')
contract=(root/'snapshot-contract.txt').read_text(encoding='utf-8-sig')
assert '3 passed; 0 failed' in contract
for marker in ['SNAPSHOT_CONTRACT: workspace identity, reload, old/helper/policy grants, inputs and revocation verified',
               'SNAPSHOT_CONTRACT: shared ask/never/full policies cannot bypass local or read-only permission',
               'SNAPSHOT_CONTRACT: real Rust/helper execution, live permission revocation and descendant termination passed']:
    assert marker in contract,marker
assert '1 passed; 0 failed' in (root/'registry.txt').read_text(encoding='utf-8-sig')
helper=Path(os.environ['CODING_TOOLS_SNAPSHOT_HELPER']);helper_sha=hashlib.sha256(helper.read_bytes()).hexdigest()
native=json.loads((root/'native-proof.json').read_text())
assert native['passed_groups']==3 and native['helper_sha256']==helper_sha and native['model_requests']==0
for key in ['native_token_verified','read_only_input','external_user_file_denied','loopback_denied','descendants_terminated','output_bounded']:
    assert native[key],key
compiled=Path(os.environ['CARGO_TARGET_DIR'])/'release/coding-tools-mcp-desktop.exe'
assert helper.read_bytes() in compiled.read_bytes(),'Compiled desktop must contain the exact tested helper bytes'
# Includes five OAuth tests and the exact extension 0.0.7 helper through the real
# Rust authorization guard. Do not regress rc5 while adding an independent executor.
runpy.run_path('aiTemp/origin-repair/package.py',run_name='__main__')
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
assert proof['source_commit']==os.environ['SOURCE'] and proof['version']=='0.4.4-rc.1'
proof.update({'scope':'opt-in Windows offline snapshot executor and scoped local permissions; ordinary host tools remain separate',
    'snapshot_backend':'windows-appcontainer-v1','snapshot_helper_sha256':helper_sha,'snapshot_helper_embedded':True,
    'snapshot_contract_groups_passed':3,'snapshot_native_groups_passed':3,'snapshot_native_evidence':native,
    'snapshot_local_consent_required':True,'snapshot_host_fallback':False,'snapshot_direct_workspace_write':False,
    'snapshot_network_capabilities':0,'snapshot_max_retained_runs':32,'read_only_catalog_count':41,
    'official_codex_sandbox_implementation':False,'full_host_filesystem_confidentiality_claimed':False,
    'live_user_snapshot_verified':False,'snapshot_feature':'native-snapshot','model_requests':0,'codex_executable_invoked':False})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('PASS: exact embedded native helper, real isolation and live revocation; existing OAuth and actual installer bytes verified')
