"""Focused checks for this change; application security/build gates follow on Windows."""
from pathlib import Path
import ast,os,runpy,subprocess,shutil
root=Path.cwd();evidence=root/'aiTemp/evidence';evidence.mkdir(parents=True,exist_ok=True)
for path in Path('aiTemp/task-monitor').glob('*.py'):ast.parse(path.read_text(encoding='utf-8'))
runpy.run_path('aiTemp/task-monitor/prepare.py',run_name='__main__')
# Keep event labels independently selectable/readable, without folding status
# or decorative markers into their text. No assertions are weakened.
path=Path('src/routes/tasks/+page.svelte');text=path.read_text(encoding='utf-8')
for old,new in [('<p>✓ {step}</p>','<p><span aria-hidden="true">✓ </span><span>{step}</span></p>'),('<p>○ {step}</p>','<p><span aria-hidden="true">○ </span><span>{step}</span></p>'),('<td>{operationLabel(op)}<small','<td><span>{operationLabel(op)}</span><small')]:
    if new not in text:
        assert text.count(old)==1,(old,text.count(old));text=text.replace(old,new,1)
if text!=path.read_text(encoding='utf-8'):
    backup=Path('aiTemp/Trash/task-monitor-labels')/os.environ['GITHUB_RUN_ID']/path
    backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists();shutil.copy2(path,backup)
    path.write_text(text,encoding='utf-8');subprocess.run(['git','add','--',str(path)],check=True)

def run(args,name,expected=0):
    with (evidence/name).open('w',encoding='utf-8') as f:r=subprocess.run(args,stdout=f,stderr=subprocess.STDOUT)
    print((evidence/name).read_text(encoding='utf-8',errors='replace')[-14000:],flush=True)
    assert r.returncode==expected,(args,r.returncode)
run(['python','aiTemp/task-monitor/update_probe.py'],'update-green.txt')
run(['python','aiTemp/task-monitor/history_probe.py'],'task-monitor-history.txt')
run(['npm','ci'],'npm.txt')
run(['npm','run','check'],'frontend.txt')
run(['npm','run','build'],'frontend-build.txt')
run(['python','aiTemp/task-monitor/browser_probe.py'],'task-monitor-browser.txt')
if 'SourceDetail from' not in Path('src/routes/sessions/+page.svelte').read_text():
    run(['python','aiTemp/task-monitor/source_probe.py','--baseline'],'source-details-red.txt',1)
    assert 'SOURCE_DETAILS_MISSING' in (evidence/'source-details-red.txt').read_text()
    runpy.run_path('aiTemp/task-monitor/source_details_prepare.py',run_name='__main__')
    run(['npm','run','check'],'source-frontend.txt')
    # Preserve the first build directory instead of cleaning an existing output.
    for name in ['build','.svelte-kit']:
        directory=Path(name)
        if directory.exists():
            dest=Path('aiTemp/Trash/pre-source-details-build')/os.environ['GITHUB_RUN_ID']/name
            dest.parent.mkdir(parents=True,exist_ok=True);assert not dest.exists();shutil.move(directory,dest)
    run(['npm','run','build'],'source-frontend-build.txt')
run(['python','aiTemp/task-monitor/source_probe.py'],'source-details-browser.txt')
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('TASK_MONITOR_PREFLIGHT_PASS: real history, version precedence, task details and Paseo/Anneal inspectors')
