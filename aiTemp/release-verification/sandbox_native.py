"""Focused native isolation check; only isolated fixture files, no model calls."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

helper = Path(sys.argv[1]).resolve()
base = Path(sys.argv[2]).resolve()
root, home = base / 'workspace', base / 'sandbox-state'
root.mkdir(parents=True, exist_ok=False)
(home / 'aiTemp').mkdir(parents=True, exist_ok=False)
private = base / 'private'
private.mkdir(exist_ok=False)
inside, outside = root / 'sentinel.txt', private / 'outside-private.txt'
inside.write_text('unchanged-sandbox-fixture', encoding='utf-8')
outside.write_text('private-outside-fixture', encoding='utf-8')
expected = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (inside, outside)]
alias = root / 'outside-junction'
subprocess.run([os.environ['COMSPEC'], '/d', '/c', 'mklink', '/J', str(alias), str(private)], check=True)
assert (alias / outside.name).read_bytes() == outside.read_bytes()
probe_source, probe = base / 'probe.rs', root / 'isolation-probe.exe'
probe_source.write_text(r'''
use std::{env,fs,io::{self,Write},net::{SocketAddr,TcpStream},time::Duration};
fn main() {
 let a:Vec<String>=env::args().collect();
 match a.get(1).map(String::as_str) {
  Some("read")=>print!("{}",fs::read_to_string(&a[2]).expect("permitted read")),
  Some("deny-write")=>match fs::OpenOptions::new().write(true).open(&a[2]) {
   Err(e) if e.kind()==io::ErrorKind::PermissionDenied=>print!("write-denied"),
   Err(e)=>panic!("wrong write failure: {e}"), Ok(_)=>panic!("write handle unexpectedly granted")},
  Some("deny-read")=>match fs::read(&a[2]) {
   Err(e) if e.kind()==io::ErrorKind::PermissionDenied=>print!("outside-read-denied"),
   Err(e)=>panic!("wrong read failure: {e}"), Ok(_)=>panic!("outside read unexpectedly allowed")},
  Some("network")=>{let addr:SocketAddr=a[2].parse().unwrap();
   match TcpStream::connect_timeout(&addr,Duration::from_millis(1200)) {
    Ok(mut stream)=>{stream.write_all(b"sandbox-fixture").unwrap();print!("connected")},
    Err(e) if matches!(e.kind(),io::ErrorKind::PermissionDenied|io::ErrorKind::TimedOut|io::ErrorKind::WouldBlock)=>print!("network-denied"),
    Err(e)=>panic!("ambiguous network failure: {e}")}},
  _=>panic!("invalid probe operation")
 }
}
''', encoding='utf-8')
subprocess.run(['rustc', '--edition', '2021', str(probe_source), '-o', str(probe)], check=True)
keep = {'SYSTEMROOT','SYSTEMDRIVE','WINDIR','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','USERNAME','USERPROFILE','LOCALAPPDATA','APPDATA'}
env = {k:v for k,v in os.environ.items() if k.upper() in keep}
env.update({'TEMP':str(home/'aiTemp'),'TMP':str(home/'aiTemp'),'CODEX_HOME':str(home),'OTEL_SDK_DISABLED':'true','DO_NOT_TRACK':'1'})
def request(operation, argv=None):
    child_env = env.copy()
    if operation == 'setup':
        child_env['CODING_TOOLS_LOCAL_SANDBOX_SETUP'] = '1'
    data = {'operation':operation,'workspace':str(root),'home':str(home),'argv':argv or [],'timeout_ms':8000}
    result = subprocess.run([str(helper)], input=json.dumps(data).encode(), capture_output=True, env=child_env, timeout=180 if operation=='setup' else 60)
    assert len(result.stdout) <= 4194304 and len(result.stderr) <= 65536
    try:
        value = json.loads(result.stdout)
    except Exception:
        print(result.stdout.decode(errors='replace'))
        print(result.stderr.decode(errors='replace'))
        raise
    print(json.dumps({'operation':operation,'exit_code':result.returncode,'result':value}))
    assert value['upstream_commit']=='3caf9f9586baedb4158a7b91545ead3dd320c348' and value['model_calls'] is False
    return value

def run(mode, arg):
    return request('exec', [str(probe), mode, str(arg)])

assert subprocess.check_output([str(probe),'read',str(inside)]).decode()=='unchanged-sandbox-fixture'
assert request('setup').get('ready') is True
assert request('status').get('ready') is True
read = run('read', inside)
assert read['ok'] and read['stdout']=='unchanged-sandbox-fixture', read
for mode,path,answer in [('deny-write',inside,'write-denied'),('deny-read',outside,'outside-read-denied')]:
    denied = run(mode, path)
    assert denied['ok'] and denied['stdout']==answer, denied
assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in (inside,outside)] == expected
# Reparse aliases and files created after setup must not bypass the same read gate.
late = private / 'created-after-setup.txt'
late.write_text('late-private-fixture', encoding='utf-8')
for path in (alias / outside.name, late):
    assert subprocess.check_output([str(probe),'read',str(path)])
    denied = run('deny-read', path)
    assert denied['ok'] and denied['stdout']=='outside-read-denied', denied
print('PASS: native permitted read; denied write handle, outside read, junction alias and newly created private file; sentinels unchanged')
with socket.socket() as listener:
    listener.bind(('127.0.0.1',0))
    listener.listen(2)
    listener.settimeout(2)
    address = '127.0.0.1:'+str(listener.getsockname()[1])
    positive = subprocess.run([str(probe),'network',address],capture_output=True,check=True,timeout=5)
    assert positive.stdout == b'connected'
    connection,_ = listener.accept()
    assert connection.recv(64) == b'sandbox-fixture'
    connection.close()
    network = run('network',address)
    assert network['ok'] and network['stdout']=='network-denied', network
    listener.settimeout(.3)
    try:
        connection,_=listener.accept()
        connection.close()
        raise AssertionError('Sandbox reached loopback listener')
    except socket.timeout:
        pass
print('PASS: native network positive control succeeds; sandbox network is denied')
assert not any(p.suffix.lower() in ('.png','.jpg','.jpeg','.webp') for p in base.rglob('*') if p.is_file())
Path('aiTemp/evidence/sandbox-proof.json').write_text(json.dumps({'upstream_commit':'3caf9f9586baedb4158a7b91545ead3dd320c348','native_verified':True,'model_session_invoked':False,'checks':['native_allowed_read','native_write_handle_denied','native_outside_read_denied','native_reparse_read_denied','native_future_private_read_denied','native_loopback_denied_with_positive_control']},indent=2)+'\n',encoding='utf-8')
