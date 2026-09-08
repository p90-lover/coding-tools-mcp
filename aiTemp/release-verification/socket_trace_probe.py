"""Trace the isolated probe only; never upload raw process traces or screenshots."""
from pathlib import Path
import csv, json, os, subprocess
procmon=Path('aiTemp/procmon/Procmon64.exe').resolve()
assert procmon.is_file()
raw=Path('aiTemp/release-verification/sandbox_native.py').read_text(encoding='utf-8')
dep=Path('aiTemp/release-verification/runtime_dependency_probe.py').read_text(encoding='utf-8')
exec(compile(dep.split("source=Path('aiTemp/release-verification/runtime_acl_probe.py')",1)[0],'dependency_functions','exec'),globals())
base=Path('aiTemp/release-verification/runtime_acl_probe.py').read_text(encoding='utf-8')
base=base.replace("files=[runtime/n for n in names if (runtime/n).is_file()]","files=dependency_closure(runtime,names)")
needle="r'SYSTEM\\CurrentControlSet\\Services\\WinSock\\Parameters']"
assert base.count(needle)==1
base=base.replace(needle,"r'SYSTEM\\CurrentControlSet\\Services\\WinSock\\Parameters', r'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Winsock', r'SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\\Winsock']")
exec(compile(base.split('# Compile the normal focused probe',1)[0],'acl_functions','exec'),globals())

def traced_network(callback):
    folder=Path('aiTemp/socket-trace').resolve();folder.mkdir(exist_ok=False)
    pml=folder/'fixture.pml';table=folder/'fixture.csv'
    process=subprocess.Popen([str(procmon),'/AcceptEula','/Quiet','/Minimized','/BackingFile',str(pml)])
    try:
        subprocess.run([str(procmon),'/WaitForIdle'],check=True,timeout=25)
        return callback()
    finally:
        subprocess.run([str(procmon),'/Terminate'],check=True,timeout=25)
        try:process.wait(timeout=15)
        except subprocess.TimeoutExpired:process.terminate();process.wait(timeout=5)
        subprocess.run([str(procmon),'/AcceptEula','/Quiet','/OpenLog',str(pml),'/SaveAs',str(table)],check=True,timeout=60)
        seen=set();records=[]
        with table.open(encoding='utf-8-sig',newline='') as f:
            for row in csv.DictReader(f):
                if row.get('Process Name','').lower()!='isolation-probe.exe':continue
                if row.get('Result') not in ('ACCESS DENIED','NAME NOT FOUND','PATH NOT FOUND','BAD NETWORK PATH'):continue
                path=row.get('Path','')
                if not (path.lower().startswith('c:\\windows\\') or path.startswith(('HKLM\\','HKU\\'))):continue
                record={k:row.get(k,'') for k in ('Operation','Path','Result')}
                key=json.dumps(record,sort_keys=True)
                if key in seen:continue
                seen.add(key);records.append(record)
                if len(records)>=150:break
        text=json.dumps(records,indent=2)
        Path('aiTemp/evidence/socket-resource-failures.json').write_text(text,encoding='utf-8')
        print('FIXTURE RESOURCE FAILURES ONLY\n'+text,flush=True)

anchor="assert request('setup').get('ready') is True"
assert raw.count(anchor)==1
raw=raw.replace(anchor,anchor+'\ngrant_runtime(home)')
needle="network = run('network',address)"
assert raw.count(needle)==1
raw=raw.replace(needle,"network = traced_network(lambda: run('network',address))")
raw=raw.replace("Path('aiTemp/evidence/sandbox-proof.json')","Path('aiTemp/evidence/traced-diagnostic-proof.json')")
exec(compile(raw,'native_trace_fixture','exec'),globals())
