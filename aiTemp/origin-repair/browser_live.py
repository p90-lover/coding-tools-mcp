"""Real Chromium -> real Rust OAuth listener; no live account or external network.
Only transport routing and extension IPC are synthetic. Every application response
header is forwarded, including Referrer-Policy (which prior replay omitted).
"""
from pathlib import Path
from urllib.parse import urlsplit, urlencode, parse_qs
from playwright.sync_api import sync_playwright, expect
import base64, hashlib, http.client, json, os, shutil, sys

local = urlsplit(sys.argv[1])
assert local.scheme == 'http' and local.hostname == '127.0.0.1' and local.port
base = 'https://old-popup.example'
callback_base = 'https://chatgpt.com/connector/oauth/popup_fixture_id'
password = 'fixture-password-not-real'
verifier = 'dBjftJeZ4CVP-mB92Kpru-AEJvkQlLgi3ThpmQ45N_Xyo'
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
query = dict(response_type='code', client_id='popup-fixture-client', redirect_uri=callback_base,
             code_challenge=challenge, code_challenge_method='S256', state='browser-origin-fixture')
authorize = base + '/oauth/authorize?' + urlencode(query)
extension = Path(os.environ['EXTENSION_SOURCE_DIR'])
helper = (extension/'oauth-content.js').read_text(encoding='utf-8')
assert json.loads((extension/'manifest.json').read_text())['version'] == '0.0.7'
evidence = Path('aiTemp/evidence'); evidence.mkdir(parents=True, exist_ok=True)

def request_local(method, path, headers=None, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', local.port, timeout=10)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
    finally:
        connection.close()

chrome = os.environ.get('CHROME_PATH') or shutil.which('google-chrome') or shutil.which('chromium')
if not chrome:
    for name in [r'C:\Program Files\Google\Chrome\Application\chrome.exe',
                 r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe']:
        if Path(name).is_file(): chrome = name; break
assert chrome, 'Chromium executable not found'
rows = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=chrome, headless=True,
        proxy={'server':'http://127.0.0.1:9'}, args=['--no-sandbox','--disable-background-networking'])
    for case in ['manual', 'extension', 'old_no_referrer']:
        context = browser.new_context(service_workers='block')
        posts, callbacks, failures, messages = [], [], [], []
        observed_policy = []
        def handle(route):
            req = route.request; u = urlsplit(req.url)
            if req.url == 'https://chatgpt.com/test-initiator':
                route.fulfill(status=200, content_type='text/html', body='<button id="connect">Connect</button><script>document.querySelector("button").onclick=()=>window.open('+json.dumps(authorize)+',"oauth","popup=yes,width=560,height=720");</script>'); return
            if u.scheme == 'https' and u.netloc == 'old-popup.example' and u.path == '/oauth/authorize':
                headers = dict(req.all_headers())
                headers.pop('content-length', None); headers.pop('connection', None)
                headers['host'] = 'old-popup.example'
                status, reply_headers, body = request_local(req.method, u.path+('?' + u.query if u.query else ''), headers, req.post_data)
                if req.method == 'GET':
                    observed_policy.append(reply_headers.get('referrer-policy'))
                    if case == 'old_no_referrer': reply_headers['referrer-policy'] = 'no-referrer'
                if req.method == 'POST':
                    posts.append({'origin': headers.get('origin'), 'referer': headers.get('referer'),
                        'cookie_present': 'mcp_consent_' in headers.get('cookie',''), 'status':status,
                        'guard_rejection':body.decode(errors='replace') == 'Untrusted request origin'})
                    assert headers.get('referer') in (None, base+'/'), 'OAuth query leaked in Referer'
                # Do not reconstruct a selected subset of security headers.
                route.fulfill(status=status, headers=reply_headers, body=body); return
            if req.url.startswith(callback_base+'?'):
                values = parse_qs(u.query)
                assert u.scheme == 'https' and u.netloc == 'chatgpt.com' and u.path == urlsplit(callback_base).path
                assert req.method == 'GET' and not req.post_data and values['state'] == [query['state']]
                assert len(values.get('code',[])) == 1 and 'password' not in values
                callbacks.append(values['code'][0])
                route.fulfill(status=200, content_type='text/html', body='CALLBACK_REACHED'); return
            route.abort('blockedbyclient')
        context.route('**/*', handle)
        opener = context.new_page(); opener.goto('https://chatgpt.com/test-initiator')
        with opener.expect_popup() as created: opener.get_by_role('button', name='Connect', exact=True).click()
        popup = created.value
        expect(popup.get_by_role('heading', name='Authorize Coding Tools MCP')).to_be_visible()
        context.unroute('**/*', handle)
        cdp = context.new_cdp_session(popup)
        class CdpRequest:
            def __init__(self, data):
                self.url=data['url']; self.method=data['method']; self.post_data=data.get('postData')
                self.headers={k.lower():str(v) for k,v in data['headers'].items()}
            def all_headers(self): return self.headers
        class CdpRoute:
            def __init__(self, event): self.id=event['requestId']; self.request=CdpRequest(event['request'])
            def fulfill(self, status, headers=None, body=b'', content_type=None):
                values=dict(headers or {})
                if content_type: values['content-type']=content_type
                payload=body.encode() if isinstance(body,str) else body
                cdp.send('Fetch.fulfillRequest', {'requestId':self.id, 'responseCode':status,
                    'responseHeaders':[{'name':k,'value':v} for k,v in values.items()],
                    'body':base64.b64encode(payload).decode()})
            def abort(self, *_): cdp.send('Fetch.failRequest', {'requestId':self.id,'errorReason':'BlockedByClient'})
        def paused(event):
            try: handle(CdpRoute(event))
            except Exception as error:
                failures.append(type(error).__name__+': '+str(error))
                cdp.send('Fetch.failRequest', {'requestId':event['requestId'],'errorReason':'BlockedByClient'})
        cdp.on('Fetch.requestPaused', paused)
        cdp.send('Fetch.enable', {'patterns':[{'urlPattern':'*','requestStage':'Request'}]})
        try:
            if case == 'extension':
                def ipc(message):
                    assert message['url'] == authorize and message['type'] in ['OAUTH_PAGE_READY','OAUTH_SUBMITTED']
                    messages.append(message['type'])
                    return {'ok':True,'password':password} if message['type']=='OAUTH_PAGE_READY' else {'ok':True}
                popup.expose_function('__syntheticChromeSend', ipc)
                popup.evaluate('globalThis.chrome={runtime:{sendMessage:m=>globalThis.__syntheticChromeSend(m)}}')
                popup.evaluate(helper)
            else:
                popup.get_by_label('Password', exact=True).fill(password)
                popup.get_by_role('button', name='Authorize', exact=True).click()
            if case == 'old_no_referrer':
                expect(popup.get_by_text('Untrusted request origin', exact=True)).to_be_visible()
                assert len(posts)==1 and posts[0]['origin']=='null' and posts[0]['status']==403 and not callbacks
            else:
                try: expect(popup.get_by_text('CALLBACK_REACHED', exact=True)).to_be_visible()
                except Exception:
                    print('NULL_ORIGIN_FROM_RESPONSE_POLICY', json.dumps({'case':case,'posts':posts,'policy':observed_policy,'errors':failures}),flush=True)
                    raise
                assert len(posts)==1 and posts[0]['origin']==base and posts[0]['status']==303 and posts[0]['cookie_present']
                assert observed_policy==['strict-origin'] and len(callbacks)==1 and not failures
                form=urlencode(dict(grant_type='authorization_code',client_id=query['client_id'],redirect_uri=callback_base,code_verifier=verifier,code=callbacks[0]))
                status, _, body=request_local('POST','/oauth/token',{'Content-Type':'application/x-www-form-urlencoded'},form)
                assert status==200,'Actual PKCE/token exchange failed'
                token=json.loads(body)['access_token']
                status, _, body=request_local('POST','/mcp',{'Content-Type':'application/json','Authorization':'Bearer '+token},json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/list'}))
                assert status==200 and len(json.loads(body)['result']['tools'])==71
                if case=='extension': assert messages==['OAUTH_PAGE_READY','OAUTH_SUBMITTED']
            rows.append({'case':case,'post':posts[0],'all_response_headers_forwarded':True,
                         'callback_get_without_body':bool(callbacks),'actual_token_and_catalog_verified':case!='old_no_referrer'})
        finally: context.close()
    version=browser.version; browser.close()
# Rejection remains strict even after successful authorization; do not allow null globally.
for origin in ['null','https://attacker.invalid']:
    status, _, _=request_local('POST','/oauth/authorize',{'Origin':origin,'Host':'attacker.invalid','Content-Type':'application/x-www-form-urlencoded'},'')
    assert status==403
status, headers, _=request_local('GET','/.well-known/oauth-authorization-server')
assert status==200 and headers['referrer-policy']=='no-referrer'
proof={'source':os.environ['SOURCE'],'browser':version,'cases':rows,'passed':True,
       'forged_origin_denied':True,'ordinary_referrer_policy':'no-referrer','model_requests':0,
       'live_account':False,'transport':'all browser requests intercepted; OAuth/PKCE/token/catalog responses from live Rust loopback listener',
       'extension_ipc':'synthetic; exact v0.0.7 helper executed','external_browser_network_blocked':True}
(evidence/'browser-live.json').write_text(json.dumps(proof,indent=2)+'\n')
print('PASS: real browser Origin through real Rust guard, manual and extension consent, PKCE/token/catalog, null-origin denial')
