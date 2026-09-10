"""Validate actual Rust results using the advertised schemas, including image envelopes."""
from pathlib import Path
import json
from jsonschema import Draft202012Validator
p=Path('aiTemp/evidence/tool-contracts.json')
report=json.loads(p.read_text(encoding='utf-8'))
schemas={t['name']:t['outputSchema'] for t in report['catalog']}
assert len(schemas)==70 and report['model_requests']==0 and not report['live_user_acceptance']
validators={}
for name,schema in schemas.items():
    Draft202012Validator.check_schema(schema)
    validators[name]=Draft202012Validator(schema)
for row in report['samples']:
    validators[row['tool']].validate(row['wire']['structuredContent'])
    if row['scope']=='actual_retained_fixture': assert row['wire']['structuredContent']['ok'] is True
    assert row['wire']['isError']==(row['wire']['structuredContent']['ok'] is False)
# Prove the list_task_events contract rejects a malformed successful page.
assert not validators['list_task_events'].is_valid({'ok':True,'events':'not-an-array','next_cursor':0})
assert not validators['list_task_events'].is_valid({'ok':True,'events':[],'next_cursor':-1})
assert not validators['list_task_events'].is_valid({'ok':True,'events':[]})
assert validators['list_task_events'].is_valid({'ok':False,'error':{'code':'fixture'}})
result={'source':report['source'],'schema_count':len(schemas),'actual_results_validated':len(report['samples']),
        'model_requests':0,'live_user_acceptance':False,'all_schema_validations_passed':True,
        'detailed_event_pagination_negative_cases_passed':True,'coverage':report['coverage']}
Path('aiTemp/evidence/output-contract-proof.json').write_text(json.dumps(result,indent=2)+'\n')
print(f"PASS: {len(schemas)} JSON schemas and {len(report['samples'])} actual tool results; fixture and denial-only coverage explicitly distinguished")
