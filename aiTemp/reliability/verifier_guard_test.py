"""One focused group: execute the actual packaging guard against real Git fixtures."""
from pathlib import Path
import ast, hashlib, json, os, subprocess, uuid

root=Path.cwd().resolve()
relative='aiTemp/timeout-recovery/package.py'
canonical=subprocess.check_output(['git','show','13410a4cd4b148e2fa94462102056017119c94af:'+relative])
package=(root/'aiTemp/reliability/package.py').read_text(encoding='utf-8')
statements=ast.parse(package).body
start=next(i for i,n in enumerate(statements) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='path' for t in n.targets))
end=next(i for i,n in enumerate(statements[start+1:],start+1) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='source' for t in n.targets))
guard=compile(ast.Module(body=statements[start:end],type_ignores=[]),'<actual packaging integrity guard>','exec')
fixture=root/'aiTemp/verifier-guard'/str(uuid.uuid4())
fixture.mkdir(parents=True,exist_ok=False)
p=fixture/relative;p.parent.mkdir(parents=True);p.write_bytes(canonical)
def git(*args):
    return subprocess.check_output(['git','-c','gc.auto=0',*args],cwd=fixture,stderr=subprocess.STDOUT)
git('init');git('config','core.autocrlf','false');git('config','user.name','Verifier fixture');git('config','user.email','fixture@example.invalid')
git('add','--',relative);git('commit','-m','fixture: pinned verifier bytes')
def accepted():
    previous=Path.cwd()
    try:
        os.chdir(fixture)
        exec(guard,{'Path':Path,'hashlib':hashlib,'subprocess':subprocess})
        return True
    except AssertionError:
        return False
    finally:os.chdir(previous)
def replace(content,label):
    trash=fixture/'Trash'/label;trash.parent.mkdir(parents=True,exist_ok=True)
    p.rename(trash);p.write_bytes(content)
assert accepted(),'LF_CHECKOUT_REJECTED'
replace(canonical.replace(b'\n',b'\r\n'),'original-lf.py')
assert accepted(),'WINDOWS_CRLF_CHECKOUT_REJECTED'
replace(canonical+b'\nraise RuntimeError("synthetic tamper")\n','original-crlf.py')
assert not accepted(),'WORKTREE_TAMPER_ACCEPTED'
git('add','--',relative);git('commit','-m','fixture: synthetic changed verifier')
assert not accepted(),'COMMITTED_TAMPER_ACCEPTED'
proof={'passed':True,'checks':['LF accepted','CRLF accepted','worktree tamper rejected','committed tamper rejected'],
       'canonical_sha256':hashlib.sha256(canonical).hexdigest(),'model_requests':0,'fixture_retained':str(fixture)}
evidence=root/'aiTemp/evidence';evidence.mkdir(parents=True,exist_ok=True)
(evidence/'verifier-guard.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('VERIFIER_GUARD: LF/CRLF accepted; worktree and committed tampering rejected; no files deleted')
