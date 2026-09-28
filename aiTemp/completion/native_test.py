"""Three real Windows boundary groups. Synthetic data, no destructive cleanup or provider calls."""
from pathlib import Path
import base64, hashlib, json, os, shutil, socket, subprocess, time, uuid
root=Path('aiTemp/native-checks')/str(uuid.uuid4());root.mkdir(parents=True)
helper=Path(os.environ['APP_CONTAINER_HELPER']).resolve()
probe=Path(os.environ['APP_CONTAINER_PROBE']).resolve()
profile='CodingToolsMcp.Snapshot.'+hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:30]
input_dir=root/'input';work=root/'work';input_dir.mkdir();work.mkdir()
input_file=input_dir/'input.txt';input_file.write_text('READABLE_SYNTHETIC_INPUT')
external=root/'private-outside.txt';external.write_text('SYNTHETIC_OUTSIDE_MUST_REMAIN')
# Make the negative target a private caller-owned file, not a public system resource.
user=subprocess.check_output(['whoami','/user','/fo','csv','/nh'],text=True).strip().split(',')[-1].strip('"')
subprocess.run(['icacls',str(external),'/inheritance:r','/grant:r',f'*{user}:(F)','*S-1-5-18:(F)'],check=True,stdout=subprocess.DEVNULL)
program=input_dir/'probe.exe';shutil.copy2(probe,program)
listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(8);port=listener.getsockname()[1]
args=[str(program.resolve()),'probe',str(input_file.resolve()),str(external.resolve()),str((work/'output.txt').resolve()),str(port)]
baseline=json.loads(subprocess.check_output(args,timeout=10))
assert baseline=={'container':False,'input_read':True,'input_write':True,'external_read':True,'external_write':True,'work_write':True,'network':True},baseline

def request(command,timeout=4000,extended=True):
    def spelling(path):
        value=str(path)
        prefix='\\'*2+'?'+ '\\'
        return value if not extended or value.startswith(prefix) else prefix+value
    command=[spelling(command[0]),*command[1:]]
    run=subprocess.run([str(helper),profile,spelling(input_dir.resolve()),spelling(work.resolve()),str(timeout),'--',*command],input=b'start',capture_output=True,timeout=timeout/1000+10)
    assert run.returncode==0,(run.returncode,run.stderr.decode(errors='replace'))
    data=json.loads(run.stdout)
    assert data['requested_identity_verified'] and data['appcontainer_token_verified'] and data['network_capabilities']==0 and data['model_requests']==0
    data['stdout']=base64.b64decode(data.pop('stdout_base64')).decode(errors='replace')
    data['stderr']=base64.b64decode(data.pop('stderr_base64')).decode(errors='replace')
    return data

ordinary=request(args,extended=False)
assert ordinary['exit_code']==0 and not ordinary['timed_out'],ordinary
assert json.loads(ordinary['stdout'])=={'container':True,'input_read':True,'input_write':False,'external_read':False,'external_write':False,'work_write':True,'network':False},ordinary
result=request(args)
assert result['exit_code']==0 and not result['timed_out'],result
observed=json.loads(result['stdout'])
assert observed=={'container':True,'input_read':True,'input_write':False,'external_read':False,'external_write':False,'work_write':True,'network':False},observed
assert input_file.read_text()=='READABLE_SYNTHETIC_INPUT' and external.read_text()=='SYNTHETIC_OUTSIDE_MUST_REMAIN'
print('PASS: native command runs; read-only input and work writes succeed; live external reads/writes and loopback connection are denied',flush=True)
# Keep cmd grammar coverage in the existing native filesystem boundary group.
cmd=str(Path(os.environ['SystemRoot'])/'System32/cmd.exe')
space_file=input_dir/'input with spaces.txt';space_file.write_text('SPACED_INPUT_UNCHANGED')
for extended in [False,True]:
    echo=request([cmd,'/d','/s','/c','echo SNAPSHOT_OK'],extended=extended)
    assert echo['exit_code']==0 and 'SNAPSHOT_OK' in echo['stdout'],echo
    read=request([cmd,'/d','/c','type "%MCP_SANDBOX_INPUT%\\input with spaces.txt"'],extended=extended)
    assert read['exit_code']==0 and read['stdout']=='SPACED_INPUT_UNCHANGED',read
assert space_file.read_text()=='SPACED_INPUT_UNCHANGED'
print('PASS: real cmd parser preserves quoted file names for ordinary and extended snapshot paths',flush=True)
late=work/'late-marker.txt'
result=request([str(program.resolve()),'linger',str(late.resolve())],400)
assert result['timed_out'] and result['exit_code']==124 and 'owned_child_started=' in result['stdout'],result
time.sleep(2.3)
assert not late.exists(),'DESCENDANT_SURVIVED_JOB_TIMEOUT'
print('PASS: timeout terminates owned parent and descendant before delayed output',flush=True)
result=request([str(program.resolve()),'overflow'],3000)
assert result['limit_exceeded'] and len(result['stdout'].encode())<=65536,result
print('PASS: bounded output capture aborts overflow without an unsandboxed retry',flush=True)
listener.close()
proof={'backend':'windows-appcontainer-v1','passed_groups':3,'helper_sha256':hashlib.sha256(helper.read_bytes()).hexdigest(),'model_requests':0,'native_token_verified':True,'ordinary_and_extended_paths_verified':True,'cmd_parser_verified':True,'read_only_input':True,'external_user_file_denied':True,'loopback_denied':True,'descendants_terminated':True,'output_bounded':True,'fixtures_retained':str(root),'live_user_workspace_verified':False}
Path('aiTemp/evidence').mkdir(parents=True,exist_ok=True)
Path('aiTemp/evidence/native-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
