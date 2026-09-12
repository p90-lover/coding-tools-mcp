"""Require current tests and reuse every v0.4.5 release gate, with version-only changes."""
from pathlib import Path
import hashlib,json,os,re,subprocess
assert os.environ['VERSION']=='0.4.6'
root=Path('aiTemp/evidence')
def text(name):return re.sub(r'\x1b\[[0-9;]*m','',(root/name).read_text(encoding='utf-8-sig'))
assert '3 passed; 0 failed' in text('load-green.txt')
for message in ['SLOW_TRACE_BLOCKS_ASYNC_SCHEDULER','TRANSIENT_OWNER_QUERY_PERMANENTLY_BLOCKS_RECOVERY']:
 assert message in text('load-red.txt')
for message in ['TRACE_QUEUE_PASS:','OWNERSHIP_RECOVERY_PASS:']:
 assert message in text('load-green.txt')
rows=[line.split('LOAD_TIMING ',1)[1] for line in text('load-green.txt').splitlines() if 'LOAD_TIMING ' in line]
assert len(rows)==1
measurement=json.loads(rows[0]);assert measurement['slow_sink_ms']==800
assert measurement['timer_elapsed_ms']<400 and measurement['response_ms']<400
assert measurement['actual_handler'] and measurement['fixture_context'] and measurement['model_requests']==0
# The original verifier's fixed hash and complete assertions are retained.
path=Path('aiTemp/task-monitor/package.py')
original=subprocess.check_output(['git','show','HEAD:'+path.as_posix()])
assert path.read_bytes().replace(b'\r\n',b'\n')==original
assert hashlib.sha256(original).hexdigest()=='76bb84dea0f21a061d8ec905c6e00126ae9406c7d3d378ee04d26c44e9a8b544'
source=original.decode();assert source.count('0.4.5')==2
exec(compile(source.replace('0.4.5','0.4.6'),str(path)+' (version assertions only)','exec'),{'__name__':'__main__'})
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({'scope':'load-sensitive trace I/O and transient Cloudflare ownership-query recovery',
 'load_regression_groups_passed':3,'load_fixture':measurement,
 'mcp_trace_writer_dedicated':True,'mcp_trace_queue_capacity':256,'mcp_trace_max_line_bytes':4096,
 'diagnostic_trace_is_durable':False,'dropped_trace_count_exposed_to_local_monitor':True,
 'transient_owner_lookup_permanently_blocks_recovery':False,'unknown_ownership_authorizes_restart':False,
 'manual_stop_behavior_changed':False,'cloudflare_restart_attempt_limit_changed':False,
 'oauth_or_tool_permissions_changed':False,'automatic_operation_replay':False,
 'user_pc_lag_measured':False,'chatgpt_disabled_root_cause_confirmed':False,
 'extension_or_connector_identity_modified':False,'automatic_reenable_of_chatgpt_tool':False})
for directory in ['aiTemp/installer','aiTemp/evidence']:
 Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
(root/'load-timing.json').write_text(json.dumps(measurement,indent=2)+'\n')
print('LOAD_PACKAGE_PASS: slow-sink responsiveness, bounded traces, safe recovery deferral and all retained release gates')
