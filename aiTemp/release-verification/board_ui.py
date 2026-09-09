"""Rendered board regression with synthetic desktop IPC; no agents or user data."""
import json
import os
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root = Path('aiTemp/evidence'); root.mkdir(parents=True, exist_ok=True)
stub = r'''(() => {
 const key='qa-synthetic-board';
 const initial={revision:0,tasks:[{id:'coc',workspace_id:'work',title:'coc',description:'Synthetic board fixture',state:'backlog',step:0,created_at:1,updated_at:1,evidence:[]}]};
 window.__qaCalls=[];
 window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:(p)=>p,
 invoke:async(name,args={})=>{
   window.__qaCalls.push({name,args});
   if(name==='list_workspaces')return [{id:'work',name:'Fixture workspace',root_path:'/synthetic/work',path:'/synthetic/work',mcp_port:8765}];
   if(name==='list_linked_projects')return [];
   if(name==='get_runtime_status'||name==='get_actions_runtime_status')return {state:'stopped'};
   if(name.startsWith('plugin:'))return name.includes('is_minimized')?false:1;
   if(name==='control_board_read')return JSON.parse(localStorage.getItem(key)||JSON.stringify(initial));
   if(name==='control_board_change'){
     const board=JSON.parse(localStorage.getItem(key)||JSON.stringify(initial));
     if(window.__qaReject){window.__qaReject=false;throw Error('Synthetic save rejected');}
     if(args.revision!==board.revision)throw Error('The board changed in another window. Refresh before retrying.');
     const c=args.change;
     if(c.operation==='create')board.tasks.push({id:'new-'+board.revision,workspace_id:c.workspace_id,title:c.title,description:c.description,state:c.state||'backlog',step:0,created_at:2,updated_at:2,evidence:[]});
     else if(c.operation==='move'){
       const i=board.tasks.findIndex(t=>t.id===c.id);if(i<0)throw Error('No task');
       const [t]=board.tasks.splice(i,1);t.state=c.state;
       const before=c.before_id?board.tasks.findIndex(v=>v.id===c.before_id):-1;
       if(before<0)board.tasks.push(t);else board.tasks.splice(before,0,t);
     }else if(c.operation==='record_step'){const t=board.tasks.find(v=>v.id===c.id);t.evidence.push({step:t.step++,note:c.note,source:'operator_attestation',recorded_at:2});}
     else if(c.operation==='archive'){board.tasks.find(v=>v.id===c.id).state='archived';}
     else throw Error('Unexpected operation '+c.operation);
     board.revision++;localStorage.setItem(key,JSON.stringify(board));return board;
   }
   if(name==='get_webview_memory_sample')return {supported:false};
   throw Error('Unexpected IPC '+name);
 }};
})();'''
with sync_playwright() as p:
 executable = shutil.which('google-chrome') or shutil.which('chromium')
 assert executable, 'A permitted CI browser must already be installed'
 browser = p.chromium.launch(executable_path=executable, headless=True)
 context = browser.new_context(viewport={'width':1440,'height':950})
 context.add_init_script(stub)
 page = context.new_page(); errors=[]
 page.on('pageerror', lambda error: errors.append(str(error)))
 try:
  page.goto('http://127.0.0.1:1420/work', wait_until='networkidle')
  expect(page.get_by_role('heading', name='Work board', exact=True)).to_be_visible()
  expect(page.get_by_role('button', name='New task', exact=True)).to_be_enabled()
  page.get_by_role('button', name='New task in Needs attention', exact=True).click()
  expect(page.get_by_label('Initial status', exact=True)).to_have_value('blocked')
  page.get_by_label('Task title', exact=True).fill('Investigate task movement')
  page.get_by_role('button', name='Create task', exact=True).click()
  attention=page.locator('[data-board-column="blocked"]')
  expect(attention.get_by_text('Investigate task movement', exact=True)).to_be_visible()
  page.reload(wait_until='networkidle')
  expect(attention.get_by_text('Investigate task movement', exact=True)).to_be_visible()
  card=page.locator('[data-task-id="coc"]')
  card.drag_to(page.locator('[data-board-column="in_progress"] .cc-column-cards'))
  expect(page.locator('[data-board-column="in_progress"] [data-task-id="coc"]')).to_be_visible()
  card.drag_to(attention.locator('.cc-column-cards'))
  expect(attention.locator('[data-task-id="coc"]')).to_be_visible()
  card.locator('.cc-card-open').click()
  page.get_by_label('Move task to', exact=True).select_option('done')
  expect(page.locator('[data-board-column="done"] [data-task-id="coc"]')).to_be_visible()
  expect(page.get_by_text('Board status only — checklist evidence is unchanged.', exact=True)).to_be_visible()
  task=next(t for t in page.evaluate("JSON.parse(localStorage.getItem('qa-synthetic-board'))")['tasks'] if t['id']=='coc')
  assert task['step']==0 and task['evidence']==[],task
  page.evaluate('window.__qaReject=true')
  page.get_by_label('Move task to', exact=True).select_option('backlog')
  expect(page.get_by_role('alert')).to_contain_text('Synthetic save rejected')
  expect(page.locator('[data-board-column="done"] [data-task-id="coc"]')).to_be_visible()
  page.get_by_role('button', name='Refresh board', exact=True).click()
  page.get_by_label('Move task to', exact=True).select_option('backlog')
  expect(page.locator('[data-board-column="backlog"] [data-task-id="coc"]')).to_be_visible()
  page.reload(wait_until='networkidle')
  expect(page.locator('[data-board-column="backlog"] [data-task-id="coc"]')).to_be_visible()
  assert not [c for c in page.evaluate('window.__qaCalls') if 'codex' in c['name'] or c['name']=='integration_read']
  assert not errors,errors
  page.get_by_role('button', name='Change language', exact=True).click()
  expect(page.get_by_role('heading', name='任務看板', exact=True)).to_be_visible()
  expect(page.get_by_role('button', name='在需要處理新增任務', exact=True)).to_be_visible()
  page.set_viewport_size({'width':980,'height':760})
  assert page.locator('vite-error-overlay').count()==0
  page.screenshot(path=str(root/'board-verified.png'), full_page=False)
  (root/'board-ui-result.json').write_text(json.dumps({'passed':True,'source':os.environ.get('SOURCE'),'boundary':'GitHub-hosted browser with synthetic IPC, not native persistence','checks':['direct Needs attention creation and reload','real drag between columns','keyboard move, evidence preserved, rejected save stays put','Traditional Chinese and 980px layout'],'console_errors':errors},indent=2))
  print('PASS: direct column creation, real drag, keyboard move, failed save, reload and bilingual labels')
 except Exception:
  (root/'board-dom.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
  (root/'browser-errors.json').write_text(json.dumps(errors), encoding='utf-8')
  raise
 finally:
  browser.close()
