"""Trace only a short isolated fixture; never upload raw global trace contents."""
from pathlib import Path
import csv
import json
import subprocess

def trace_request(request, argv):
    pm=Path('aiTemp/tools/Procmon64.exe').resolve()
    trace=Path('aiTemp/raw-trace');trace.mkdir(parents=True,exist_ok=False)
    pml=(trace/'fixture.pml').resolve();output=(trace/'fixture.csv').resolve()
    process=subprocess.Popen([str(pm),'/AcceptEula','/Quiet','/Minimized','/BackingFile',str(pml)])
    try:
        subprocess.run([str(pm),'/WaitForIdle'],check=True,timeout=30)
        result=request('exec',argv)
    finally:
        subprocess.run([str(pm),'/Terminate'],check=True,timeout=30)
        process.wait(timeout=30)
    subprocess.run([str(pm),'/AcceptEula','/Quiet','/Minimized','/OpenLog',str(pml),'/SaveAs',str(output)],check=True,timeout=60)
    assert output.stat().st_size < 150_000_000
    failures=set()
    with output.open(encoding='utf-8-sig',newline='') as f:
        for row in csv.DictReader(f):
            if row.get('Process Name','').lower()!='runtime-probe.exe':continue
            if row.get('Result') not in ('ACCESS DENIED','NAME NOT FOUND','PATH NOT FOUND','INVALID PARAMETER','PRIVILEGE NOT HELD'):continue
            failures.add((row.get('Operation',''),row.get('Path',''),row.get('Result','')))
            assert len(failures)<=500
    print('FIXTURE NATIVE ACCESS FAILURES',json.dumps(sorted(failures)),flush=True)
    Path('aiTemp/evidence/fixture-access-failures.json').write_text(json.dumps(sorted(failures),indent=2)+'\n',encoding='utf-8')
    return result

path=Path('aiTemp/release-verification/runtime_provider_probe.py')
source=path.read_text(encoding='utf-8')
old="result = request('exec', [str(executable)])"
assert source.count(old)==1
exec(compile(source.replace(old,"result = trace_request(request, [str(executable)])"),str(path),'exec'),globals())
