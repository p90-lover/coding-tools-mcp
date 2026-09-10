"""Reuse actual NSIS inspection; add OAuth-specific exact-source evidence."""
from pathlib import Path
import json,os,runpy
root=Path('aiTemp/evidence')
assert '4 passed; 0 failed' in (root/'oauth-tests.txt').read_text(encoding='utf-8')
assert 'PASS: actual OAuth entry, consent cookie/state, PKCE token exchange, one-use code, authenticated 70-tool catalog and trusted origin rotation without restart' in (root/'oauth-tests.txt').read_text(encoding='utf-8')
fixture=json.loads(Path('aiTemp/oauth-popup/browser-fixture.json').read_text(encoding='utf-8'))
assert fixture['source']==os.environ['SOURCE'] and "form-action 'self' https://chatgpt.com;" in fixture['csp']
runpy.run_path('aiTemp/tool-exposure/package.py',run_name='__main__')
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({'scope':'scoped OAuth entry and validated callback CSP; no caller-selected Host trust',
    'oauth_regressions_passed':4,'validated_callback_csp':True,'live_user_chatgpt_connection_verified':False,
    'codex_executable_invoked':False,'model_requests':0})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('PASS: OAuth entry and real consent-to-catalog path, validated callback CSP, exact packaged executable and retained command digest')
