"""Run the small approved checks before committing materialized release source."""
from pathlib import Path
import ast,json,os,runpy,shutil,subprocess
root=Path.cwd().resolve();evidence=root/'aiTemp/evidence';evidence.mkdir(parents=True,exist_ok=True)
for path in Path('aiTemp/live-refresh').glob('*.py'):ast.parse(path.read_text(encoding='utf-8'))
if json.loads(Path('package.json').read_text())['version']!='0.4.4-rc.5':
    runpy.run_path('aiTemp/live-refresh/finish_prepare.py',run_name='__main__')
# The browser fixture must match the existing diagnostic DTO, even though this
# test is about policy/metadata and never invokes the diagnostic's actual server.
path=Path('aiTemp/live-refresh/browser_test.py');source=path.read_text()
old="if(name==='get_tool_catalog_status')return {registered_count:71,advertised_count:71,profile:'advanced',tools:[]};"
new="if(name==='get_tool_catalog_status')return {registered_count:71,advertised_count:71,profile:'advanced',configured_profile:'advanced',server_version:'fixture',evidence_source:'synthetic',advertised_names:[],hidden_by_profile:[],advertised_but_unavailable:[],catalog_sha256:'fixture',read_only_hint_count:42,write_hint_count:29};"
if old in source:
    assert source.count(old)==1
    backup=Path('aiTemp/Trash/live-browser-fixture')/os.environ['GITHUB_RUN_ID']/path
    backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists()
    shutil.copy2(path,backup);path.write_text(source.replace(old,new),encoding='utf-8')
    subprocess.run(['git','add','--',str(path)],check=True)

def run(command,name):
    with (evidence/name).open('w',encoding='utf-8') as out:
        result=subprocess.run(command,stdout=out,stderr=subprocess.STDOUT)
    tail=(evidence/name).read_text(encoding='utf-8',errors='replace')
    print(tail[-14000:],flush=True)
    assert result.returncode==0,(command,result.returncode)

probe=root/'aiTemp/scan-preflight';(probe/'src').mkdir(parents=True,exist_ok=True)
(probe/'Cargo.toml').write_text('[package]\nname="live-refresh-scan-preflight"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nuuid={version="1",features=["v4"]}\nserde={version="1",features=["derive"]}\nserde_json="1"\nthiserror="2"\nsha2="0.10"\nwalkdir="2"\ndirs="6"\ntempfile="3"\n')
code='pub mod harness {\n'
for name in ['model','store','bounded_scan','state']:
    code+='#[path="'+(root/f'src-tauri/src/harness/{name}.rs').as_posix()+'"] pub mod '+name+';\n'
code+='pub use state::Harness;}\ninclude!("'+(root/'aiTemp/live-refresh/scan_contract.rs').as_posix()+'");\n'
policy=Path('src-tauri/src/tools/live_policy.rs').read_text()
code+=policy[policy.index('pub fn refreshable_observation('):policy.index('/// Acquire all changed contexts')]
code+='\n#[test] fn refresh_contract_observation_fence(){for name in ["project_state","harness_status","read_file","search_text"]{assert!(!fence_entire_call(name));}assert!(fence_entire_call("apply_patch"));}\n'
(probe/'src/lib.rs').write_text(code)
run(['cargo','test','--manifest-path',str(probe/'Cargo.toml'),'refresh_contract_','--','--test-threads=1','--nocapture'],'preflight.txt')
run(['python','aiTemp/live-refresh/context_probe.py'],'context-green.txt')
run(['npm','ci'],'npm.txt')
run(['node','--test','aiTemp/live-refresh/refresh-ui.test.mjs'],'refresh-ui.txt')
run(['npm','run','check'],'frontend.txt')
subprocess.run(['git','diff','--check'],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('PREFLIGHT_PASS: real bounded scan, real context function, refresh coordinator and full Svelte type check; no inference or deletion')
