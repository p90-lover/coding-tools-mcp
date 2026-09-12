"""Exact-source Windows verification. No live accounts, model requests or deletions."""
from pathlib import Path
import json,os,shutil,subprocess
root=Path.cwd();evidence=root/'aiTemp/evidence';evidence.mkdir(parents=True,exist_ok=True)
assert os.name=='nt' and os.environ['VERSION']=='0.4.6'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==os.environ['SOURCE']
def run(args,name):
    executable=shutil.which(args[0]);assert executable,args[0]
    with (evidence/name).open('w',encoding='utf-8') as output:
        result=subprocess.run([executable,*args[1:]],stdout=output,stderr=subprocess.STDOUT)
    content=(evidence/name).read_text(encoding='utf-8',errors='replace')
    print(content[-16000:],flush=True)
    assert result.returncode==0,(args,result.returncode)

def download(run_id,name,directory):
    subprocess.run(['gh','run','download',str(run_id),'--repo',os.environ['GITHUB_REPOSITORY'],'--name',name,'--dir',directory],check=True)
download(34683848073,'load-red-34683848073','aiTemp/red')
shutil.copy2('aiTemp/red/load-red.txt',evidence/'load-red.txt')
download(34677752341,'monitor-evidence-34677752341','aiTemp/baseline')
# Only reproducible RED inputs/baseline audit data are reused. All passing checks,
# measurements and installer evidence below are generated on the current source.
for name in ['update-red.txt','monitor-red.txt','source-details-red.txt','red.txt','context-red.txt','linked-write-red.txt','quick-red.txt','branch-audit.json','ui-red.txt','rust-red.txt','timeout-red.txt']:
    shutil.copy2(Path('aiTemp/baseline')/name,evidence/name)
run(['python','aiTemp/load-resilience/probe.py'],'load-green.txt')
run(['python','aiTemp/live-refresh/linked_write_probe.py'],'linked-write-green.txt')
run(['python','aiTemp/reliability/verifier_guard_test.py'],'verifier-guard.txt')
run(['cmake','-S','native-helpers/app-container','-B','aiTemp/native-build','-A','x64','-DCODING_TOOLS_BUILD_PROBE=ON'],'native-config.txt')
run(['cmake','--build','aiTemp/native-build','--config','Release'],'native-build.txt')
run(['python','aiTemp/completion/native_test.py'],'native-tests.txt')
run(['npm','ci'],'npm.txt')
run(['node','--test','aiTemp/live-refresh/refresh-ui.test.mjs'],'refresh-ui.txt')
run(['node','--test','aiTemp/reliability/integration-state.test.mjs'],'integration-state.txt')
run(['npm','run','check'],'frontend.txt')
run(['npm','run','build'],'frontend-build.txt')
run(['python','-m','pip','install','playwright==1.57.0','jsonschema==4.25.1'],'verification-dependencies.txt')
run(['python','aiTemp/task-monitor/update_probe.py'],'update-green.txt')
base=['cargo','test','--locked','--release','--features','native-snapshot','--manifest-path','src-tauri/Cargo.toml','--lib']
for selection,name in [
    ('resilience_','load-native.txt'),('task_monitor_history_','task-monitor-history.txt'),
    ('refresh_contract_','live-tests.txt'),('tools::live_policy::tests','live-policy-tests.txt'),
    ('quick_add_never_overwrites_an_existing_mapping','root-nonoverwrite.txt'),
    ('recovery_contract_','recovery-tests.txt'),('snapshot_contract_','snapshot-contract.txt'),
    ('reliability_','reliability-tests.txt'),('control_center_','adapter-tests.txt'),
    ('core_catalog_exposes_chatgpt_compatible_tools_without_unreleased_claims','registry.txt'),
    ('catalog_exposure_','catalog-tests.txt'),('connection_','connection-tests.txt')]:
    run([*base,selection,'--','--test-threads=1','--nocapture'],name)
run([*base,'quick_','--','--test-threads=1','--nocapture','--skip','quick_add_never_overwrites_an_existing_mapping'],'quick-tests.txt')
run(['python','aiTemp/live-refresh/context_probe.py'],'context-green.txt')
os.environ['OAUTH_BROWSER_PROBE']='aiTemp/origin-repair/browser_live.py'
run([*base,'oauth_popup_','--','--test-threads=1','--nocapture'],'oauth-tests.txt')
# Preserve generated output before Tauri invokes the same frontend build again.
for name in ['build','.svelte-kit']:
    p=Path(name)
    if p.exists():
        retained=Path('aiTemp/Trash/pre-installer')/name
        retained.parent.mkdir(parents=True,exist_ok=True);assert not retained.exists();shutil.move(p,retained)
run(['npm','run','tauri','--','build','--bundles','nsis','--','--locked','--features','native-snapshot'],'installer.txt')
for script,name in [
    ('aiTemp/reliability/browser_test.py','integration-browser.txt'),
    ('aiTemp/live-refresh/browser_test.py','refresh-browser.txt'),
    ('aiTemp/task-monitor/browser_probe.py','task-monitor-browser.txt'),
    ('aiTemp/task-monitor/source_probe.py','source-details-browser.txt')]:run(['python',script],name)
run(['python','aiTemp/load-resilience/package.py'],'load-package.txt')
subprocess.run(['git','diff','--exit-code'],check=True)
print('WINDOWS_LOAD_RELEASE_PASS: current-source focused load checks and all inherited release gates passed')
