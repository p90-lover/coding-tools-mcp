"""Adapt only test paths/identity expectations after the verified source split.
Original test files are retained under Trash before modification. No runtime,
browser, Responses, compaction, broker, or installer implementation is changed.
"""
from pathlib import Path
import os, shutil, subprocess

run_id=os.environ.get('GITHUB_RUN_ID','local')
backup_root=Path('Trash/electron-parity-tests')/run_id
changed=[]

def save(name,text):
    path=Path(name)
    original=path.read_text(encoding='utf-8')
    if text==original:return
    backup=backup_root/path
    backup.parent.mkdir(parents=True,exist_ok=True)
    if name not in changed:
        assert not backup.exists() and not path.is_symlink(),name
        shutil.copy2(path,backup);changed.append(name)
    path.write_text(text,encoding='utf-8')

def once(name,old,new):
    path=Path(name);text=path.read_text(encoding='utf-8')
    if new in text:return
    assert text.count(old)==1,(name,old[:100],text.count(old))
    save(name,text.replace(old,new,1))

# Browser helper is owned by the exact runtime-web source after the monorepo split.
once('desktop-electron/tests/browser-host.test.cjs',
     'resolve(__dirname, "../../src/launcher-browser-host.ts")',
     'resolve(__dirname, "../../runtime-web/src/launcher-browser-host.ts")')

# Localized upstream documents/components remain under runtime-web.
once('desktop-electron/tests/localization.test.cjs',
     'const repositoryRoot = path.resolve(launcherRoot, "..");\nconst read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");',
     'const repositoryRoot = path.resolve(launcherRoot, "..");\nconst runtimeRoot = path.join(repositoryRoot, "runtime-web");\nconst read = (...parts) => fs.readFileSync(path.join(runtimeRoot, ...parts), "utf8");')

# Packaging tests continue to inspect all pinned upstream scripts/workflows from
# runtime-web, while the adapted desktop manifest has the Coding Tools identity.
name='desktop-electron/tests/packaging-contract.test.cjs'
text=Path(name).read_text(encoding='utf-8')
old='''const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const repositoryManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));'''
new='''const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const runtimeRoot = path.join(repositoryRoot, "runtime-web");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const upstreamManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "launcher", "package.json"), "utf8"));
const repositoryManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"));'''
assert text.count(old)==1
text=text.replace(old,new,1)
text=text.replace('path.join(repositoryRoot, ', 'path.join(runtimeRoot, ')
# The broad path replacement above must not rewrite runtimeRoot's own base.
text=text.replace('const runtimeRoot = path.join(runtimeRoot, "runtime-web");',
                  'const runtimeRoot = path.join(repositoryRoot, "runtime-web");')
text=text.replace('assert.equal(manifest.build.appId, "dev.codexwebgpt.launcher");',
                  'assert.equal(manifest.build.appId, "dev.codingtools.fullharness");')
text=text.replace('assert.equal(manifest.build.artifactName, "codex-web-gpt-${version}-${os}-${arch}.${ext}");',
                  'assert.equal(manifest.build.artifactName, "Coding.Tools_${version}_${os}_${arch}.${ext}");')
text=text.replace('`HKCU:\\\\Software\\\\${manifest.build.nsis.guid}`',
                  '`HKCU:\\\\Software\\\\${upstreamManifest.build.nsis.guid}`')
text=text.replace('`Join-Path $InstallLocation "${manifest.build.productName}.exe"`',
                  '`Join-Path $InstallLocation "${upstreamManifest.build.productName}.exe"`')
save(name,text)

# Any v5-era "Codex Native2" persisted config is now intentionally legacy.
# Current-runtime fixtures must use the new public ABI; explicit legacy tests stay.
name='desktop-electron/tests/runtime-host.test.cjs'
text=Path(name).read_text(encoding='utf-8')
text=text.replace('appName: "Codex Native2"', 'appName: CURRENT_CONNECTOR_NAME')
text=text.replace('assert.equal(full.host.mcpConnectorName(), "Codex Native2");',
                  'assert.equal(full.host.mcpConnectorName(), CURRENT_CONNECTOR_NAME);')
text=text.replace('assert.equal(full.host.browserConnectorName(), "Codex Native2");',
                  'assert.equal(full.host.browserConnectorName(), CURRENT_CONNECTOR_NAME);')
text=text.replace('assert.equal(legacyFull.host.browserConnectorName(), "Codex Native2");',
                  'assert.equal(legacyFull.host.browserConnectorName(), CURRENT_CONNECTOR_NAME);')
text=text.replace('/still targets legacy ChatGPT connector.*create that connector as a new ChatGPT plugin/',
                  '/legacy ChatGPT connector.*Coding Tools Native2.*new ChatGPT app/')
text=text.replace('assert.equal(browserOnly.host.browserConnectorName(), "Codex Native2");',
                  'assert.equal(browserOnly.host.browserConnectorName(), CURRENT_CONNECTOR_NAME);')
save(name,text)

subprocess.run(['git','add','--',*changed],check=True)
if backup_root.exists():subprocess.run(['git','add','--',str(backup_root)],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('ELECTRON_PARITY_TEST_REPAIR:',','.join(changed))
