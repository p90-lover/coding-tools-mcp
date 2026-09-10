"""Reuse actual NSIS inspection; add OAuth-specific exact-source evidence."""
from pathlib import Path
import json, os, runpy, shutil

root = Path('aiTemp/evidence')
log = (root / 'oauth-tests.txt').read_text(encoding='utf-8')
assert '4 passed; 0 failed' in log
assert 'PASS: actual OAuth entry, consent cookie/state, PKCE token exchange, one-use code, authenticated 70-tool catalog and trusted origin rotation without restart' in log

# Cargo runs lib tests in the package directory, not the shell's repository root.
# Preserve the response captured by the real listener test; do not synthesize it
# or search arbitrary locations for a stale fixture from an earlier candidate.
produced = Path('src-tauri/aiTemp/oauth-popup/browser-fixture.json')
fixture = json.loads(produced.read_text(encoding='utf-8'))
assert fixture['source'] == os.environ['SOURCE'], 'Browser fixture belongs to another source commit'
assert "form-action 'self' https://chatgpt.com;" in fixture['csp']
assert fixture['redirect_status'] == 303
exported = Path('aiTemp/oauth-popup/browser-fixture.json')
exported.parent.mkdir(parents=True, exist_ok=True)
if exported.exists():
    assert exported.read_bytes() == produced.read_bytes(), 'Refuse to overwrite an existing different fixture'
else:
    shutil.copy2(produced, exported)
assert exported.read_bytes() == produced.read_bytes()

runpy.run_path('aiTemp/tool-exposure/package.py', run_name='__main__')
proof = json.loads(Path('aiTemp/installer/proof.json').read_text(encoding='utf-8'))
proof.update({'scope': 'scoped OAuth entry and validated callback CSP; no caller-selected Host trust',
    'oauth_regressions_passed': 4, 'validated_callback_csp': True, 'live_user_chatgpt_connection_verified': False,
    'codex_executable_invoked': False, 'model_requests': 0})
for directory in ['aiTemp/installer', 'aiTemp/evidence']:
    Path(directory, 'proof.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
print('PASS: OAuth entry and real consent-to-catalog path, validated callback CSP, exact packaged executable and retained command digest')
