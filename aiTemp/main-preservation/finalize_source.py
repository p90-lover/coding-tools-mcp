"""Preserve both histories and prove that the retained EXE has identical build inputs."""
from pathlib import Path
import hashlib,json,os,subprocess
REPO='p90-lover/coding-tools-mcp'
BUILD='595728146355170aeaa4c563e179c66d670b3b30'
MAIN='905b9ac322636ea793195d1a0caf3a2fb7d1d9b7'
BRANCH='fix/main-preservation-0.4.3-rc.4'
INCOMING={'.github/workflows/paired-browser-diagnostic.yml','.github/workflows/paired-extension-release.yml','.github/workflows/paired-release-recovery.yml','aiTemp/compat/browser_test.py','aiTemp/compat/prepare.py','aiTemp/oauth-popup/csp_prepare.py','aiTemp/oauth-popup/http_flow.rs','aiTemp/oauth-popup/publish.py','aiTemp/paired-validation/publish.py','aiTemp/paired-validation/replay.py','docs/releases/v0.4.3-rc.3.md'}
FINALIZATION={'.github/workflows/main-preservation-finalize.yml','aiTemp/main-preservation/finalize_source.py','aiTemp/main-preservation/finalize_publish.py'}
TRASH='aiTemp/Trash/rc4-reconciliation/'
def git(*args):return subprocess.check_output(['git',*args],text=True).strip()
def api(path):return json.loads(subprocess.check_output(['gh','api',f'repos/{REPO}/{path}']))
def paths(*args):return set(git(*args).splitlines())
def preserved_inputs(ref):
    records=[]
    for entry in subprocess.check_output(['git','ls-tree','-r','-z',ref]).split(b'\0'):
        if not entry:continue
        metadata,raw_path=entry.split(b'\t',1);path=raw_path.decode('utf-8')
        if path in INCOMING|FINALIZATION or path.startswith(TRASH):continue
        records.append(entry)
    return {'files':len(records),'sha256':hashlib.sha256(b'\0'.join(records)).hexdigest()}
def verify_inputs(head):
    changed=paths('diff','--name-only',BUILD,head)
    assert all(p in INCOMING|FINALIZATION or p.startswith(TRASH) for p in changed),sorted(changed)
    assert not paths('diff','--diff-filter=D','--name-only',BUILD,head)
    before,after=preserved_inputs(BUILD),preserved_inputs(head)
    assert before==after and before['files']>100,(before,after)
    return {'source_commit':BUILD,'main_commit':head,'preserved_main':MAIN,'production_and_build_inputs_identical':True,'input_manifest':after,'non_application_changes':sorted(changed)}
if __name__=='__main__':
    assert os.environ['GITHUB_REPOSITORY']==REPO
    assert git('rev-parse','HEAD')==os.environ['GITHUB_SHA']
    assert api('git/ref/heads/main')['object']['sha']==MAIN,'Concurrent main changed again'
    assert api('git/ref/heads/'+BRANCH)['object']['sha']==os.environ['GITHUB_SHA']
    subprocess.run(['git','fetch','--no-tags','origin',MAIN,BUILD],check=True)
    common=git('merge-base',BUILD,MAIN)
    incoming=paths('diff','--name-only',common,MAIN)
    assert incoming==INCOMING,sorted(incoming)
    assert not paths('diff','--diff-filter=D','--name-only',common,MAIN)
    assert paths('diff','--name-only',BUILD,'HEAD')<=FINALIZATION
    # Keep both versions of affected support files before resolving their merge.
    for ref,label in [(BUILD,'rc4'),(MAIN,'concurrent-main')]:
        for name in sorted(INCOMING):
            exists=subprocess.run(['git','cat-file','-e',ref+':'+name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
            if exists:
                target=Path(TRASH)/label/name
                assert not target.exists() and not target.is_symlink()
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(subprocess.check_output(['git','show',ref+':'+name]))
    subprocess.run(['git','config','user.name','p90-lover'],check=True)
    subprocess.run(['git','config','user.email','146848721+p90-lover@users.noreply.github.com'],check=True)
    merge=subprocess.run(['git','merge','--no-ff','--no-commit',MAIN])
    conflicts=paths('diff','--name-only','--diff-filter=U')
    assert conflicts<={'aiTemp/oauth-popup/csp_prepare.py','aiTemp/oauth-popup/publish.py'},sorted(conflicts)
    assert merge.returncode==0 or conflicts,'Unexpected merge failure'
    # Main keeps its paired validator/publisher; rc4 keeps its standalone publisher.
    # The competing standalone publisher is retained under Trash, never discarded.
    for name in sorted(INCOMING):
        ref=BUILD if name=='aiTemp/oauth-popup/publish.py' else MAIN
        target=Path(name);assert not target.is_symlink()
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(subprocess.check_output(['git','show',ref+':'+name]))
    subprocess.run(['git','add','--',*sorted(INCOMING),TRASH],check=True)
    assert not paths('diff','--name-only','--diff-filter=U')
    subprocess.run(['git','diff','--cached','--check'],check=True)
    verify_inputs(git('write-tree'))
    assert not paths('diff','--cached','--diff-filter=D','--name-only')
    subprocess.run(['git','commit','-m','merge: preserve concurrent extension release work and exact verified rc4 application inputs'],check=True)
    head=git('rev-parse','HEAD')
    for ref in [BUILD,MAIN]:subprocess.run(['git','merge-base','--is-ancestor',ref,head],check=True)
    proof=verify_inputs(head);proof.update({'validation_run':int(os.environ['GITHUB_RUN_ID']),'binary_rebuilt':False})
    Path('aiTemp/evidence').mkdir(parents=True,exist_ok=True)
    Path('aiTemp/evidence/reconciled-inputs.json').write_text(json.dumps(proof,indent=2)+'\n')
    assert api('git/ref/heads/main')['object']['sha']==MAIN
    assert api('git/ref/heads/'+BRANCH)['object']['sha']==os.environ['GITHUB_SHA']
    subprocess.run(['gh','auth','setup-git'],check=True)
    subprocess.run(['git','push','origin','HEAD:refs/heads/'+BRANCH],check=True)
    with open(os.environ['GITHUB_OUTPUT'],'a') as output:output.write('source='+head+'\n')
    print(json.dumps(proof,indent=2))
