"""Add reliability evidence to the unchanged rc2 verifier; only its version literal changes."""
from pathlib import Path
import hashlib,json,os,re,subprocess
from jsonschema import Draft202012Validator
assert os.environ['VERSION']=='0.4.4-rc.3'
root=Path('aiTemp/evidence')
text=lambda name:re.sub(r'\x1b\[[0-9;]*m','',(root/name).read_text(encoding='utf-8-sig'))
assert '# pass 1' in text('integration-state.txt') and '# fail 0' in text('integration-state.txt')
assert '2 passed; 0 failed' in text('reliability-tests.txt')
assert '3 passed; 0 failed' in text('adapter-tests.txt')
assert 'CLEARED_SNAPSHOT_RETURNED' in text('ui-red.txt')
assert 'INVALID_INPUT_CONSUMED_RETENTION_SLOT' in text('rust-red.txt')
assert 'TASK_EVENTS_OUTPUT_SCHEMA_MISSING' in text('rust-red.txt')
assert 'RELIABILITY_SNAPSHOT:' in text('reliability-tests.txt')
assert 'RELIABILITY_METADATA:' in text('reliability-tests.txt')
rows=[line.split('RELIABILITY_SCHEMA_EVIDENCE ',1)[1] for line in text('reliability-tests.txt').splitlines() if 'RELIABILITY_SCHEMA_EVIDENCE ' in line]
assert len(rows)==1
schema_evidence=json.loads(rows[0]);definition=schema_evidence['definition']
assert definition['name']=='list_task_events' and definition['annotations']['readOnlyHint']
assert definition['annotations']['destructiveHint'] is False
Draft202012Validator.check_schema(definition['outputSchema'])
validator=Draft202012Validator(definition['outputSchema'])
assert len(schema_evidence['samples'])==4
for sample in schema_evidence['samples']:validator.validate(sample)
assert [s['ok'] for s in schema_evidence['samples']]==[True,True,True,False]
assert schema_evidence['samples'][0]['events'] and not schema_evidence['samples'][2]['events']
assert not validator.is_valid({'ok':True}), 'Schema must actually require successful page fields'
assert not validator.is_valid({'ok':True,'events':[],'next_cursor':'wrong type'})
ui=json.loads((root/'integration-browser.json').read_text())
assert ui['source']==os.environ['SOURCE'] and ui['passed'] and ui['sources']==['paseo','anneal']
assert ui['model_requests']==0 and not ui['console_errors'] and ui['screenshots_written']==0
# Preserve all timeout/OAuth/native/installer assertions from the prior release.
# Pin its bytes so future changes cannot silently weaken these reused gates.
path=Path('aiTemp/timeout-recovery/package.py')
original=subprocess.check_output(['git','show','HEAD:'+path.as_posix()])
# Git's canonical bytes stay pinned; only checkout CRLF translation is allowed.
assert path.read_bytes().replace(b'\r\n',b'\n')==original, 'VERIFIER_WORKTREE_MODIFIED'
assert hashlib.sha256(original).hexdigest()=='b23b5e444be07e80d2ed9b81072772c90827f442c3559a5de2abffbae1985387'
source=original.decode('utf-8');old="proof['version']=='0.4.4-rc.2'"
assert source.count(old)==1
source=source.replace(old,"proof['version']=='0.4.4-rc.3'",1)
exec(compile(source,str(path)+' (rc3 version assertion)','exec'),{'__name__':'__main__'})
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({'scope':'integration response ownership, snapshot input preflight, task-event output schema and capability discovery',
    'reliability_regression_run':34553831049,'reliability_rust_groups_passed':2,'integration_state_group_passed':True,
    'integration_browser':ui,'read_only_adapter_tests_passed':3,'task_event_schema_validated':True,
    'schema_samples_validated':4,'rejected_snapshot_inputs_consume_slots':False,
    'existing_failed_snapshots_removed':False,'full_autonomous_engines_added':False})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
(root/'task-event-schema.json').write_text(json.dumps(schema_evidence,indent=2)+'\n')
print('PASS: actual integration UI, read-only adapters, snapshot preflight, event schemas; all rc2 timeout/OAuth/native/installer gates retained')
