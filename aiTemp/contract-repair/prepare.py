"""Apply only the reviewed patch; preserve originals and fail on concurrent source drift."""
from pathlib import Path
import ast,hashlib,json,os,shutil,subprocess
BASE='7a56e30a25f16e55805e9550d319233974f11765'
BRANCH='fix/verified-contracts-0.4.4-rc.2'
VERSION='0.4.4-rc.2'
PATCH_PATHS={'aiTemp/sandbox-permissions/contract.rs','src-tauri/src/commands/mod.rs',
 'src-tauri/src/commands/sandbox.rs','src-tauri/src/lib.rs','src-tauri/src/tools/mod.rs',
 'src-tauri/src/tools/native_sandbox.rs','src-tauri/src/tools/registry.rs',
 'src-tauri/src/tools/sandbox_snapshot.rs','src/lib/components/SandboxControl.svelte',
 'src/lib/control-center/state.ts','src/routes/integrations/+page.svelte'}
VERSION_PATHS=['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock',
 'src-tauri/tauri.conf.json','README.md','README.en.md']
SUPPORT=['aiTemp/sandbox-permissions/package.py','aiTemp/sandbox-permissions/publish.py']
patch=Path('aiTemp/contract-repair/changes.patch')
assert not subprocess.check_output(['git','diff','--name-only']).strip()
for name in sorted(PATCH_PATHS|set(VERSION_PATHS)|set(SUPPORT)):
    path=Path(name)
    assert not path.is_symlink()
    expected=subprocess.check_output(['git','show',BASE+':'+name])
    assert path.read_bytes()==expected,'Unexpected changes in '+name
    backup=Path('aiTemp/Trash/contracts-before')/os.environ['GITHUB_RUN_ID']/name
    backup.parent.mkdir(parents=True,exist_ok=True)
    assert not backup.exists()
    shutil.copy2(path,backup)
assert set(line.split(' b/',1)[1] for line in patch.read_text().splitlines() if line.startswith('diff --git '))==PATCH_PATHS
assert 'deleted file mode' not in patch.read_text() and '\n+++ /dev/null' not in patch.read_text()
subprocess.run(['git','apply','--check',str(patch)],check=True)
subprocess.run(['git','apply',str(patch)],check=True)
for name in VERSION_PATHS:
    path=Path(name);text=path.read_text(encoding='utf-8')
    assert '0.4.4-rc.1' in text
    path.write_text(text.replace('0.4.4-rc.1',VERSION),encoding='utf-8')
path=Path(SUPPORT[0]);text=path.read_text()
assert "proof['version']=='0.4.4-rc.1'" in text
path.write_text(text.replace("proof['version']=='0.4.4-rc.1'",f"proof['version']=='{VERSION}'"))
path=Path(SUPPORT[1]);text=path.read_text()
text=text.replace("BASE='35b13594ddb3ba70011b2c47cec840e6a0dba3e1'",f"BASE='{BASE}'")
text=text.replace("BRANCH='fix/sandbox-permissions-0.4.4-rc.1'",f"BRANCH='{BRANCH}'").replace("VERSION='0.4.4-rc.1'",f"VERSION='{VERSION}'")
text=text.replace('offline snapshot sandbox and permissions','tool result contracts, retained snapshots and integration state')
marker="native=json.loads((root/'evidence/native-proof.json').read_text());assert native==proof['snapshot_native_evidence']"
assert text.count(marker)==1
text=text.replace(marker,"""contracts=json.loads((root/'evidence/output-contract-proof.json').read_text())
assert contracts==proof['output_contracts'] and contracts['source']==SOURCE
assert contracts['schema_count']==70 and contracts['all_schema_validations_passed']
assert len(contracts['coverage'])==70 and contracts['model_requests']==0
assert proof['local_lossless_snapshot_archive'] and proof['stale_integration_results_discarded']
assert '2 passed; 0 failed' in (root/'evidence/integration-contracts.txt').read_text(encoding='utf-8-sig')
assert '# pass 1' in (root/'evidence/ui-green.txt').read_text(encoding='utf-8-sig')
assert '# fail 0' in (root/'evidence/ui-green.txt').read_text(encoding='utf-8-sig')
assert '3 passed; 0 failed' in (root/'evidence/integration-adapters.txt').read_text(encoding='utf-8-sig')
"""+marker)
path.write_text(text)
for name in sorted(PATCH_PATHS|{'src-tauri/src/tools/output_contracts.rs','aiTemp/contract-repair/wire.test.rs','aiTemp/contract-repair/retention.test.rs'}):
    if name.endswith('.rs'):
        subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
for name in SUPPORT+['aiTemp/contract-repair/package.py','aiTemp/contract-repair/validate_contracts.py']:
    ast.parse(Path(name).read_text())
paths=sorted(PATCH_PATHS|set(VERSION_PATHS)|set(SUPPORT)|{'src-tauri/src/tools/output_contracts.rs','aiTemp/contract-repair/wire.test.rs','aiTemp/contract-repair/retention.test.rs'})
subprocess.run(['git','add','--',*paths],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
Path('aiTemp/evidence').mkdir(parents=True,exist_ok=True)
Path('aiTemp/evidence/preparation.json').write_text(json.dumps({'base':BASE,'patch_sha256':hashlib.sha256(patch.read_bytes()).hexdigest(),'changed_paths':paths,'file_deletions':0,'model_requests':0},indent=2)+'\n')
print('Prepared result metadata, lossless retention recovery and stale-response repair; existing auth/native boundaries preserved.')
