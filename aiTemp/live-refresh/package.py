"""Retain prior release gates and add focused live-refresh/long-task verification."""
from pathlib import Path
import hashlib,json,os,re,subprocess
assert os.environ['VERSION']=='0.4.4-rc.5'
root=Path('aiTemp/evidence')
def text(name):return re.sub(r'\x1b\[[0-9;]*m','',(root/name).read_text(encoding='utf-8-sig'))
assert '2 passed; 0 failed' in text('live-tests.txt')
assert '1 passed; 0 failed' in text('context-green.txt')
assert '# pass 1' in text('refresh-ui.txt') and '# fail 0' in text('refresh-ui.txt')
assert 'LIVE_REFRESH_SCAN:' in text('live-tests.txt')
assert 'LIVE_REFRESH_HTTP:' in text('live-tests.txt')
assert 'LIVE_CONTEXT:' in text('context-green.txt')
assert 'BASELINE_SCAN_UNBOUNDED' in text('red.txt')
assert 'READ_HOLDS_PERMISSION_FENCE' in text('red.txt')
ui=json.loads((root/'refresh-browser.json').read_text())
assert ui['source']==os.environ['SOURCE'] and ui['passed'] and not ui['console_errors']
assert ui['runtime_restarts']==0 and ui['model_requests']==0 and ui['screenshots_written']==0
# Reuse every previous release assertion; pin canonical bytes and only replace
# the two version literals. Windows checkout CRLF is not source tampering.
path=Path('aiTemp/quicktunnel/package.py')
original=subprocess.check_output(['git','show','HEAD:'+path.as_posix()])
assert original==path.read_bytes().replace(b'\r\n',b'\n')
assert hashlib.sha256(original).hexdigest()=='3c54c61040ac56befe178ce55459cb5202b531da84d54bc4e037a7d3543882d1'
source=original.decode();assert source.count('0.4.4-rc.4')==2
source=source.replace('0.4.4-rc.4','0.4.4-rc.5')
exec(compile(source,str(path)+' (rc5 version assertions)','exec'),{'__name__':'__main__'})
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({'scope':'approved live policy/root refresh and bounded baseline/task-context observations',
    'live_refresh_http_and_scan_groups_passed':2,'context_budget_group_passed':True,
    'workspace_refresh_coalescing_passed':True,'live_refresh_browser':ui,
    'listener_reconnect_for_permission_change':False,'new_linked_roots_inherit_current_policy':True,
    'operation_cache_bound_to_root_revision':True,'automatic_linking_of_all_profiles':False,
    'baseline_limit_per_file_bytes':33554432,'baseline_limit_total_bytes':134217728,
    'baseline_limit_entries':20000,'baseline_cooperative_deadline_seconds':8,
    'baseline_memory_read_buffer_bytes':65536,'baseline_partial_acceptance':False,
    'task_context_limit_scope':'task_context payload; instructions and transport metadata additional',
    'task_context_default_bytes':32768,'stored_task_or_event_truncated':False,
    'already_blocked_os_io_interruptible':False,'live_user_stall_root_cause_confirmed':False,
    'existing_absolute_read_policy_changed':False,'manual_link_edit_cancels_external_process':False})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print('PASS: same-listener policy/roots, bounded scanner/context, compiled autosave UI and all retained OAuth/native/timeout/installer gates')
