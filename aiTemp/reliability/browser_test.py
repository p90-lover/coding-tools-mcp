"""Actual compiled integration UI with synthetic desktop IPC; no external services."""
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen
from playwright.sync_api import sync_playwright,expect
import json,os,shutil,subprocess,time
root=Path('aiTemp/evidence');root.mkdir(parents=True,exist_ok=True)
chrome=os.environ.get('CHROME_PATH') or shutil.which('google-chrome') or shutil.which('chromium')
if not chrome:
    for candidate in [r'C:\Program Files\Google\Chrome\Application\chrome.exe',r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe']:
        if Path(candidate).is_file():chrome=candidate;break
assert chrome,'CI Chromium was not found'
stub=r'''(() => {
 window.__reads=[];window.__calls=[];
 window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:p=>p,
 invoke:async(name,args={})=>{
  window.__calls.push(name);
  if(name==='integration_read')return new Promise((resolve,reject)=>window.__reads.push({args,resolve,reject}));
  if(name==='list_workspaces')return [];
  if(name==='control_board_read')return {revision:0,tasks:[]};
  if(name==='get_webview_memory_sample')return {supported:false};
  if(name.startsWith('plugin:'))return name.includes('is_minimized')?false:1;
  throw Error('Unexpected IPC '+name);
 }};
 window.__finishRead=(index,fail=false)=>{
  const p=window.__reads[index];
  if(fail){p.reject(Error('Synthetic current endpoint failure'));return;}
  const endpoint=new URL(p.args.endpoint);if(p.args.source==='paseo')endpoint.pathname='/ws';
  p.resolve({source:p.args.source,endpoint:endpoint.href,checked_at:123,read_only:true,items:[],has_more:false,server_version:null});
 };
})();'''
log=(root/'preview.txt').open('w',encoding='utf-8')
server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','1436','--strictPort'],stdout=log,stderr=subprocess.STDOUT)
try:
    for _ in range(50):
        assert server.poll() is None,'Preview stopped unexpectedly'
        try:
            with urlopen('http://127.0.0.1:1436/integrations',timeout=1) as response:
                if response.status==200:break
        except OSError:time.sleep(.2)
    else:raise RuntimeError('Preview did not become ready')
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=chrome,headless=True,args=['--no-sandbox','--disable-background-networking'])
        context=browser.new_context(service_workers='block',viewport={'width':1280,'height':950})
        context.add_init_script(stub)
        context.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc=='127.0.0.1:1436' else r.abort('blockedbyclient'))
        page=context.new_page();errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        try:
            page.goto('http://127.0.0.1:1436/integrations',wait_until='networkidle')
            expect(page.get_by_role('heading',name='Integrations',exact=True)).to_be_visible()
            index=0
            for source in ['paseo','anneal']:
                card=page.locator('section.cc-integration').filter(has=page.get_by_role('heading',name=source.capitalize(),exact=True))
                card.get_by_role('button',name='Connect & read',exact=True).click()
                page.wait_for_function('(n)=>window.__reads.length===n',arg=index+1)
                expect(card.get_by_role('button',name='Clear view',exact=True)).to_be_enabled()
                card.get_by_role('button',name='Clear view',exact=True).click()
                page.evaluate('(i)=>window.__finishRead(i)',index);index+=1
                page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                expect(card.locator('.cc-connection-proof')).to_have_count(0)
                card.get_by_role('button',name='Connect & read',exact=True).click()
                page.wait_for_function('(n)=>window.__reads.length===n',arg=index+1)
                endpoint='ws://127.0.0.1:6768/ws' if source=='paseo' else 'http://127.0.0.1:3001/'
                card.get_by_label(source+' endpoint',exact=True).fill(endpoint)
                card.get_by_role('button',name='Connect & read',exact=True).click()
                page.wait_for_function('(n)=>window.__reads.length===n',arg=index+2)
                page.evaluate('(i)=>window.__finishRead(i)',index);index+=1
                expect(card.get_by_role('button',name='Reading…',exact=True)).to_be_disabled()
                expect(card.locator('.cc-connection-proof')).to_have_count(0)
                page.evaluate('(i)=>window.__finishRead(i)',index);index+=1
                expect(card.locator('.cc-connection-proof')).to_contain_text(endpoint)
                card.get_by_role('button',name='Refresh snapshot',exact=True).click()
                page.wait_for_function('(n)=>window.__reads.length===n',arg=index+1)
                page.evaluate('(i)=>window.__finishRead(i,true)',index);index+=1
                expect(card.get_by_role('alert')).to_contain_text('Synthetic current endpoint failure')
                expect(card.locator('.cc-connection-proof')).to_have_count(0)
            calls=page.evaluate('window.__calls')
            assert not any('codex' in name or name in ['control_board_change','sandbox_local_prepare','sandbox_exec'] for name in calls),calls
            assert not errors,errors
            page.get_by_role('button',name='Change language',exact=True).click()
            expect(page.get_by_role('heading',name='專案整合',exact=True)).to_be_visible()
            proof={'source':os.environ['SOURCE'],'passed':True,'browser':browser.version,'sources':['paseo','anneal'],
                'cases':['clear during pending read','retarget and overlap','current failure clears old proof','Traditional Chinese heading'],
                'boundary':'actual built Svelte page; synthetic Tauri IPC; external requests blocked','model_requests':0,'screenshots_written':0,'console_errors':errors}
            (root/'integration-browser.json').write_text(json.dumps(proof,indent=2)+'\n')
            print('RELIABILITY_BROWSER: actual integration page clear/retarget/failure and Traditional Chinese checks passed; no engine invoked')
        finally:browser.close()
finally:
    server.terminate()
    try:server.wait(timeout=5)
    except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
    log.close()
