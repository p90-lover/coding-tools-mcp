"""Inspect real installers; the unverified command sandbox must not be present."""
import hashlib, json, os, plistlib, shutil, subprocess
from pathlib import Path


def verify_nsis_binary(compiled: bytes, packaged: bytes) -> dict:
    """Accept only Tauri 2.11.4's exact UNK -> NSS bundle marker replacement.

    Source: tauri-apps/tauri tag tauri-cli-v2.11.4,
    crates/tauri-bundler/src/bundle.rs, patch_binary/bundle_project.
    The bundler restores the original build executable after making the NSIS
    package. Do not compare raw hashes, normalize other fields, or allow signing
    differences: this release's Windows binary is publisher-unsigned.
    """
    original = b'__TAURI_BUNDLE_TYPE_VAR_UNK'
    replacement = b'__TAURI_BUNDLE_TYPE_VAR_NSS'
    assert len(compiled) == len(packaged), 'Packaged executable size changed'
    assert compiled.startswith(b'MZ') and packaged.startswith(b'MZ'), 'Expected Windows executables'
    assert compiled.count(original) == 1, 'Missing or ambiguous original bundle marker'
    assert compiled.count(replacement) == 0, 'Build binary was already patched'
    offset = compiled.index(original)
    expected = compiled[:offset] + replacement + compiled[offset + len(original):]
    assert packaged == expected, 'Packaged executable differs beyond the documented Tauri NSIS marker'
    return {'method':'tauri_2_11_4_exact_nsis_marker_only','marker_offset':offset,
            'compiled_sha256':hashlib.sha256(compiled).hexdigest(),
            'packaged_sha256':hashlib.sha256(packaged).hexdigest(),
            'all_other_bytes_identical':True}


version=os.environ['VERSION']; source=os.environ['SOURCE']; platform=os.environ['PLATFORM']
assert 'CODING_TOOLS_SANDBOX_MANIFEST_SHA256' not in os.environ
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==source
subprocess.run(['git','diff','--exit-code','--','package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json'],check=True)
target=Path(os.environ['CARGO_TARGET_DIR'])/'release'; windows=platform=='windows-x64'
assets=list(target.glob('bundle/nsis/*.exe' if windows else 'bundle/dmg/*.dmg'))
assert len(assets)==1 and assets[0].stat().st_size>100000
binaries=[target/'coding-tools-mcp-desktop.exe'] if windows else list(target.glob('bundle/macos/*.app/Contents/MacOS/coding-tools-mcp-desktop'))
assert len(binaries)==1 and binaries[0].is_file()
expected='coding-tools-mcp-desktop '+version
actual=subprocess.run([str(binaries[0]),'--version'],capture_output=True,text=True,check=True,timeout=20).stdout.strip()
assert actual==expected
forbidden={'coding-tools-codex-sandbox.exe','codex-command-runner.exe','codex-windows-sandbox-setup.exe'}
if windows:
    lock=json.loads(Path('package-lock.json').read_text(encoding='utf-8'))
    assert lock['packages']['node_modules/@tauri-apps/cli']['version']=='2.11.4', 'Re-review packaging identity when Tauri changes'
    extract=Path('aiTemp/core-installer-inspection');extract.mkdir(exist_ok=False)
    subprocess.run(['7z','x',str(assets[0]),'-o'+str(extract.resolve()),'-y'],check=True,stdout=subprocess.DEVNULL)
    names={p.name.lower() for p in extract.rglob('*') if p.is_file()}
    assert not names & forbidden
    assert not any(p.name=='native-sandbox' for p in extract.rglob('*'))
    found=list(extract.rglob('coding-tools-mcp-desktop.exe'));assert len(found)==1
    binary_verification=verify_nsis_binary(binaries[0].read_bytes(),found[0].read_bytes())
    bundled_version=subprocess.run([str(found[0].resolve()),'--version'],capture_output=True,text=True,check=True,timeout=20).stdout.strip()
    assert bundled_version==expected, 'Actual packaged executable reports a different version'
else:
    info=plistlib.loads(subprocess.check_output(['hdiutil','attach','-readonly','-nobrowse','-plist',str(assets[0])]))
    mounts=[Path(e['mount-point']) for e in info['system-entities'] if 'mount-point' in e];assert len(mounts)==1
    try:
        apps=list(mounts[0].glob('*.app/Contents/MacOS/coding-tools-mcp-desktop'));assert len(apps)==1
        assert subprocess.run([str(apps[0]),'--version'],capture_output=True,text=True,check=True,timeout=20).stdout.strip()==expected
        build_hash=hashlib.sha256(binaries[0].read_bytes()).hexdigest()
        package_hash=hashlib.sha256(apps[0].read_bytes()).hexdigest()
        assert package_hash==build_hash
        assert not any(p.name.lower() in forbidden for p in apps[0].parents[1].rglob('*'))
        binary_verification={'method':'exact_macos_app_bytes','compiled_sha256':build_hash,'packaged_sha256':package_hash,'all_bytes_identical':True}
    finally:subprocess.run(['hdiutil','detach',str(mounts[0])],check=True)
name='Coding.Tools.MCP_'+version+('_x64-setup.exe' if windows else '_aarch64.dmg')
dest=Path('aiTemp/installer')/name;dest.parent.mkdir(parents=True,exist_ok=True);assert not dest.exists()
shutil.copy2(assets[0],dest)
proof={'source_commit':source,'version':version,'platform':platform,'asset':name,'size':dest.stat().st_size,
       'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'screenshot_storage':'memory_only',
       'native_fixture_verified':windows,'native_sandbox_verified':False,'native_sandbox_bundled':False,
       'native_sandbox_status':'withheld_pending_native_verification','user_chatgpt_connection_verified':False,
       'codex_agent_invoked':False,'publisher_signed':False,'binary_verification':binary_verification}
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory).mkdir(parents=True,exist_ok=True)
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
Path('aiTemp/evidence/binary-version.txt').write_text(actual+'\n',encoding='utf-8')
Path('aiTemp/evidence/packaged-binary-identity.json').write_text(json.dumps(binary_verification,indent=2)+'\n',encoding='utf-8')
print('PASS: actual executable/installer, exact documented bundle marker, version, and absence of unverified command helpers')
