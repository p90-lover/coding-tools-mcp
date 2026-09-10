"""Real Chromium popup/CSP/cookie navigation, replaying recorded production responses.
No external connection is allowed, no real account/cookies are loaded, no screenshots.
"""
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import sync_playwright,expect
import json,os,re,shutil
fixture=json.loads(Path('aiTemp/browser-fixture/browser-fixture.json').read_text(encoding='utf-8'))
assert fixture['source']==os.environ['SOURCE'] and fixture['redirect_status']==303
assert 'https://chatgpt.com' in fixture['csp'] and 'form-action' in fixture['csp']
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=shutil.which('google-chrome'),headless=True,args=['--no-sandbox'])
    for case in ['old_policy','fixed_policy','wrong_destination']:
        context=browser.new_context();calls=[];errors=[]
        csp=re.sub(r"form-action 'self' https://chatgpt\.com", "form-action 'self'", fixture['csp']) if case=='old_policy' else fixture['csp']
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
                    assert form['password']==[fixture['password']] and form['state']==['popup-state-unchanged']
                    cookie=fixture['set_cookie'].split(';',1)[0]
                    assert cookie in request.all_headers().get('cookie','')
                    assert request.all_headers().get('origin')=='https://old-popup.example'
                    calls.append({'method':'POST','target':'authorization_form','query_preserved':True,'consent_cookie_present':True})
                    route.fulfill(status=fixture['redirect_status'],headers={'Location':callback,'Cache-Control':'no-store'},body='');return
            if request.url==callback:
                calls.append({'method':request.method,'target':'callback','has_post_body':request.post_data is not None})
                route.fulfill(status=200,content_type='text/html',body='CALLBACK_REACHED');return
            route.abort('blockedbyclient')
        context.route('**/*',route_handler)
        opener=context.new_page();opener.goto('https://chatgpt.com/test-initiator')
        with opener.expect_popup() as created:
            opener.get_by_role('button',name='Connect',exact=True).click()
        popup=created.value
        popup.on('console',lambda msg:errors.append(msg.text) if msg.type=='error' else None)
        expect(popup.get_by_role('heading',name='Authorize Coding Tools MCP')).to_be_visible()
        popup.get_by_label('Password',exact=True).fill(fixture['password'])
        popup.get_by_role('button',name='Authorize',exact=True).click()
        if case=='fixed_policy':
            expect(popup.get_by_text('CALLBACK_REACHED',exact=True)).to_be_visible()
            assert any(c['target']=='callback' and c['method']=='GET' and not c['has_post_body'] for c in calls)
            assert not errors,errors
        else:
            # Wait for the browser to emit an actual policy violation, not a guessed delay.
            for _ in range(30):
                if any('form-action' in e for e in errors):break
                popup.wait_for_timeout(100)
            assert any('form-action' in e for e in errors),errors
            assert not any(c['target']=='callback' for c in calls),calls
        assert any(c['target']=='authorization_form' for c in calls)
        results.append({'case':case,'callback_reached':any(c['target']=='callback' for c in calls),'requests':calls,'policy_violation':any('form-action' in e for e in errors)})
        context.close()
    version=browser.version;browser.close()
proof={'source':fixture['source'],'browser':version,'passed':True,'cases':results,'live_chatgpt_account':False,
    'transport':fixture['transport'],'model_requests':0,'screenshots_written':0}
Path('aiTemp/evidence/browser-csp.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
print('PASS: real popup, consent cookie, validated callback GET without password, old-policy failure and unrelated-target denial')
