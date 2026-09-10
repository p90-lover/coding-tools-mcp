"""Reuse actual NSIS inspection; add the OAuth-specific exact-source evidence."""
from pathlib import Path
import json,os,runpy
root=Path('aiTemp/evidence')
assert '4 passed; 0 failed' in (root/'oauth-tests.txt').read_text(encoding='utf-8')
assert 'PASS: actual OAuth entry, consent cookie/state, PKCE token exchange, one-use code, authenticated 70-tool catalog and trusted origin rotation without restart' in (root/'oauth-tests.txt').read_text(encoding='utf-8')
# The previous checker retains the pinned command digest and checks actual bundled bytes/licenses.
runpy.run_path('aiTemp/tool-exposure/package.py',run_name='__main__')
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({'scope':'scoped OAuth popup origin acceptance; no untrusted Host origin trust',
    'oauth_regressions_passed':4,'live_user_chatgpt_connection_verified':False,
    'codex_executable_invoked':False,'model_requests':0})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('PASS: scoped OAuth entry and real consent-to-catalog path, exact packaged executable and retained command digest')
