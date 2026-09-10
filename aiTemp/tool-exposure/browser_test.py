from playwright.sync_api import sync_playwright, expect
import json,os,shutil
from pathlib import Path
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROME_BIN') or shutil.which('google-chrome') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1100,'height':900});errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script("""window.__catalogCalls=[]; window.__TAURI_INTERNALS__={invoke:async(name,args)=>{
      window.__catalogCalls.push({name,args});
      if(name!=='get_tool_catalog_status') throw Error('Unexpected side effect '+name);
      return {profile:'core',configured_profile:'core',server_version:'fixture',evidence_source:'running_listener',registered_count:9,advertised_count:7,advertised_names:['server_info','read_file','apply_patch','list_files','view_image','update_plan','sandbox_exec'],hidden_by_profile:['start_task','harness_status'],catalog_sha256:'a'.repeat(64),advertised_but_unavailable:['sandbox_exec'],read_only_hint_count:5,write_hint_count:2};
    }};""")
    page.goto('http://127.0.0.1:1429',wait_until='networkidle')
    assert page.title()=='Tool exposure regression'
    expect(page.get_by_role('heading',name='Tool exposure regression')).to_be_visible()
    selected=page.locator('form select').first
    expect(selected).to_have_value('core',timeout=3000)
    page.get_by_role('button',name='Load advanced',exact=True).click()
    expect(selected).to_have_value('advanced')
    page.get_by_role('button',name='Load full alias',exact=True).click()
    expect(selected).to_have_value('advanced')
    selected.select_option('core')
    page.locator('form button[type=submit]').click()
    saved=json.loads(page.get_by_test_id('saved').inner_text())
    assert saved['toolProfile']=='core' and saved['permissionMode']=='read-only' and not saved['allowScreenCapture']
    expect(page.get_by_test_id('catalog-count')).to_contain_text('7 / 9')
    expect(page.get_by_text('ChatGPT loaded tools: unknown.',exact=False)).to_be_visible()
    page.get_by_text('Hidden by profile / 被目錄隱藏的工具',exact=True).click()
    expect(page.get_by_text('start_task, harness_status',exact=True)).to_be_visible()
    expect(page.get_by_test_id('catalog-fingerprint')).to_contain_text('a'*64)
    page.evaluate("window.__TAURI_INTERNALS__.invoke=async()=>{throw Error('fixture listener unavailable')}")
    page.get_by_role('button',name='Check catalog / 檢查目錄',exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('fixture listener unavailable')
    expect(page.get_by_test_id('catalog-count')).to_have_count(0)
    calls=page.evaluate('window.__catalogCalls')
    assert calls and all(c['name']=='get_tool_catalog_status' and c['args']=={'id':'fixture-workspace'} for c in calls)
    assert not errors,errors
    Path('aiTemp/evidence/browser-result.json').write_text(json.dumps({'passed':True,'source':os.environ['SOURCE'],'ipc':'synthetic; actual Svelte components','viewport':[1100,900],'profile_aliases':['core','advanced','full'],'checks':['save retains read-only permissions','counts and hidden names','client loaded state stays unknown','failure clears stale result'],'console_errors':errors},indent=2))
    print('PASS: real profile dropdown core/advanced/full alias and save preserve execution permissions')
    browser.close()
