"""Add evidence for task visibility without weakening any rc.5 release gate."""
from pathlib import Path
import hashlib,json,os,re,subprocess
assert os.environ['VERSION']=='0.4.5'
root=Path('aiTemp/evidence')
def text(name):return re.sub(r'\x1b\[[0-9;]*m','',(root/name).read_text(encoding='utf-8-sig'))
for name,marker in [('task-monitor-history.txt','TASK_MONITOR_HISTORY_PASS'),('update-green.txt','UPDATE_PRECEDENCE_PASS')]:
    assert '1 passed; 0 failed' in text(name) and marker in text(name),name
assert 'UPDATER_PRERELEASE_COLLISION' in text('update-red.txt')
assert 'MONITOR_NAVIGATION_MISSING' in text('monitor-red.txt')
assert 'SOURCE_DETAILS_MISSING' in text('source-details-red.txt')
monitor=json.loads((root/'task-monitor-browser.json').read_text())
sources=json.loads((root/'source-details-browser.json').read_text())
for proof in [monitor,sources]:
    assert proof['source']==os.environ['SOURCE'] and proof['passed'] and proof['model_requests']==0 and not proof['console_errors']
assert sources['sources']==['paseo','anneal'] and sources['mutations']==0 and sources['screenshots_written']==0
assert 'MONITOR_BROWSER_PASS:' in text('task-monitor-browser.txt')
assert 'SOURCE_DETAILS_BROWSER_PASS:' in text('source-details-browser.txt')
# Canonical bytes from Git remain fixed. Only the two version literals in the
# previous wrapper are substituted; its original source and all assertions stay.
path=Path('aiTemp/live-refresh/package.py')
original=subprocess.check_output(['git','show','HEAD:'+path.as_posix()])
assert original==path.read_bytes().replace(b'\r\n',b'\n')
assert hashlib.sha256(original).hexdigest()=='dc6ef0a4aef8673e2fda5dc58524bb6cf95aaf111bb4fa3adf2c7f90d853fee9'
source=original.decode();assert source.count('0.4.4-rc.5')==2
exec(compile(source.replace('0.4.4-rc.5','0.4.5'),str(path)+' (stable version only)','exec'),{'__name__':'__main__'})
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({'scope':'stable Latest update, bounded task monitor and provider source detail panels',
    'task_monitor_history_group_passed':True,'update_semver_precedence_passed':True,
    'task_monitor_browser':monitor,'source_details_browser':sources,
    'monitor_read_only':True,'monitor_initializes_history':False,'monitor_scans_project':False,
    'monitor_event_page_limit':50,'monitor_event_read_window_bytes':524288,'monitor_recent_task_limit':20,
    'monitor_task_file_limit_bytes':8388608,'monitor_aggregate_task_bytes':33554432,
    'raw_tool_payloads_in_monitor':False,'dispatch_completion_is_job_completion':False,
    'automatic_operation_replay':False,'source_panels_assign_or_control_agents':False,
    'full_codex_paseo_anneal_orchestration_implemented':False,'live_user_account_verified':False,
    'stable_latest_intended':True})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print('TASK_MONITOR_PACKAGE_PASS: verified source, task history, source inspectors, updater precedence, native boundaries and installer bytes')
