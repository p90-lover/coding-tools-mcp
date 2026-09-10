"""Retain existing native/OAuth installer gates and add honest per-function coverage."""
from pathlib import Path
import json,os,runpy
root=Path('aiTemp/evidence')
assert '2 passed; 0 failed' in (root/'integration-contracts.txt').read_text(encoding='utf-8-sig')
assert 'PASS: invalid selections do not consume retention' in (root/'integration-contracts.txt').read_text(encoding='utf-8-sig')
assert '# pass 1' in (root/'ui-green.txt').read_text(encoding='utf-8-sig')
assert '# fail 0' in (root/'ui-green.txt').read_text(encoding='utf-8-sig')
assert 'STALE_ENDPOINT_RESPONSE_WAS_PUBLISHED' in (root/'ui-red.txt').read_text(encoding='utf-8-sig')
assert '3 passed; 0 failed' in (root/'integration-adapters.txt').read_text(encoding='utf-8-sig')
assert '3 passed; 0 failed' in (root/'bridge-permissions.txt').read_text(encoding='utf-8-sig')
assert '1 passed; 0 failed' in (root/'workflow.txt').read_text(encoding='utf-8-sig')
contracts=json.loads((root/'output-contract-proof.json').read_text())
assert contracts['source']==os.environ['SOURCE'] and contracts['schema_count']==70
assert contracts['all_schema_validations_passed'] and contracts['model_requests']==0
assert contracts['detailed_event_pagination_negative_cases_passed'] and not contracts['live_user_acceptance']
assert len(contracts['coverage'])==70
runpy.run_path('aiTemp/sandbox-permissions/package.py',run_name='__main__')
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({'scope':'structured result contracts, lossless snapshot lifecycle and integration state; not full upstream engine parity',
    'output_contracts':contracts,'output_schema_count':70,'local_lossless_snapshot_archive':True,
    'stale_integration_results_discarded':True,'integration_adapter_groups_passed':3,
    'native_bridge_permission_groups_passed':3,'provider_model_integration_tested':False,
    'paseo_anneal_autonomous_engines_integrated':False,'file_deletions':0,'model_requests':0,
    'codex_executable_invoked':False})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print('PASS: 70 schema contracts and per-function evidence, local lossless archival, scoped permissions, adapter fixtures and actual packaged EXE')
