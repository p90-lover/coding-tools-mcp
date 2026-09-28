"""Add focused evidence while retaining the exact rc3 release-verifier assertions."""
from pathlib import Path
import hashlib,json,os,re,statistics,subprocess
from jsonschema import Draft202012Validator
assert os.environ['VERSION']=='0.4.4-rc.4'
root=Path('aiTemp/evidence')
text=lambda name:re.sub(r'\x1b\[[0-9;]*m','',(root/name).read_text(encoding='utf-8-sig'))
assert '3 passed; 0 failed' in text('quick-tests.txt')
for marker in ['CONTROL_BLOCKED_BY_BUSY_TOOL_WORKERS','PROBE_REBUILDS_CLIENT_EVERY_CALL','RECOVERABLE_SCHEMA_NOT_WIRED']:
    assert marker in text('quick-red.txt'),marker
def evidence(marker):
    rows=[line.split(marker+' ',1)[1] for line in text('quick-tests.txt').splitlines() if marker+' ' in line]
    assert len(rows)==1,(marker,len(rows))
    return json.loads(rows[0])
http=evidence('QUICK_HTTP_EVIDENCE');probe=evidence('QUICK_PROBE_EVIDENCE');schemas=evidence('QUICK_SCHEMA_EVIDENCE')
assert http['occupied_execution_slots']==16 and http['auth_origin_protocol_checked']
assert http['read_only_profile_retained'] and http['tool_execution_not_retried']
assert probe['pooled_connections']==1 and probe['parallel_requests']>=2 and probe['no_credentials_sent']
assert not http['public_network_measured'] and not probe['public_network_measured']
assert len(probe['serial_ms'])==len(probe['parallel_ms'])==5
probe['serial_median_ms']=statistics.median(probe['serial_ms'])
probe['parallel_median_ms']=statistics.median(probe['parallel_ms'])
# Descriptive nearest-rank p95 on five fixture samples, not a public SLA.
probe['serial_p95_ms']=max(probe['serial_ms']);probe['parallel_p95_ms']=max(probe['parallel_ms'])
probe['measurement_scope']='Five local fixture samples with 40ms delay per response; not tool runtime or public Quick Tunnel latency'
assert {t['definition']['name'] for t in schemas['tools']}=={'read_file','operation_log'}
for entry in schemas['tools']:
    definition=entry['definition'];assert definition['annotations']['readOnlyHint'] and not definition['annotations']['destructiveHint']
    schema=definition['outputSchema'];Draft202012Validator.check_schema(schema);validator=Draft202012Validator(schema)
    for sample in entry['samples']:validator.validate(sample)
    assert not validator.is_valid({'ok':True}),'Successful results must require their actual fields'
audit=json.loads((root/'branch-audit.json').read_text())
assert audit['base']=='24396cc79475d477e1dee159f62ef1d660598911' and audit['branch_count']==74
assert audit['all_branch_pages_read'] and audit['all_pr_pages_read'] and not audit['application_code_executed']
report=Path('docs/audits/branch-recovery-2026-09-11.md')
assert sum(line.startswith('| `') for line in report.read_text().splitlines())==74
canonical_report=subprocess.check_output(['git','show','HEAD:'+report.as_posix()])
assert report.read_bytes().replace(b'\r\n',b'\n')==canonical_report
# Pin Git bytes, allow only checkout newline conversion; do not weaken rc3 gates.
path=Path('aiTemp/reliability/package.py')
original=subprocess.check_output(['git','show','HEAD:'+path.as_posix()])
assert path.read_bytes().replace(b'\r\n',b'\n')==original
assert hashlib.sha256(original).hexdigest()=='3f750aac6d388b2933dc42c68517c0cd49f188af14232fcc912abcdce1ff4fe3'
source=original.decode('utf-8');assert source.count('0.4.4-rc.3')==2
source=source.replace('0.4.4-rc.3','0.4.4-rc.4')
exec(compile(source,str(path)+' (rc4 version assertions)','exec'),{'__name__':'__main__'})
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({'scope':'reserved authenticated MCP control, pooled parallel public probes and selective branch schema recovery',
    'quick_groups_passed':3,'reserved_protocol_slots':2,'control_deadline_seconds':3,'ordinary_tool_slots':16,
    'quick_http':http,'quick_probe':probe,'recovered_output_schemas':['read_file','operation_log'],
    'branch_audit_count':74,'branch_audit_run':34579727505,'branch_report_sha256':hashlib.sha256(canonical_report).hexdigest(),
    'quick_tunnel_supported':True,'tunnel_recovery_changed':False,'intentional_stop_behavior_changed':False,
    'public_network_benchmarked':False,'application_code_deleted':False,'unreviewed_branches_merged':False})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
(root/'quick-probe.json').write_text(json.dumps(probe,indent=2)+'\n')
(root/'quick-http.json').write_text(json.dumps(http,indent=2)+'\n')
(root/'recovered-schemas.json').write_text(json.dumps(schemas,indent=2)+'\n')
print('PASS: occupied-slot control, pooled concurrent probes, recovered real-result schemas and all retained rc3 safety/installer checks')
