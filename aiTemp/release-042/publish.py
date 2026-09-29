"""Publish one verified prerelease. No deletes, force pushes or asset overwrites."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import zipfile

REPO = 'p90-lover/coding-tools-mcp'
VERSION = '0.4.2-rc.1'
TAG = 'v' + VERSION
EXPECTED_MAIN = 'fa7f323aa52ee5b5c143f61ff46fc534264f79ff'
SOURCE = os.environ['SOURCE']
RUN = os.environ['GITHUB_RUN_ID']
assert os.environ['GITHUB_REPOSITORY'] == REPO
assert re.fullmatch('[0-9a-f]{40}', SOURCE) and RUN.isdecimal()
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip() == SOURCE


def gh(*args, data=None):
    return subprocess.check_output(['gh', *args], input=data, text=True).strip()


def api(path, method='GET', payload=None, missing_ok=False):
    args = ['gh','api','--method',method,f'repos/{REPO}/{path}']
    if payload is not None:
        args += ['--input','-']
    p = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True)
    if p.returncode:
        if missing_ok and 'HTTP 404' in p.stderr:
            return None
        raise RuntimeError(f'GitHub {method} {path} failed: {p.stderr[:1000]}')
    return json.loads(p.stdout) if p.stdout.strip() else None


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle,'sha256').hexdigest()


# The workflow dependency graph must be green before this script is reachable.
# Independently check every artifact's immutable tested source and result markers.
root = Path('aiTemp/release-downloads'); root.mkdir(parents=True,exist_ok=False)
assets = Path('aiTemp/release-assets'); assets.mkdir(parents=True,exist_ok=False)
proofs = {}
for platform in ['windows-x64','macos-aarch64']:
    target = root/platform
    gh('run','download',RUN,'--repo',REPO,'--name',f'release-042-{platform}-{RUN}','--dir',str(target))
    proof = json.loads((target/'proof.json').read_text())
    assert proof['source_commit'] == SOURCE and proof['version'] == VERSION
    assert proof['platform'] == platform and proof['workflow_run'] == int(RUN)
    assert proof['native_codex_lifecycle_verified'] and proof['mcp_http_regressions_passed'] and proof['full_catalog_verified']
    assert not proof['paid_inference_configured'] and not proof['live_provider_acceptance_tested']
    expected = 'Coding.Tools.MCP_' + VERSION + ('_x64-setup.exe' if platform=='windows-x64' else '_aarch64.dmg')
    assert proof['asset'] == expected
    binary = target/expected
    assert binary.is_file() and not binary.is_symlink()
    assert binary.stat().st_size == proof['size'] and sha(binary) == proof['sha256']
    shutil.copy2(binary,assets/expected)
    (assets/f'proof-{platform}.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
    proofs[platform] = proof
    gh('run','download',RUN,'--repo',REPO,'--name',f'release-042-evidence-{platform}-{RUN}','--dir',str(root/f'evidence-{platform}'))
board = root/'board'
gh('run','download',RUN,'--repo',REPO,'--name',f'release-042-board-{RUN}','--dir',str(board))
result = json.loads((board/'board-ui-result.json').read_text())
assert result['passed'] and result['source'] == SOURCE and result['console_errors'] == []
assert '3 passed; 0 failed' in (board/'board.txt').read_text()
with zipfile.ZipFile(assets/'validation-evidence.zip','x',compression=zipfile.ZIP_DEFLATED) as archive:
    for directory in [board, root/'evidence-windows-x64', root/'evidence-macos-aarch64']:
        for file in sorted(directory.rglob('*')):
            assert not file.is_symlink()
            if file.is_file():
                assert file.stat().st_size < 16*1024*1024
                archive.write(file, str(file.relative_to(root)))
manifest = {'version':VERSION,'source_commit':SOURCE,'workflow_run':int(RUN),
            'platforms':proofs,'board':result,'live_chatgpt_verified':False,
            'live_provider_verified':False,'release_channel':'prerelease'}
(assets/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
files = sorted(assets.iterdir())
(assets/'SHA256SUMS.txt').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in files),encoding='utf-8')
files = sorted(assets.iterdir())
notes = Path('docs/releases/v0.4.2-rc.1.md').read_text(encoding='utf-8')
notes += f'\n\nSource commit: `{SOURCE}`\n\nValidation: https://github.com/{REPO}/actions/runs/{RUN}\n'
release = api(f'releases/tags/{TAG}',missing_ok=True)
if release is None:
    release = api('releases','POST',{'tag_name':TAG,'target_commitish':SOURCE,
        'name':f'Coding Tools MCP {TAG} — MCP discovery, native Codex and task board',
        'body':notes,'draft':True,'prerelease':True,'make_latest':'false'})
assert release['tag_name'] == TAG and release['target_commitish'] == SOURCE
assert release['draft'], 'A published release is immutable here; inspect rather than overwrite it'
existing = {item['name']:item for item in release['assets']}
for file in files:
    if file.name in existing:
        item = existing[file.name]
        assert item['size'] == file.stat().st_size and item.get('digest') == 'sha256:' + sha(file)
    else:
        gh('release','upload',TAG,str(file),'--repo',REPO)
# Re-download the draft with the official CLI, which confines its token to GitHub.
readback = Path('aiTemp/release-readback'); readback.mkdir(parents=True,exist_ok=False)
gh('release','download',TAG,'--repo',REPO,'--dir',str(readback))
assert {p.name for p in readback.iterdir()} == {p.name for p in files}
for file in files:
    assert sha(readback/file.name) == sha(file), file.name
head = api('git/ref/heads/main')['object']['sha']
assert head in (EXPECTED_MAIN,SOURCE), 'main changed concurrently; reconcile without force pushing'
if head != SOURCE:
    api('git/refs/heads/main','PATCH',{'sha':SOURCE,'force':False})
assert api('git/ref/heads/main')['object']['sha'] == SOURCE
ref = api(f'git/ref/tags/{TAG}',missing_ok=True)
if ref is None:
    api('git/refs','POST',{'ref':'refs/tags/'+TAG,'sha':SOURCE})
else:
    assert ref['object']['type'] == 'commit' and ref['object']['sha'] == SOURCE
api(f'releases/{release["id"]}','PATCH',{'draft':False,'prerelease':True,'make_latest':'false'})
public = api(f'releases/tags/{TAG}')
assert not public['draft'] and public['prerelease']
assert {a['name'] for a in public['assets']} == {p.name for p in files}
assert api(f'git/ref/tags/{TAG}')['object']['sha'] == SOURCE
Path('aiTemp/release-receipt.json').write_text(json.dumps({
    'release':public['html_url'],'id':public['id'],'source_commit':SOURCE,
    'tag':TAG,'main_updated':True,'downloaded_assets_verified':True,
    'assets':[{'name':p.name,'sha256':sha(p),'size':p.stat().st_size} for p in files],
},indent=2)+'\n',encoding='utf-8')
print('PUBLISHED_VERIFIED_RELEASE ' + public['html_url'])
