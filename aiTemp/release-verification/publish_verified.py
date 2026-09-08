"""Publish only the exact native-tested source; retain every existing file and asset."""
from pathlib import Path, PurePosixPath
import base64, hashlib, io, json, os, re, subprocess, time, urllib.parse, zipfile

REPO = os.environ['GITHUB_REPOSITORY']
BRANCH = 'release/remembered-control-finish-0.3.6'
VERSION = '0.3.6-rc.1'
TAG = 'v' + VERSION
ROOT = Path('aiTemp/verified-publication')
ROOT.mkdir(parents=True, exist_ok=True)

def api(path, method='GET', body=None):
    args = ['gh', 'api', f'repos/{REPO}/{path}', '--method', method]
    data = None
    if body is not None:
        args += ['--input', '-']
        data = json.dumps(body).encode()
    return json.loads(subprocess.check_output(args, input=data, timeout=90))

def download(path):
    return subprocess.check_output(['gh', 'api', f'repos/{REPO}/{path}', '--header', 'Accept: application/octet-stream'], timeout=180)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        assert path.read_bytes() == data, f'Existing bytes differ: {path}'
    else:
        with path.open('xb') as output:
            output.write(data)

source = api('git/ref/heads/' + BRANCH)['object']['sha']
assert re.fullmatch('[0-9a-f]{40}', source)
package = json.loads(base64.b64decode(api(f'contents/package.json?ref={source}')['content']))
assert package['version'] == VERSION
# Pin once: later source changes must never substitute untested bytes.
deadline = time.monotonic() + 1200
while True:
    query = urllib.parse.urlencode({'branch': BRANCH, 'head_sha': source, 'per_page': 30})
    runs = api('actions/runs?' + query)['workflow_runs']
    matches = [r for r in runs if r['head_sha'] == source and r['path'] == '.github/workflows/remembered-control-verify.yml']
    if matches:
        run = max(matches, key=lambda r: r['id'])
        assert run['actor']['login'] == REPO.split('/')[0]
        if run['status'] == 'completed':
            assert run['conclusion'] == 'success', f'Native verification failed: {run["html_url"]}'
            break
    assert time.monotonic() < deadline, 'Exact-source native verification has not completed; no release was published'
    time.sleep(30)
run_id = run['id']
jobs_response = api(f'actions/runs/{run_id}/jobs?per_page=100')
assert jobs_response['total_count'] == len(jobs_response['jobs'])
jobs = jobs_response['jobs']
assert len(jobs) == 2 and all(j['conclusion'] == 'success' for j in jobs)
windows = [j for j in jobs if 'windows-x64' in j['name']]
macos = [j for j in jobs if 'macos-arm64' in j['name']]
assert len(windows) == len(macos) == 1
for name in ['Native isolation with positive controls', 'Real Windows background observation and input', 'Build and verify actual installer resources']:
    steps = [s for s in windows[0]['steps'] if s['name'] == name]
    assert len(steps) == 1 and steps[0]['conclusion'] == 'success', name
artifacts_response = api(f'actions/runs/{run_id}/artifacts?per_page=100')
assert artifacts_response['total_count'] == len(artifacts_response['artifacts'])
artifacts = artifacts_response['artifacts']
evidence = {}
installers = {}
proofs = []
for platform in ['windows-x64', 'macos-arm64']:
    for kind in ['installer', 'evidence']:
        name = f'remembered-{kind}-{platform}-{run_id}'
        selected = [a for a in artifacts if a['name'] == name and not a['expired']]
        assert len(selected) == 1, name
        artifact = selected[0]
        archive = download(f'actions/artifacts/{artifact["id"]}/zip')
        assert artifact.get('digest') == 'sha256:' + sha(archive), name
        save(ROOT / (name + '.zip'), archive)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            infos = [i for i in z.infolist() if not i.is_dir()]
            assert len(infos) <= 100 and sum(i.file_size for i in infos) < 536870912
            files = {}
            for info in infos:
                p = PurePosixPath(info.filename)
                assert not p.is_absolute() and '..' not in p.parts and '\\' not in info.filename and ':' not in info.filename
                assert (info.external_attr >> 16) & 0o170000 != 0o120000
                assert info.filename not in files
                files[info.filename] = z.read(info)
        if kind == 'evidence':
            for name, data in files.items():
                assert PurePosixPath(name).suffix in {'.txt', '.json'} and len(data) < 16777216
                evidence[platform + '/' + name] = data
        else:
            found = [json.loads(data) for name, data in files.items() if PurePosixPath(name).name == 'proof.json']
            assert len(found) == 1
            proof = found[0]
            assert proof['source_commit'] == source and proof['version'] == VERSION and proof['platform'] == platform
            assert proof['screenshot_storage'] == 'memory_only' and proof['codex_invoked'] is False
            name = proof['asset']
            assert PurePosixPath(name).name == name
            binary = [data for path, data in files.items() if PurePosixPath(path).name == name]
            assert len(binary) == 1 and len(binary[0]) == proof['size'] and sha(binary[0]) == proof['sha256']
            assert name.endswith('_x64-setup.exe' if platform == 'windows-x64' else '_aarch64.dmg')
            installers[name] = binary[0]
            proofs.append(proof)
assets = dict(installers)
validation = io.BytesIO()
with zipfile.ZipFile(validation, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in sorted(evidence.items()):
        z.writestr(name, data)
assets['computer-use-validation.zip'] = validation.getvalue()
provenance = {'version': VERSION, 'source_commit': source, 'verification_run': run_id, 'publication_run': int(os.environ['GITHUB_RUN_ID']), 'upstream_sandbox_commit': '3caf9f9586baedb4158a7b91545ead3dd320c348', 'native_jobs': [{'id': j['id'], 'name': j['name'], 'conclusion': j['conclusion']} for j in jobs], 'installers': proofs, 'prerelease': True}
assets['release-provenance.json'] = (json.dumps(provenance, indent=2) + '\n').encode()
assets['SHA256SUMS.txt'] = ''.join(f'{sha(data)}  {name}\n' for name, data in sorted(assets.items())).encode()
assert len(assets) == 5
for name, data in assets.items():
    save(ROOT / 'assets' / name, data)
assert api('git/ref/heads/' + BRANCH)['object']['sha'] == source
comparison = api('compare/main...' + source)
assert comparison['behind_by'] == 0 and comparison['status'] in {'ahead', 'identical'}, 'Main changed; never force-push'
assert not api('git/matching-refs/tags/' + TAG), 'An existing release tag is never replaced'
notes = base64.b64decode(api(f'contents/docs/releases/{TAG}.md?ref={source}')['content']).decode('utf-8')
notes += '\n\nNative release verification additionally requires a capability-free AppContainer read boundary and a real executable probe: permitted workspace read, blocked write, blocked private outside read, and blocked network with positive controls. This is the separate read-only sandbox tool, not isolation of the GUI or every legacy tool.\n\n原生發佈驗證亦要求不授予額外能力的 AppContainer 讀取隔離及真實執行檔測試，涵蓋允許工作區讀取、拒絕寫入、拒絕工作區外私人檔案讀取及拒絕網絡連線，並附正向對照。這是獨立唯讀沙箱工具，不代表整個 GUI 或所有舊工具都已隔離。\n'
api('git/refs', 'POST', {'ref': 'refs/tags/' + TAG, 'sha': source})
release = api('releases', 'POST', {'tag_name': TAG, 'target_commitish': source, 'name': f'Coding Tools MCP {TAG} — remembered approval and background vision', 'body': notes, 'draft': True, 'prerelease': True, 'make_latest': 'false'})
ident = release['id']
save(ROOT / 'draft-id.txt', (str(ident) + '\n').encode())
for name, data in sorted(assets.items()):
    url = f'https://uploads.github.com/repos/{REPO}/releases/{ident}/assets?' + urllib.parse.urlencode({'name': name})
    uploaded = json.loads(subprocess.check_output(['gh', 'api', url, '--method', 'POST', '--header', 'Content-Type: application/octet-stream', '--input', str(ROOT / 'assets' / name)], timeout=180))
    assert uploaded['name'] == name and uploaded['size'] == len(data) and uploaded['digest'] == 'sha256:' + sha(data)
    actual = download(f'releases/assets/{uploaded["id"]}')
    assert len(actual) == len(data) and sha(actual) == sha(data)
current = api('releases/' + str(ident))
expected = {name: (len(data), 'sha256:' + sha(data)) for name, data in assets.items()}
assert {a['name']: (a['size'], a['digest']) for a in current['assets']} == expected
assert api('git/ref/tags/' + TAG)['object']['sha'] == source
assert api('git/ref/heads/' + BRANCH)['object']['sha'] == source
api('git/refs/heads/main', 'PATCH', {'sha': source, 'force': False})
assert api('git/ref/heads/main')['object']['sha'] == source
api('releases/' + str(ident), 'PATCH', {'draft': False, 'prerelease': True, 'make_latest': 'false'})
public = api('releases/tags/' + TAG)
assert public['id'] == ident and not public['draft'] and public['prerelease'] and public['published_at']
assert {a['name']: (a['size'], a['digest']) for a in public['assets']} == expected
receipt = {'source_commit': source, 'main_commit': api('git/ref/heads/main')['object']['sha'], 'verification_run': run_id, 'release_id': ident, 'tag': TAG, 'url': public['html_url'], 'draft': public['draft'], 'prerelease': public['prerelease'], 'assets': [{k: a[k] for k in ('name', 'size', 'digest', 'browser_download_url')} for a in public['assets']]}
save(ROOT / 'publication-receipt.json', (json.dumps(receipt, indent=2) + '\n').encode())
print(json.dumps(receipt, indent=2))
