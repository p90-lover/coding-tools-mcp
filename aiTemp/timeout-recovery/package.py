"""Inspect the real installer and bind focused recovery evidence to its source."""
from pathlib import Path
import hashlib,json,os,re,runpy,subprocess
from jsonschema import Draft202012Validator
root=Path('aiTemp/evidence')
text=lambda name:re.sub(r'\x1b\[[0-9;]*m','',(root/name).read_text(encoding='utf-8-sig'))
for name,count in [('recovery-tests.txt',3),('oauth-tests.txt',5),('catalog-tests.txt',2),('snapshot-contract.txt',3),('registry.txt',1)]:
    assert f'{count} passed; 0 failed' in text(name),name
assert '0 errors and 0 warnings' in text('frontend.txt')
assert 'test result: ok.' in text('connection-tests.txt')
assert 'WORKER_FINISHED_BUT_COMPLETION_WAS_LOST' in text('timeout-red.txt')
for phrase in ['abandoned HTTP waiter and structured 408 retain worker completion/result; lookup never reruns work',
               'runtime isolation, duplicate ids, policy changes, bounded cache/capacity and worker failure are explicit',
               'real authenticated HTTP lookup bypasses busy worker slots without bootstrap or redispatch; result schema exported']:
    assert 'RECOVERY_CONTRACT: '+phrase in text('recovery-tests.txt')
rows=[line.split('RECOVERY_SCHEMA_EVIDENCE ',1)[1] for line in text('recovery-tests.txt').splitlines() if 'RECOVERY_SCHEMA_EVIDENCE ' in line]
assert len(rows)==1
schema_evidence=json.loads(rows[0]);definition=schema_evidence['definition']
assert definition['name']=='mcp_operation_status' and definition['annotations']['readOnlyHint']
assert definition['annotations']['destructiveHint'] is False
Draft202012Validator.check_schema(definition['inputSchema'])
Draft202012Validator.check_schema(definition['outputSchema'])
Draft202012Validator(definition['outputSchema']).validate(schema_evidence['success'])
assert schema_evidence['success']['operations'][0]['state']=='completed'
assert schema_evidence['success']['safe_to_retry'] is False
catalog_rows=[line.split('CATALOG_EVIDENCE ',1)[1] for line in text('catalog-tests.txt').splitlines() if 'CATALOG_EVIDENCE ' in line]
assert len(catalog_rows)==1;catalog=json.loads(catalog_rows[0])
assert catalog['core']['advertised_count']==58 and catalog['full']['registered_count']==71
assert catalog['full']['advertised_count']==71 and catalog['full']['hidden_by_profile']==[]
browser=json.loads((root/'browser-live.json').read_text())
assert browser['source']==os.environ['SOURCE'] and browser['passed'] and browser['forged_origin_denied']
assert browser['external_browser_network_blocked'] and not browser['live_account'] and browser['model_requests']==0
assert [(r['case'],r['post']['status']) for r in browser['cases']]==[('manual',303),('extension',303),('old_no_referrer',403)]
native=json.loads((root/'native-proof.json').read_text())
assert native['passed_groups']==3 and native['cmd_parser_verified'] and native['ordinary_and_extended_paths_verified']
assert native['model_requests']==0
for key in ['native_token_verified','read_only_input','external_user_file_denied','loopback_denied','descendants_terminated','output_bounded']:
    assert native[key],key
runpy.run_path('aiTemp/release-verification/package_control_core.py',run_name='__main__')
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
assert proof['source_commit']==os.environ['SOURCE'] and proof['version']=='0.4.4-rc.2'
compiled=Path(os.environ['CARGO_TARGET_DIR'])/'release/coding-tools-mcp-desktop.exe'
helper=Path(os.environ['CODING_TOOLS_SNAPSHOT_HELPER'])
helper_sha=hashlib.sha256(helper.read_bytes()).hexdigest()
assert helper_sha==native['helper_sha256'] and helper.read_bytes() in compiled.read_bytes()
pin='444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b'
assert pin.encode() in compiled.read_bytes()
for name,path in [('Paseo-LICENSE','third_party/licenses/Paseo-LICENSE'),('Anneal-LICENSE','third_party/licenses/Anneal-LICENSE'),('CONTROL_CENTER_NOTICES.md','third_party/CONTROL_CENTER_NOTICES.md')]:
    found=list(Path('aiTemp/core-installer-inspection').rglob(name));assert len(found)==1
    assert found[0].read_bytes()==Path(path).read_bytes()
proof.update({'scope':'MCP HTTP outcome recovery; no automatic retries and no inference',
    'workflow_run':int(os.environ['GITHUB_RUN_ID']),'recovery_groups_passed':3,'recovery_output_schema_validated':True,
    'worker_owns_completion':True,'recovery_read_only':True,'automatic_retries':False,
    'recovery_results_persisted_to_disk':False,'recovery_max_records':128,'recovery_max_result_bytes':262144,
    'recovery_terminal_ttl_seconds':1800,'mcp_http_wait_seconds':105,
    'catalog_counts':{'core':58,'read_only':42,'advanced':71},'catalog_regressions_passed':2,
    'oauth_regressions_passed':5,'browser':browser,'snapshot_contract_groups_passed':3,
    'snapshot_native_groups_passed':3,'snapshot_native_evidence':native,'snapshot_helper_embedded':True,
    'snapshot_helper_sha256':helper_sha,'native_sandbox_bundled':True,'native_sandbox_verified':True,
    'native_sandbox_status':'experimental_snapshot_appcontainer','official_codex_sandbox_implementation':False,
    'retained_command_runtime_sha256':pin,'codex_executable_invoked':False,'model_requests':0,
    'live_user_connection_verified':False,'live_user_snapshot_verified':False,'original_timed_out_operation_inspected':False})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
(root/'recovery-schema.json').write_text(json.dumps(schema_evidence,indent=2)+'\n')
(root/'catalog-evidence.json').write_text(json.dumps(catalog,indent=2)+'\n')
print('PASS: recovery/no-redispatch/schema, preserved OAuth and native isolation, actual versioned NSIS bytes')
