from playwright.sync_api import sync_playwright, expect
import json, os, shutil, time

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROME_BIN') or shutil.which('google-chrome') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':900,'height':500})
    errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script("""
      window.__resolveIntegration = null;
      window.__TAURI_INTERNALS__={invoke:async(name,args)=>{
        if(name!=='integration_read') throw Error('unexpected invoke '+name);
        return await new Promise(resolve=>{window.__resolveIntegration=resolve;});
      }};
    """)
    page.goto('http://127.0.0.1:1431',wait_until='networkidle')
    page.locator('#read').click(); expect(page.locator('#busy')).to_have_text('busy')
    page.locator('#clear').click(); expect(page.locator('#snapshot')).to_have_text('null')
    page.evaluate("window.__resolveIntegration({source:'paseo',endpoint:'ws://127.0.0.1:6767/ws',checked_at:1,items:[{id:'stale'}],warning:null})")
    time.sleep(0.25)
    stale=json.loads(page.locator('#snapshot').inner_text())
    if stale is not None:
        raise AssertionError('STALE_INTEGRATION_RESPONSE: invalidated request repopulated cleared view')
    expect(page.locator('#busy')).to_have_text('idle')
    assert not errors, errors
    print('PASS: invalidated integration response cannot repopulate cleared view')
    browser.close()
