"""Compiled Desktop task monitor, synthetic IPC. No external services or image generation."""
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen
from playwright.sync_api import sync_playwright,expect
import json,os,shutil,subprocess,sys,time
root=Path('aiTemp/evidence');root.mkdir(parents=True,exist_ok=True)
chrome=os.environ.get('CHROME_PATH') or shutil.which('google-chrome') or shutil.which('chromium')
if not chrome:
 for candidate in [r'C:\Program Files\Google\Chrome\Application\chrome.exe',r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe']:
  if Path(candidate).is_file():chrome=candidate;break
assert chrome
stub=r'''(() => {
 const id='a'.repeat(32);window.__monitorCalls=[];window.__calls=[];window.__hold=false;window.__failNext=false;
 const profiles=['primary','secondary'].map(id=>({id,name:id==='primary'?'Primary project':'Second project',path:'C:/fixture/'+id,runtime:{tool_profile:'advanced',permission_mode:'workspace-write'},tunnel:{type:'none'},auth:{type:'bearer'}}));
 function result(args){const objective=args.workspaceId==='primary'?'Review real task details':'FOREIGN late task';
  const task={id,workspace_id:'f'.repeat(32),objective,status:'active',created_at:'1800000000000',updated_at:'1800000001000',completed_steps:['Read current source'],pending_steps:['Verify result'],latest_change_id:null,latest_verification_id:null};
  return {workspace_id:args.workspaceId,requested_task_id:args.taskId||null,workspace_path:'C:/fixture/'+args.workspaceId,desktop_version:'0.4.5',checked_at_ms:Date.now(),listener_running:true,policy_revision:7,permission_mode:'workspace-write',runtime_id:'fixture-runtime',
   history:{tasks:[{...task,completed_count:1,pending_count:1}],task:args.taskId?task:null,events:args.taskId?[{id:'event-1',task_id:id,operation_id:'op-event',kind:'tool_returned',tool_name:'read_file',created_at:'1800000001000',ok:true,code:null,exit_code:null,command_id:null,files:[]}]:[],next_cursor:null,partial_tail:false,warnings:[],recent_limit:20},
   operations:[{operation_id:'fixture-operation',request_id:'rpc-1',tool_name:'exec_command',method:'tools/call',state:'completed',completion_kind:'returned',admitted_at_ms:1800000000000,finished_at_ms:1800000001000,result_state:'available',completion_is_dispatch_only:true,safe_to_retry:false}],retention_note:'Runtime receipts expire; dispatch completion does not prove a command finished.'};}
 window.__finishMonitor=i=>{const r=window.__monitorCalls[i];r.resolve(result(r.args));};
 window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:p=>p,invoke:async(name,args={})=>{
  args=JSON.parse(JSON.stringify(args));window.__calls.push(name);
  if(name==='list_workspaces')return profiles;
  if(name==='list_linked_projects'||name==='list_frp_profiles')return [];
  if(name==='control_board_read')return {revision:0,tasks:[]};
  if(name==='get_runtime_status'||name==='get_actions_runtime_status')return {state:'running',localMessage:'fixture'};
  if(name==='get_webview_memory_sample')return {supported:false};
  if(name==='task_monitor_read')return new Promise((resolve,reject)=>{const n=window.__monitorCalls.push({args,resolve,reject})-1;if(window.__failNext){window.__failNext=false;reject(Error('Synthetic monitor unavailable'));}else if(!window.__hold){resolve(result(args));}});
  if(name.startsWith('plugin:'))return name.includes('is_minimized')?false:1;
  throw Error('Unexpected IPC '+name);
 }};
})();'''
log=(root/'monitor-preview.txt').open('w',encoding='utf-8')
server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','1438','--strictPort'],stdout=log,stderr=subprocess.STDOUT)
try:
 for _ in range(60):
  assert server.poll() is None
  try:
   with urlopen('http://127.0.0.1:1438/work',timeout=1) as r:
    if r.status==200:break
  except OSError:time.sleep(.2)
 else:raise RuntimeError('Preview did not start')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=chrome,headless=True,args=['--no-sandbox','--disable-background-networking'])
  context=browser.new_context(service_workers='block',viewport={'width':1440,'height':1050});context.add_init_script(stub)
  context.route('**/*',lambda route:route.continue_() if urlsplit(route.request.url).netloc=='127.0.0.1:1438' else route.abort())
  page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  try:
   page.goto('http://127.0.0.1:1438/work',wait_until='networkidle')
   # Both the board and sidebar now expose navigation. Require the exact board
   # link instead of treating two valid entry points as a missing feature.
   entry=page.get_by_role('main').get_by_role('link',name='Task monitor',exact=True)
   try:expect(entry).to_be_visible(timeout=5000)
   except AssertionError as e:raise AssertionError('MONITOR_NAVIGATION_MISSING: work board has no live MCP task monitor') from e
   if '--baseline' in sys.argv:raise AssertionError('Expected baseline missing-monitor regression was not reproduced')
   entry.click()
   expect(page.get_by_role('heading',name='Task monitor',exact=True)).to_be_visible()
   expect(page.get_by_role('button',name='Inspect task Review real task details',exact=True)).to_be_visible()
   page.get_by_role('checkbox',name='Auto-refresh',exact=True).uncheck()
   page.get_by_role('button',name='Inspect task Review real task details',exact=True).click()
   expect(page.get_by_text('op-event',exact=True)).to_be_visible()
   expect(page.get_by_text('Verify result',exact=True)).to_be_visible()
   expect(page.get_by_text('Dispatch returned; command may still run',exact=True)).to_be_visible()
   page.evaluate('window.__hold=true')
   before=page.evaluate('window.__monitorCalls.length')
   page.get_by_label('Workspace',exact=True).select_option('secondary')
   page.wait_for_function(f'window.__monitorCalls.length>{before}')
   second=page.evaluate('window.__monitorCalls.length-1')
   page.get_by_label('Workspace',exact=True).select_option('primary')
   page.evaluate('(i)=>window.__finishMonitor(i)',second)
   page.wait_for_function(f'window.__monitorCalls.length>{second+1}')
   page.evaluate('window.__finishMonitor(window.__monitorCalls.length-1);window.__hold=false')
   expect(page.get_by_role('button',name='Inspect task Review real task details',exact=True)).to_be_visible()
   expect(page.get_by_text('FOREIGN late task',exact=True)).to_have_count(0)
   page.evaluate('window.__failNext=true')
   page.get_by_role('button',name='Refresh monitor',exact=True).click()
   expect(page.get_by_role('alert')).to_contain_text('Synthetic monitor unavailable')
   expect(page.get_by_text('Last verified snapshot — stale',exact=True)).to_be_visible()
   page.get_by_role('button',name='Refresh monitor',exact=True).click()
   expect(page.get_by_role('alert')).to_have_count(0)
   page.get_by_role('button',name='Change language',exact=True).click()
   expect(page.get_by_role('heading',name='任務監察',exact=True)).to_be_visible()
   calls=page.evaluate('window.__calls');assert not errors,errors
   assert not any(n in calls for n in ['start_runtime','restart_runtime','stop_runtime','control_board_change','codex_local_control','exec_command','delete_workspace']),calls
   proof={'source':os.environ['SOURCE'],'passed':True,'cases':['real navigation','task event details','dispatch is not completion','late foreign response suppressed','failed refresh marked stale','Traditional Chinese'],'boundary':'compiled Svelte with synthetic JSON IPC; no host agents, external network or screenshots','model_requests':0,'console_errors':errors}
   (root/'task-monitor-browser.json').write_text(json.dumps(proof,indent=2)+'\n')
   print('MONITOR_BROWSER_PASS: task details, operation evidence and scope-safe refresh')
  except Exception:
   (root/'task-monitor-failure.json').write_text(json.dumps({'errors':errors,'calls':page.evaluate('window.__calls'),'text':page.locator('main').inner_text()[-10000:]},indent=2)+'\n')
   raise
  finally:browser.close()
finally:
 server.terminate()
 try:server.wait(timeout=5)
 except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
 log.close()
