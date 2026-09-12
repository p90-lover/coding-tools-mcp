"""Compiled Paseo/Anneal inspectors with synthetic JSON IPC, never a real agent."""
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen
from playwright.sync_api import sync_playwright,expect
import json,os,shutil,subprocess,sys,time
root=Path('aiTemp/evidence');root.mkdir(parents=True,exist_ok=True)
chrome=os.environ.get('CHROME_PATH') or shutil.which('google-chrome') or shutil.which('chromium')
if not chrome:
 for name in [r'C:\Program Files\Google\Chrome\Application\chrome.exe',r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe']:
  if Path(name).is_file():chrome=name;break
assert chrome
stub=r'''(()=>{window.__calls=[];window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:p=>p,invoke:async(name,args={})=>{
 args=JSON.parse(JSON.stringify(args));window.__calls.push(name);
 if(name==='list_workspaces')return [];
 if(name==='control_board_read')return {revision:0,tasks:[]};
 if(name==='get_webview_memory_sample')return {supported:false};
 if(name==='integration_read'){const s=args.source;return {source:s,endpoint:new URL(args.endpoint).href,checked_at:1800000000,read_only:true,has_more:false,server_version:'fixture-only',items:[{id:'fixture-'+s,title:s==='paseo'?'Paseo fixture session':'Anneal fixture task',status:s==='paseo'?'running':'review',provider:'codex',workspace:'C:/synthetic/provider-root',updated_at:'2026-09-12T00:00:00Z',pending_permissions:2,requires_attention:true,attention_reason:'permission',chain_id:'chain-42',chain_name:'Delivery chain',chain_layer:1,chain_index:3}]};}
 if(name.startsWith('plugin:'))return name.includes('is_minimized')?false:1;
 throw Error('Unexpected IPC '+name);
}};})();'''
log=(root/'source-preview.txt').open('w',encoding='utf-8')
server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','1439','--strictPort'],stdout=log,stderr=subprocess.STDOUT)
try:
 for _ in range(50):
  assert server.poll() is None
  try:
   with urlopen('http://127.0.0.1:1439/integrations',timeout=1) as r:
    if r.status==200:break
  except OSError:time.sleep(.2)
 else:raise RuntimeError('Preview unavailable')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=chrome,headless=True,args=['--no-sandbox','--disable-background-networking'])
  context=browser.new_context(service_workers='block',viewport={'width':1440,'height':1000});context.add_init_script(stub)
  context.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc=='127.0.0.1:1439' else r.abort())
  page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  try:
   page.goto('http://127.0.0.1:1439/integrations',wait_until='networkidle')
   for source in ['Paseo','Anneal']:
    card=page.locator('section.cc-integration').filter(has=page.get_by_role('heading',name=source,exact=True))
    card.get_by_role('button',name='Connect & read',exact=True).click()
    expect(card.locator('.cc-connection-proof')).to_be_visible()
   nav=page.get_by_role('navigation',name='Main navigation',exact=True)
   nav.get_by_role('link',name='Agent sessions',exact=True).click()
   button=page.get_by_role('button',name='Inspect session Paseo fixture session',exact=True)
   try:expect(button).to_be_visible(timeout=3000)
   except AssertionError as e:raise AssertionError('SOURCE_DETAILS_MISSING: provider directory is not inspectable') from e
   if '--baseline' in sys.argv:raise AssertionError('Baseline unexpectedly exposes source inspector')
   button.click();panel=page.get_by_role('region',name='Paseo details',exact=True)
   expect(panel).to_contain_text('fixture-paseo');expect(panel).to_contain_text('C:/synthetic/provider-root')
   expect(panel).to_contain_text('Pending permissions');expect(panel).to_contain_text('Read-only source snapshot')
   nav.get_by_role('link',name='Work board',exact=True).click()
   page.get_by_role('tab',name='Anneal').click()
   page.get_by_role('button',name='Inspect Anneal task Anneal fixture task',exact=True).click()
   panel=page.get_by_role('region',name='Anneal details',exact=True)
   expect(panel).to_contain_text('fixture-anneal');expect(panel).to_contain_text('chain-42');expect(panel).to_contain_text('Delivery chain')
   expect(panel).to_contain_text('does not assign work')
   page.get_by_role('button',name='Change language',exact=True).click()
   expect(panel).to_contain_text('供應商回報的詳情');expect(panel).to_contain_text('層級／索引')
   calls=page.evaluate('window.__calls');assert calls.count('integration_read')==2,calls
   assert not any(n in calls for n in ['control_board_change','codex_local_control','codex_local_connect','exec_command','start_runtime','restart_runtime','delete_workspace']),calls
   assert not errors,errors
   (root/'source-details-browser.json').write_text(json.dumps({'source':os.environ['SOURCE'],'passed':True,'sources':['paseo','anneal'],'boundary':'real compiled source pages and synthetic JSON IPC; not live daemons','model_requests':0,'mutations':0,'screenshots_written':0,'console_errors':errors},indent=2)+'\n')
   print('SOURCE_DETAILS_BROWSER_PASS: real provider detail routes, record identity, chain and permission evidence; no mutation or agent invocation')
  except Exception:
   (root/'source-details-failure.json').write_text(json.dumps({'errors':errors,'calls':page.evaluate('window.__calls'),'text':page.locator('main').inner_text()[-8000:]},indent=2)+'\n');raise
  finally:browser.close()
finally:
 server.terminate()
 try:server.wait(timeout=5)
 except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
 log.close()
