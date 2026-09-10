"""Replay the unchanged production pair with redirect-complete, fail-closed transport.
Playwright route handlers only receive the first URL in a redirect chain. A CDP
Fetch session handles each subsequent hop; a non-listening loopback proxy prevents
any unhandled request reaching the public network. No application policy changes.
"""
from pathlib import Path
import hashlib,json,os
source=Path('aiTemp/compat/browser_test.py').read_text(encoding='utf-8')
def once(old,new):
    global source
    assert source.count(old)==1,(old[:100],source.count(old))
    source=source.replace(old,new,1)
once('import hashlib,json,os,re,shutil,subprocess,zipfile','import base64,hashlib,json,os,re,shutil,subprocess,zipfile')
once("headless=True,args=['--no-sandbox'])", "headless=True,proxy={'server':'http://127.0.0.1:9'},args=['--no-sandbox','--disable-background-networking'])")
once("context=browser.new_context();calls=[];errors=[];messages=[]", "context=browser.new_context(service_workers='block');calls=[];errors=[];messages=[]")
marker="        expect(popup.get_by_role('heading',name='Authorize Coding Tools MCP')).to_be_visible()"
once(marker,marker+'''
        # Initial popup GET is handled by context.route. From this point forward,
        # CDP owns every request, including redirect hops skipped by page.route.
        context.unroute('**/*',route_handler)
        cdp=context.new_cdp_session(popup)
        class CdpRequest:
            def __init__(self,request):
                self.url=request['url'];self.method=request['method']
                self.post_data=request.get('postData')
                self.headers={key.lower():str(value) for key,value in request['headers'].items()}
            def all_headers(self):return self.headers
        class CdpRoute:
            def __init__(self,event):
                self.id=event['requestId'];self.request=CdpRequest(event['request'])
            def fulfill(self,status,headers=None,body='',content_type=None):
                values=dict(headers or {})
                if content_type:values['Content-Type']=content_type
                cdp.send('Fetch.fulfillRequest',{'requestId':self.id,'responseCode':status,
                    'responseHeaders':[{'name':key,'value':value} for key,value in values.items()],
                    'body':base64.b64encode(body.encode()).decode()})
            def abort(self,*_args):
                cdp.send('Fetch.failRequest',{'requestId':self.id,'errorReason':'BlockedByClient'})
        def paused(event):
            try:route_handler(CdpRoute(event))
            except Exception as error:
                errors.append('INTERCEPTION_ASSERTION '+repr(error))
                cdp.send('Fetch.failRequest',{'requestId':event['requestId'],'errorReason':'BlockedByClient'})
        cdp.on('Fetch.requestPaused',paused)
        cdp.send('Fetch.enable',{'patterns':[{'urlPattern':'*','requestStage':'Request'}]})
''')
once("    'sender_boundary':'synthetic Chrome runtime; production helper and worker code'}", "    'sender_boundary':'synthetic Chrome runtime; production helper and worker code',\n    'network_isolation':'all redirect hops intercepted with CDP Fetch; non-listening loopback proxy; service workers blocked',\n    'validation_source':os.environ['GITHUB_SHA'],'validation_run':int(os.environ['GITHUB_RUN_ID'])}")
# Keep failed assertions actionable without logging real data: fixture values are synthetic.
once("            expect(popup.get_by_text('CALLBACK_REACHED',exact=True)).to_be_visible()", """            try:
                expect(popup.get_by_text('CALLBACK_REACHED',exact=True)).to_be_visible()
            except Exception:
                print(json.dumps({'case':case,'calls':calls,'errors':errors,'messages':messages,'url':popup.url}),flush=True)
                raise""")
output=Path('aiTemp/evidence/redirect-isolated-replay.py')
output.write_text(source,encoding='utf-8')
Path('aiTemp/evidence/replay-source.json').write_text(json.dumps({'build_source':os.environ['SOURCE'],
    'validation_source':os.environ['GITHUB_SHA'],'script_sha256':hashlib.sha256(source.encode()).hexdigest(),
    'reason':'route only catches first redirect; CDP Fetch replaces interception, not application behavior',
    'fixture_contains_only_synthetic_credentials':True},indent=2)+'\n')
exec(compile(source,str(output),'exec'),{'__name__':'__main__','__file__':str(output)})
