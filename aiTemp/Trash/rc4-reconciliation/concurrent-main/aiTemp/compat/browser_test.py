"""Production HTML/headers and exact extension helper; intercepted transport, synthetic Chrome IPC."""
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import sync_playwright,expect
import hashlib,json,os,re,shutil,subprocess,zipfile
EXT='b0d4db553227fa3c7300050b8edff6e2eb9afee4'
source=Path(os.environ['EXTENSION_SOURCE_DIR']).resolve()
assert subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()==EXT
fixture=json.loads(Path('aiTemp/browser-fixture/browser-fixture.json').read_text(encoding='utf-8'))
assert fixture['source']==os.environ['SOURCE'] and fixture['redirect_status']==303
assert 'https://chatgpt.com' in fixture['csp'] and 'form-action' in fixture['csp']
helper=(source/'oauth-content.js').read_text(encoding='utf-8')
assert json.loads((source/'manifest.json').read_text())['version']=='0.0.7'
# The values are serialized by the real Rust AppData/WorkspaceProfile types in the actual Windows test.
node_contract="""
import fs from 'node:fs'; import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {selectWorkspaceSnapshot}=await import(pathToFileURL(process.env.EXTENSION_SOURCE_DIR+'/lib.mjs'));
const fixture=JSON.parse(fs.readFileSync('aiTemp/browser-fixture/browser-fixture.json','utf8'));
const own=selectWorkspaceSnapshot(fixture.profiles_fixture).selected;
assert.equal(own.id,'extension-fixture'); assert.equal(own.authType,'oauth');
assert.equal(own.publicUrl,'https://old-popup.example/mcp');
assert.equal(own.oauthClientId,'popup-fixture-client');
assert.equal(own.oauthPassword,'fixture-password-not-real');
assert.equal(own.oauthClientSecret,'fixture-secret-not-real');
assert.equal(own.oauthAuthorizeUrl,'https://old-popup.example/oauth/authorize');
assert.equal(own.oauthTokenUrl,'https://old-popup.example/oauth/token');
const shared=selectWorkspaceSnapshot(fixture.shared_profiles_fixture).selected;
assert.equal(shared.oauthClientId,'fixture-shared-client');
assert.equal(shared.oauthPassword,'fixture-shared-password');
assert.equal(shared.oauthClientSecret,'fixture-shared-secret');
console.log('PASS: actual Rust Desktop settings serialize into the pinned extension workspace/shared OAuth contract');
"""
subprocess.run(['node','--input-type=module','-e',node_contract],check=True)
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=shutil.which('google-chrome'),headless=True,args=['--no-sandbox'])
    for case in ['old_policy','fixed_policy','wrong_destination']:
        context=browser.new_context();calls=[];errors=[];messages=[]
        csp=re.sub(r"form-action 'self' https://chatgpt\.com", "form-action 'self'",fixture['csp']) if case=='old_policy' else fixture['csp']
        callback=fixture['callback_url'] if case!='wrong_destination' else 'https://attacker.invalid/callback?code=synthetic'
        def route_handler(route):
            request=route.request;parts=urlsplit(request.url)
            if parts.path=='/favicon.ico':route.fulfill(status=204);return
            if request.url=='https://chatgpt.com/test-initiator':
                url=json.dumps(fixture['authorize_url'])
                route.fulfill(status=200,content_type='text/html',body=f'<button id="connect">Connect</button><script>document.getElementById("connect").onclick=()=>window.open({url},"oauth","popup=yes,width=560,height=720");</script>');return
            if parts.netloc=='old-popup.example' and parts.path=='/oauth/authorize':
                if request.method=='GET':
                    assert request.url==fixture['authorize_url']
                    route.fulfill(status=200,headers={'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp,'Set-Cookie':fixture['set_cookie'],'Cache-Control':'no-store'},body=fixture['html']);return
                if request.method=='POST':
                    form=parse_qs(request.post_data or '')
                    query=parse_qs(urlsplit(fixture['authorize_url']).query)
                    for name in ['client_id','redirect_uri','state','code_challenge','code_challenge_method']:
                        assert form[name]==query[name],name
                    assert form['password']==[fixture['password']] and len(form['consent_nonce'])==1 and form['consent_nonce'][0]
                    cookie=fixture['set_cookie'].split(';',1)[0]
                    assert cookie in request.all_headers().get('cookie','')
                    assert request.all_headers().get('origin')=='https://old-popup.example'
                    calls.append({'method':'POST','target':'authorization_form','query_preserved':True,'consent_cookie_present':True,'nonce_pkce_preserved':True})
                    route.fulfill(status=fixture['redirect_status'],headers={'Location':callback,'Cache-Control':'no-store'},body='');return
            if request.url==callback:
                calls.append({'method':request.method,'target':'callback','has_post_body':request.post_data is not None})
                route.fulfill(status=200,content_type='text/html',body='CALLBACK_REACHED');return
            route.abort('blockedbyclient')
        context.route('**/*',route_handler)
        opener=context.new_page();opener.goto('https://chatgpt.com/test-initiator')
        with opener.expect_popup() as created:opener.get_by_role('button',name='Connect',exact=True).click()
        popup=created.value
        popup.on('console',lambda msg:errors.append(msg.text) if msg.type=='error' else None)
        expect(popup.get_by_role('heading',name='Authorize Coding Tools MCP')).to_be_visible()
        if case=='fixed_policy':
            def synthetic_chrome(message):
                assert message['url']==fixture['authorize_url']
                assert message['type'] in ['OAUTH_PAGE_READY','OAUTH_SUBMITTED']
                messages.append(message['type'])
                return {'ok':True,'password':fixture['password']} if message['type']=='OAUTH_PAGE_READY' else {'ok':True}
            popup.expose_function('__syntheticChromeSend',synthetic_chrome)
            popup.evaluate('globalThis.chrome={runtime:{sendMessage:message=>globalThis.__syntheticChromeSend(message)}}')
            popup.evaluate(helper)
            expect(popup.get_by_text('CALLBACK_REACHED',exact=True)).to_be_visible()
            assert messages==['OAUTH_PAGE_READY','OAUTH_SUBMITTED'],messages
            assert any(c['target']=='callback' and c['method']=='GET' and not c['has_post_body'] for c in calls)
            assert not errors,errors
        else:
            popup.get_by_label('Password',exact=True).fill(fixture['password'])
            popup.get_by_role('button',name='Authorize',exact=True).click()
            for _ in range(30):
                if any('form-action' in e for e in errors):break
                popup.wait_for_timeout(100)
            assert any('form-action' in e for e in errors),errors
            assert not any(c['target']=='callback' for c in calls),calls
        assert any(c['target']=='authorization_form' for c in calls)
        results.append({'case':case,'callback_reached':any(c['target']=='callback' for c in calls),'requests':calls,'policy_violation':any('form-action' in e for e in errors),'extension_helper':case=='fixed_policy'})
        context.close()
    version=browser.version;browser.close()
proof={'source':fixture['source'],'browser':version,'passed':True,'cases':results,'live_chatgpt_account':False,
    'transport':fixture['transport'],'model_requests':0,'screenshots_written':0,'extension_source':EXT,
    'extension_helper_replayed':True,'profile_contract_checked':True,
    'sender_boundary':'synthetic Chrome runtime; production helper and worker code'}
Path('aiTemp/evidence/browser-csp.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('PASS: production Desktop form and settings, pinned extension helper, popup cookie/PKCE, callback GET, old-policy and unrelated-target denial')
focused=Path('aiTemp/evidence/extension-focused.txt').read_text()
assert '# pass 4' in focused and '# fail 0' in focused
out=Path('aiTemp/extension-package');out.mkdir(parents=True,exist_ok=False)
files=[p for p in sorted(source.iterdir()) if p.is_file() and p.suffix in {'.js','.mjs','.html','.css','.json'}]
assert all(not p.is_symlink() and p.stat().st_size<2*1024*1024 for p in files)
assert {'manifest.json','background.js','content.js','oauth-content.js','lib.mjs','popup.html','offscreen.html'} <= {p.name for p in files}
asset=out/'coding-tools-mcp-extension-v0.0.7.zip'
with zipfile.ZipFile(asset,'x',zipfile.ZIP_DEFLATED) as z:
    for file in files:z.write(file,file.name)
    for name in ['README.md','RELEASE_NOTES.md']:z.write(source/name,name)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
extproof={'source_commit':EXT,'version':'0.0.7','desktop_source':fixture['source'],'workflow_run':int(os.environ['GITHUB_RUN_ID']),
    'focused_groups_passed':4,'profile_contract_checked':True,'actual_form_replay_passed':True,'model_requests':0,
    'live_account_verified':False,'sha256':sha(asset),'size':asset.stat().st_size,'files':{p.name:sha(p) for p in files}}
(out/'extension-proof.json').write_text(json.dumps(extproof,indent=2)+'\n')
Path('aiTemp/evidence/extension-proof.json').write_text(json.dumps(extproof,indent=2)+'\n')
print('PASS: packaged exact verified extension source '+EXT)
