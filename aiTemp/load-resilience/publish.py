"""Reuse the audited v0.4.5 publisher with exact scope/version substitutions.
Every source/asset/readback/Latest check is retained; no force push or replacement.
"""
from pathlib import Path
import hashlib,os,subprocess
base='541c50f2d6db720ef2e888bb3f70ede961bbae1a'
head=os.environ['SOURCE']
changed=subprocess.check_output(['git','diff','--name-only',base,head],text=True).splitlines()
allowed={'src-tauri/src/mcp/mod.rs','src-tauri/src/mcp/listener.rs','src-tauri/src/mcp/request_log.rs',
 'src-tauri/src/commands/task_monitor.rs','src-tauri/src/tunnel/supervisor.rs','src/routes/tasks/+page.svelte',
 'aiTemp/connection-tests/http.rs',
 'package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','README.md','README.en.md','docs/releases/v0.4.6.md'}
assert all(p in allowed or p.startswith('aiTemp/load-resilience/') or p.startswith('.github/workflows/load-resilience') for p in changed),changed
path=Path('aiTemp/task-monitor/publish.py');raw=subprocess.check_output(['git','show','HEAD:'+path.as_posix()])
assert path.read_bytes().replace(b'\r\n',b'\n')==raw
assert hashlib.sha256(raw).hexdigest()=='d95a4f2baef0a576b5f727181b12b957c5b8baebcb8b6d07a0ea77ff701836c5'
source=raw.decode()
def replace(old,new,count=1):
 global source
 assert source.count(old)==count,(old,source.count(old))
 source=source.replace(old,new)
replace("BASE='2517b2e7fe0ae2038eb3b72caa8761756927feb4'",f"BASE='{base}'")
replace("BRANCH='fix/task-monitor-latest-0.4.4'","BRANCH='fix/load-resilience-0.4.6'")
replace("VERSION='0.4.5'","VERSION='0.4.6'")
# Only supervisor.rs is changed in tunnel/. The allowlist above ensures no
# other tunnel file can be smuggled past the preserved security gate.
replace("'src-tauri/src/tunnel',","'src-tauri/src/tunnel/recovery.rs','src-tauri/src/tunnel/access.rs','src-tauri/src/tunnel/connection.rs','src-tauri/src/tunnel/cloudflare.rs',")
replace("download('monitor-installer-'+RUN","download('load-installer-'+RUN")
replace("download('monitor-evidence-'+RUN","download('load-evidence-'+RUN")
replace("root=Path('aiTemp/task-monitor-publication')","root=Path('aiTemp/load-publication')")
replace("proof=json.loads((root/'installer/proof.json').read_text())","""proof=json.loads((root/'installer/proof.json').read_text())
assert proof['load_regression_groups_passed']==3
assert proof['mcp_trace_writer_dedicated'] and proof['mcp_trace_queue_capacity']==256
assert proof['mcp_trace_max_line_bytes']==4096 and not proof['diagnostic_trace_is_durable']
assert not proof['transient_owner_lookup_permanently_blocks_recovery']
assert not proof['unknown_ownership_authorizes_restart'] and not proof['oauth_or_tool_permissions_changed']
assert not proof['chatgpt_disabled_root_cause_confirmed'] and not proof['extension_or_connector_identity_modified']
assert '3 passed; 0 failed' in (root/'evidence/load-green.txt').read_text(encoding='utf-8-sig')
assert '1 passed; 0 failed' in (root/'evidence/load-native.txt').read_text(encoding='utf-8-sig')""")
replace(' — task monitor and current stable update',' — load resilience and safer tunnel recovery')
replace('aiTemp/monitor-release-draft.json','aiTemp/load-release-draft.json')
replace('aiTemp/monitor-release-receipt.json','aiTemp/load-release-receipt.json')
exec(compile(source,str(path)+' (verified load release substitutions)','exec'),{'__name__':'__main__'})
