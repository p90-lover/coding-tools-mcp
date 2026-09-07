"""Reconstruct reviewed source without executing archived repository code."""
from __future__ import annotations
import hashlib
import io
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
import tomllib
import zipfile

ROOT = Path.cwd().resolve()
MAIN = '4053eb2a8ea1821fa184886066c82d42f20d09a6'
HEAD = 'f75d4f68f40bcae2a68db2c2bd45b3ff5b6d585d'
BASE = '02104436f7b45b07157945331449cb0f5c326f81'
HEAD_TREE = '8ce5cca3169ed6eca8a737cb06da08fd05d2c5af'
VERIFIED_TREE = '232a562cad58cfb6602028ce13044dff3591acc3'
ZIP_SHA256 = '330a4a95c527ab7986602a7c169d46f995d0419627cc84fbff72a0e8d2a3562f'
PATCH_SHA256 = 'a0db05610a40114e4dbd91e2baf3bd7d4ed93ae4bb1489b444aa43d2c6a6d850'
STAGE = ROOT / 'aiTemp/release-v0.3.2/stage' / str(time.time_ns())
BACKUP = ROOT / 'aiTemp/Trash/release-v0.3.2' / str(time.time_ns())


def git(*args: str, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'gc.auto=0', *args], cwd=cwd, check=check, capture_output=True)


def write(relative: str, content: bytes) -> None:
    path = ROOT / relative
    path.resolve().relative_to(ROOT)
    if path.is_symlink():
        raise RuntimeError(f'refusing symlink {relative}')
    if path.exists():
        if path.read_bytes() == content:
            return
        backup = BACKUP / str(time.time_ns()) / relative
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def append(relative: str, text: str) -> None:
    write(relative, (ROOT / relative).read_bytes() + text.encode())


if git('merge-base', MAIN, HEAD).stdout.decode().strip() != BASE:
    raise RuntimeError('reviewed merge base changed')
archive = ROOT / 'aiTemp/release-v0.3.2/verified-source.zip'
if hashlib.sha256(archive.read_bytes()).hexdigest() != ZIP_SHA256:
    raise RuntimeError('verified artifact digest mismatch')
with zipfile.ZipFile(archive) as z:
    if set(z.namelist()) != {'tree-sha.txt', 'base-sha.txt', 'source-stat.txt', 'verified-source.patch', 'patch.sha256'}:
        raise RuntimeError('unexpected verified artifact contents')
    patch = z.read('verified-source.patch')
    if z.read('base-sha.txt').decode().strip() != HEAD or z.read('tree-sha.txt').decode().strip() != VERIFIED_TREE:
        raise RuntimeError('artifact source identity mismatch')
    if hashlib.sha256(patch).hexdigest() != PATCH_SHA256:
        raise RuntimeError('reviewed patch digest mismatch')
STAGE.mkdir(parents=True)
for name, ref in [('main', MAIN), ('head', HEAD), ('base', BASE)]:
    target = STAGE / name
    target.mkdir()
    tar_bytes = git('archive', '--format=tar', ref).stdout
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tar:
        tar.extractall(target, filter='data')
head = STAGE / 'head'
git('init', '-q', cwd=head)
git('add', '-f', '--', '.', cwd=head)
if git('write-tree', cwd=head).stdout.decode().strip() != HEAD_TREE:
    raise RuntimeError('head snapshot tree mismatch')
patch_file = STAGE / 'verified.patch'
patch_file.write_bytes(patch)
git('apply', '--check', '--index', str(patch_file), cwd=head)
git('apply', '--index', str(patch_file), cwd=head)
if git('write-tree', cwd=head).stdout.decode().strip() != VERIFIED_TREE:
    raise RuntimeError('materialized source does not match the tested tree')

version_paths = {'package-lock.json', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'}
changed = []
for source in sorted(head.rglob('*')):
    if not source.is_file():
        continue
    rel = source.relative_to(head).as_posix()
    if not (rel.startswith(('src/', 'src-tauri/', 'tests/')) or rel in {'package.json', 'package-lock.json'}):
        continue
    if source.is_symlink():
        raise RuntimeError(f'unexpected source symlink {rel}')
    base = STAGE / 'base' / rel
    main = STAGE / 'main' / rel
    ours = main.read_bytes() if main.exists() else None
    common = base.read_bytes() if base.exists() else None
    theirs = source.read_bytes()
    if theirs == common or theirs == ours:
        continue
    if ours == common:
        result = theirs
    elif common is None:
        raise RuntimeError(f'unreviewed add/add conflict: {rel}')
    else:
        merged = git('merge-file', '-p', str(main), str(base), str(source), check=False)
        result = merged.stdout
        if merged.returncode:
            if not 1 <= merged.returncode < 128 or rel not in version_paths:
                raise RuntimeError(f'unreviewed source merge conflict: {rel}')
            text = result.decode('utf-8')
            pattern = r'<<<<<<< [^\n]+\n(.*?)=======\n(.*?)>>>>>>> [^\n]+\n'
            matches = list(re.finditer(pattern, text, re.S))
            if not matches or len(matches) != merged.returncode:
                raise RuntimeError(f'unknown version conflict: {rel}')
            for match in matches:
                if match[1].replace('0.3.1', 'VERSION') != match[2].replace('0.3.0-rc1', 'VERSION'):
                    raise RuntimeError(f'non-version conflict: {rel}')
            result = re.sub(pattern, lambda m: m[1].replace('0.3.1', '0.3.2'), text, flags=re.S).encode()
    write(rel, result)
    changed.append(rel)
print(f'Materialized {len(changed)} reviewed production/dependency/test files; preserved newer main-only changes.')

append('src-tauri/src/auth/oauth_flow.rs', r'''
#[cfg(test)]
mod release_finalization_regressions {
    use super::*;
    #[test]
    fn release_finalization_browser_consent_sets_cookie() {
        let oauth = OAuthRuntime::new("consent-test".into(), "client".into(), None,
            "test-password-long-enough".into(), "test-signing-key-with-more-than-32-bytes".into());
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(b"dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo"));
        let response = authorize_get(&oauth, AuthorizeParams {
            response_type: "code".into(), client_id: "client".into(),
            redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect".into(),
            code_challenge: challenge, code_challenge_method: "S256".into(), state: "state".into(),
        }, None);
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().contains_key("set-cookie"), "browser consent must be bound to an HttpOnly cookie");
    }
}
''')
append('src-tauri/src/auth/oauth.rs', r'''
#[cfg(test)]
mod release_finalization_regressions {
    use super::*;
    #[test]
    fn release_finalization_forwarded_headers_cannot_choose_issuer() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-host", "attacker.invalid".parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("host", "attacker.invalid".parse().unwrap());
        assert_eq!(external_base_url(&headers, 28767, ""), "http://127.0.0.1:28767");
        assert_eq!(external_base_url(&headers, 28767, "https://trusted.example"), "https://trusted.example");
    }
}
''')
append('src-tauri/src/data/store.rs', r'''
#[cfg(test)]
mod release_finalization_regressions {
    use super::*;
    #[test]
    fn release_finalization_desktop_save_preserves_background_credentials() {
        let key = format!("release-regression-{}", uuid::Uuid::new_v4());
        let mut desktop = DataStore::load().expect("desktop snapshot");
        DataStore::update_file(|data| {
            data.shared_secrets.insert(key.clone(), "newly-rotated-secret".into());
            Ok(())
        }).expect("background rotation");
        desktop.update_settings(desktop.settings()).expect("desktop settings save");
        let actual = DataStore::read_file(|data| Ok(data.shared_secrets.get(&key).cloned())).unwrap();
        assert_eq!(actual.as_deref(), Some("newly-rotated-secret"));
    }
}
''')
print('Materialized three targeted release regressions.')

# RustCrypto 0.10.2 fixes SSE4.1 instructions used in the SSE2 backend.
# Verify that this targeted update changes no unrelated locked package.
lock_path = ROOT / 'src-tauri/Cargo.lock'
before = tomllib.loads(lock_path.read_text())
saved = BACKUP / 'chacha-review/Cargo.lock'
saved.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(lock_path, saved)
subprocess.run(['cargo', 'update', '--manifest-path', 'src-tauri/Cargo.toml', '-p', 'chacha20', '--precise', '0.10.2'], cwd=ROOT, check=True)
after = tomllib.loads(lock_path.read_text())
old_packages = [p for p in before['package'] if p['name'] != 'chacha20']
new_packages = [p for p in after['package'] if p['name'] != 'chacha20']
if old_packages != new_packages:
    raise RuntimeError('targeted ChaCha20 update unexpectedly changed another dependency')
versions = [p['version'] for p in after['package'] if p['name'] == 'chacha20']
if versions != ['0.10.2']:
    raise RuntimeError(f'unexpected ChaCha20 versions: {versions}')
print('Updated only ChaCha20 to reviewed non-yanked 0.10.2; original lockfile preserved.')
