"""Inspect actual NSIS contents and bind live-browser regression evidence to source."""
from pathlib import Path
import json,os,runpy
root=Path('aiTemp/evidence')
assert '5 passed; 0 failed' in (root/'oauth-tests.txt').read_text(encoding='utf-8')
assert 'PASS: real browser Origin through real Rust guard, manual and extension consent, PKCE/token/catalog, null-origin denial' in (root/'oauth-tests.txt').read_text(encoding='utf-8')
browser=json.loads((root/'browser-live.json').read_text())
assert browser['source']==os.environ['SOURCE'] and browser['passed']
assert browser['forged_origin_denied'] and browser['ordinary_referrer_policy']=='no-referrer'
assert browser['external_browser_network_blocked'] and not browser['live_account'] and browser['model_requests']==0
assert [row['case'] for row in browser['cases']]==['manual','extension','old_no_referrer']
for row in browser['cases']:
    assert row['all_response_headers_forwarded']
    if row['case']=='old_no_referrer':
        assert row['post']['origin']=='null' and row['post']['status']==403 and row['post']['guard_rejection']
    else:
        assert row['post']['origin']=='https://old-popup.example' and row['post']['status']==303
        assert row['actual_token_and_catalog_verified'] and row['callback_get_without_body']
fixture=json.loads(Path('aiTemp/oauth-popup/browser-fixture.json').read_text())
assert fixture['source']==os.environ['SOURCE'] and fixture['response_headers']['referrer-policy']=='strict-origin'
runpy.run_path('aiTemp/tool-exposure/package.py',run_name='__main__')
proof=json.loads(Path('aiTemp/installer/proof.json').read_text())
proof.update({'scope':'validated OAuth form referrer policy; real browser-generated Origin checked by live Rust guard',
    'oauth_regressions_passed':5,'browser_origin_cases_passed':3,'form_referrer_policy':'strict-origin',
    'null_origin_still_denied':True,'extension_source':'b0d4db553227fa3c7300050b8edff6e2eb9afee4',
    'extension_version':'0.0.7','extension_ipc_synthetic':True,'browser':browser,
    'live_user_chatgpt_connection_verified':False,'model_requests':0,'codex_executable_invoked':False})
for directory in ['aiTemp/installer','aiTemp/evidence']:
    Path(directory,'proof.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('PASS: rc5 installer matches source and actual manual/extension browser authorization passes the real server origin guard')
