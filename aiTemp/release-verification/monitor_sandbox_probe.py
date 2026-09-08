"""Bound the existing native probe's helper tree and retain fixture-only diagnostics."""
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import runpy
import subprocess
import sys
import time

helper = Path(sys.argv[1]).resolve()
home = Path(sys.argv[2]).resolve() / 'sandbox-state'
original_run = subprocess.run
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
class BasicLimit(ctypes.Structure):
    _fields_ = [('per_process',ctypes.c_longlong),('per_job',ctypes.c_longlong),('flags',wintypes.DWORD),('min_ws',ctypes.c_size_t),('max_ws',ctypes.c_size_t),('active',wintypes.DWORD),('affinity',ctypes.c_size_t),('priority',wintypes.DWORD),('scheduling',wintypes.DWORD)]
class IoCounters(ctypes.Structure):
    _fields_ = [(name,ctypes.c_ulonglong) for name in ('read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes')]
class ExtendedLimit(ctypes.Structure):
    _fields_ = [('basic',BasicLimit),('io',IoCounters),('process_mem',ctypes.c_size_t),('job_mem',ctypes.c_size_t),('peak_process_mem',ctypes.c_size_t),('peak_job_mem',ctypes.c_size_t)]
kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,wintypes.LPCWSTR];kernel.CreateJobObjectW.restype=wintypes.HANDLE
kernel.SetInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD];kernel.SetInformationJobObject.restype=wintypes.BOOL
kernel.AssignProcessToJobObject.argtypes=[wintypes.HANDLE,wintypes.HANDLE];kernel.AssignProcessToJobObject.restype=wintypes.BOOL
kernel.TerminateJobObject.argtypes=[wintypes.HANDLE,wintypes.UINT];kernel.TerminateJobObject.restype=wintypes.BOOL
kernel.CloseHandle.argtypes=[wintypes.HANDLE];kernel.CloseHandle.restype=wintypes.BOOL

def diagnostics():
    lines=[]
    # Fixture-only errors and ordinary argument-redacted logs. No passwords,
    # sandbox_users files, profile secrets, token SIDs or screenshot content.
    paths=[home/'.sandbox/setup_error.json', *sorted((home/'.sandbox').glob('sandbox.*.log'))[-2:]]
    for p in paths:
        if p.is_file() and not p.is_symlink():
            with p.open('rb') as f:
                f.seek(0,2);f.seek(max(0,f.tell()-32768));text=f.read().decode(errors='replace')
            lines.append(p.name+'\n'+text)
    caps=home/'cap_sid'
    if caps.is_file() and caps.stat().st_size < 65536:
        data=json.loads(caps.read_text())
        lines.append('capability roots (identifiers omitted): '+json.dumps({'workspace_paths':list(data.get('workspace_by_cwd',{})), 'root_paths':list(data.get('writable_root_by_path',{}))}))
    text='\n'.join(lines)
    Path('aiTemp/evidence/sandbox-diagnostics.txt').write_text(text,encoding='utf-8')
    print(text,flush=True)

def supervised_run(args, **kw):
    if not isinstance(args, list) or not args or Path(args[0]).resolve() != helper:
        return original_run(args, **kw)
    assert set(kw) <= {'input','capture_output','env','timeout'} and kw.get('capture_output') is True
    operation=json.loads(kw['input'])['operation']
    print(json.dumps({'operation_started':operation}),flush=True)
    job=kernel.CreateJobObjectW(None,None)
    if not job: raise ctypes.WinError(ctypes.get_last_error())
    start=time.monotonic()
    try:
        limits=ExtendedLimit();limits.basic.flags=0x2000
        if not kernel.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        process=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=kw['env'])
        if not kernel.AssignProcessToJobObject(job,wintypes.HANDLE(int(process._handle))):
            error=ctypes.get_last_error();process.kill();process.wait(timeout=5)
            raise ctypes.WinError(error)
        try:
            stdout,stderr=process.communicate(kw['input'],timeout=150 if operation=='setup' else 40)
        except subprocess.TimeoutExpired:
            kernel.TerminateJobObject(job,124)
            try: stdout,stderr=process.communicate(timeout=10)
            except subprocess.TimeoutExpired: stdout,stderr=b'',b'Output pipes did not close after tree termination'
            diagnostics()
            print(json.dumps({'operation_timeout':operation,'stdout':stdout[-16384:].decode(errors='replace'),'stderr':stderr[-16384:].decode(errors='replace')}),flush=True)
            raise
        print(json.dumps({'operation_finished':operation,'duration_seconds':round(time.monotonic()-start,3),'exit_code':process.returncode}),flush=True)
        if process.returncode != 0: diagnostics()
        return subprocess.CompletedProcess(args,process.returncode,stdout,stderr)
    finally:
        kernel.CloseHandle(job)

subprocess.run=supervised_run
try:
    runpy.run_path(str(Path(__file__).with_name('sandbox_native.py')),run_name='__main__')
finally:
    diagnostics()
