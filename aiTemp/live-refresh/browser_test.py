"""Real compiled Svelte page; synthetic Tauri IPC; no live account or host controls."""
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect
import json, os, shutil, subprocess, time
root=Path('aiTemp/evidence');root.mkdir(parents=True,exist_ok=True)
chrome=os.environ.get('CHROME_PATH') or shutil.which('google-chrome') or shutil.which('chromium')
if not chrome:
    for name in [r'C:\Program Files\Google\Chrome\Application\chrome.exe',r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe']:
        if Path(name).is_file():chrome=name;break
assert chrome
stub=r'''(() => {
 const profile={id:'primary-fixture',name:'Primary fixture',path:'C:/synthetic/primary',
  tunnel:{type:'none',public_url:'',frp_server:'',frp_subdomain:'',cloudflare_mode:'quick'},
  auth:{type:'bearer',oauth_client_id:'synthetic',use_shared_secrets:false},
  runtime:{local_port:28766,tool_profile:'advanced',permission_mode:'workspace-write',approval_mode:'on-request',allowed_commands:'git',workspace_local_entries:false,workspace_script_extensions:'.exe',allow_screen_capture:false}};
 window.__profiles=[profile];window.__links={};window.__calls=[];window.__saves=[];
 window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:p=>p,
 invoke:async(name,args={})=>{
  window.__calls.push(name);
  if(name==='list_workspaces')return structuredClone(window.__profiles);
  if(name==='list_linked_projects')return structuredClone(window.__links[args.id]||[]);
  if(name==='list_frp_profiles')return [];
  if(name==='set_last_workspace')return null;
  if(name==='get_runtime_status'||name==='get_actions_runtime_status')return {state:'running',pid:123,localMessage:'fixture only',publicMessage:'not verified',localEndpoint:'http://127.0.0.1:28766/mcp',publicEndpoint:''};
  if(name==='update_workspace')return new Promise((resolve,reject)=>window.__saves.push({profile:structuredClone(args.profile),resolve:()=>{window.__profiles=window.__profiles.map(p=>p.id===args.profile.id?structuredClone(args.profile):p);resolve(null);},reject}));
  if(['get_secret','get_workspace_secret','get_shared_secret'].includes(name))return 'synthetic-only';
  if(name==='get_webview_memory_sample')return {supported:false};
  if(name==='get_tool_catalog_status')return {registered_count:71,advertised_count:71,profile:'advanced',configured_profile:'advanced',server_version:'fixture',evidence_source:'synthetic',advertised_names:[],hidden_by_profile:[],advertised_but_unavailable:[],catalog_sha256:'fixture',read_only_hint_count:42,write_hint_count:29};
  if(name==='control_board_read')return {revision:0,tasks:[]};
  if(name.startsWith('plugin:'))return name.includes('is_minimized')?false:1;
  throw Error('Unexpected IPC '+name);
 }};
})();'''
log=(root/'refresh-preview.txt').open('w',encoding='utf-8')
server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','1437','--strictPort'],stdout=log,stderr=subprocess.STDOUT)
try:
    for _ in range(50):
        assert server.poll() is None,'Preview stopped'
        try:
            with urlopen('http://127.0.0.1:1437/workspace/primary-fixture',timeout=1) as r:
                if r.status==200:break
        except OSError:time.sleep(.2)
    else:raise RuntimeError('Preview unavailable')
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=chrome,headless=True,args=['--no-sandbox','--disable-background-networking'])
        context=browser.new_context(service_workers='block',viewport={'width':1366,'height':1000})
        context.add_init_script(stub)
        context.route('**/*',lambda route:route.continue_() if urlsplit(route.request.url).netloc=='127.0.0.1:1437' else route.abort('blockedbyclient'))
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        try:
            page.goto('http://127.0.0.1:1437/workspace/primary-fixture',wait_until='networkidle')
            form=page.locator('form').filter(has=page.get_by_label('Tool catalog / 工具目錄',exact=True))
            expect(form).to_be_visible()
            assert page.evaluate('window.__saves.length')==0,'Hydration must not save or grant permissions'
            mode=form.get_by_label('权限模式',exact=True)
            mode.select_option('read-only')
            page.wait_for_function('window.__saves.length===1')
            expect(mode).to_be_disabled()
            assert page.evaluate('window.__saves[0].profile.runtime.permission_mode')=='read-only'
            page.evaluate('window.__saves[0].resolve()')
            expect(form.get_by_role('status')).to_contain_text('Applied live')
            expect(mode).to_be_enabled()
            mode.select_option('workspace-write')
            page.wait_for_function('window.__saves.length===2')
            page.evaluate('window.__saves[1].reject(Error("synthetic persistence unavailable"))')
            expect(form.get_by_role('alert')).to_contain_text('Save not confirmed')
            assert page.evaluate('window.__profiles[0].runtime.permission_mode')=='read-only'
            form.get_by_role('button',name='保存策略',exact=True).click()
            page.wait_for_function('window.__saves.length===3')
            page.evaluate('window.__saves[2].resolve()')
            expect(form.get_by_role('status')).to_contain_text('Applied live')
            assert page.evaluate('window.__profiles[0].runtime.permission_mode')=='workspace-write'
            page.evaluate('''() => {const p=structuredClone(window.__profiles[0]);p.id='new-project';p.name='New approved project';p.path='C:/synthetic/new';window.__profiles.push(p);window.__links['primary-fixture']=[{alias:'second',name:'Approved linked root',path:p.path,mode:'read-write'}];window.dispatchEvent(new Event('coding-tools-workspaces-changed'));}''')
            expect(page.locator('.tx-nav-button').filter(has_text='New approved project')).to_be_visible()
            expect(page.get_by_role('button',name='Approved linked root @second')).to_be_visible()
            calls=page.evaluate('window.__calls')
            forbidden={'start_runtime','stop_runtime','restart_runtime','start_actions_runtime','start_tunnel','stop_tunnel','restart_tunnel','regenerate_workspace_secret','set_secret','delete_workspace','exec_command','sandbox_exec'}
            assert not forbidden.intersection(calls),calls
            assert not errors,errors
            proof={'source':os.environ['SOURCE'],'passed':True,'browser':browser.version,
                'cases':['hydration never saves','explicit changes auto-save','inflight save serialized','failed save not reported applied','explicit retry','approved project metadata appears without reconnect'],
                'boundary':'compiled Desktop page; synthetic Tauri IPC and profiles; external requests blocked',
                'runtime_restarts':0,'model_requests':0,'screenshots_written':0,'console_errors':errors}
            (root/'refresh-browser.json').write_text(json.dumps(proof,indent=2)+'\n')
            print('LIVE_REFRESH_BROWSER: automatic policy save, failure honesty, metadata refresh and no restart verified on compiled page')
        except Exception:
            print(json.dumps({'errors':errors,'calls':page.evaluate('window.__calls'),'saved':page.evaluate('window.__saves.length')},indent=2),flush=True)
            raise
        finally:browser.close()
finally:
    server.terminate()
    try:server.wait(timeout=5)
    except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
    log.close()
