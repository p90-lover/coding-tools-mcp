"""Three rendered journeys against the built app and an explicit synthetic bridge.
No upstream agent or real user workspace is contacted. All QA assets stay in aiTemp.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, mimetypes, os, subprocess
from urllib.parse import urlparse, unquote
from xml.sax.saxutils import escape

root = Path(__file__).resolve().parent
# The Linux CI image has no CJK font. Extract the distro package without installing
# or running package scripts, and keep font files/caches out of product artifacts.
if os.environ.get('GITHUB_ACTIONS') == 'true':
    fonts = root / 'browser-fonts'
    fonts.mkdir(exist_ok=True)
    subprocess.run(['apt-get', 'download', 'fonts-noto-cjk'], cwd=fonts, check=True)
    packages = list(fonts.glob('fonts-noto-cjk*.deb'))
    assert len(packages) == 1
    extracted = fonts / 'extracted'
    subprocess.run(['dpkg-deb', '--extract', str(packages[0]), str(extracted)], check=True)
    configuration = fonts / 'fonts.conf'
    configuration.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>'
        '<include>/etc/fonts/fonts.conf</include><dir>' + escape(str(extracted / 'usr/share/fonts')) +
        '</dir><cachedir>' + escape(str(fonts / 'cache')) + '</cachedir></fontconfig>')
    os.environ['FONTCONFIG_FILE'] = str(configuration)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 960}, device_scale_factor=1, color_scheme='light')
    context.add_init_script(path=str(root / 'qa-fixture.js'))
    context.add_init_script("localStorage.setItem('theme','light')")
    build = root.parents[1] / 'build'
    def asset(route):
        path = (build / unquote(urlparse(route.request.url).path).lstrip('/')).resolve()
        if not path.is_relative_to(build.resolve()):
            route.abort()
            return
        if not path.is_file():
            path = build / 'index.html'
        route.fulfill(status=200, body=path.read_bytes(), content_type=mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
    context.route('https://control-center.test/**', asset)
    page = context.new_page()
    errors, completed = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.set_default_timeout(10000)
    try:
        page.goto('https://control-center.test/', wait_until='networkidle')
        page.get_by_role('heading', name='Overview', exact=True).wait_for()
        assert page.url == 'https://control-center.test/'
        assert 'Overview' in page.title()
        page.screenshot(path=str(root / 'overview-desktop.png'))
        page.get_by_role('link', name='Task board', exact=True).first.click()
        page.get_by_role('heading', name='Task board', exact=True).wait_for()
        page.screenshot(path=str(root / 'board-desktop.png'))
        page.get_by_role('button', name='New task', exact=True).click()
        page.get_by_label('Title', exact=True).fill('QA · Acceptance check')
        page.get_by_label('Specification', exact=True).fill('Created using the actual task editor in a test-only native bridge.')
        page.get_by_role('button', name='Save task', exact=True).click()
        card = page.get_by_role('button').filter(has=page.get_by_role('heading', name='QA · Acceptance check', exact=True))
        card.wait_for()
        card.click()
        page.get_by_label('Status', exact=True).select_option('DONE')
        page.get_by_role('button', name='Save task', exact=True).click()
        assert page.get_by_role('dialog').is_visible()
        page.get_by_label('Review note', exact=True).fill('Reviewed in isolated UI test')
        page.get_by_label('Verification note', exact=True).fill('Three focused assertions passed')
        page.get_by_role('button', name='Save task', exact=True).click()
        page.get_by_role('dialog').wait_for(state='detached')
        completed.append('task creation, completion gate and saved notes')

        page.get_by_role('button', name='Anneal Read-only', exact=True).click()
        page.get_by_role('button', name='Refresh', exact=True).click()
        page.get_by_role('heading', name='QA · Anneal board task').wait_for()
        page.get_by_role('link', name='Sessions', exact=True).click()
        page.get_by_role('button', name='Refresh', exact=True).click()
        page.get_by_text('QA · Existing review session', exact=True).wait_for()
        page.screenshot(path=str(root / 'sessions-desktop.png'))
        page.keyboard.press('Control+k')
        page.get_by_role('dialog').wait_for()
        page.get_by_role('textbox', name='Go to…').fill('Connections')
        page.locator('.cc-command-results button').filter(has_text='Connections').first.click()
        page.get_by_role('heading', name='Connections', exact=True).wait_for()
        page.screenshot(path=str(root / 'connections-desktop.png'))
        panel = page.locator('.cc-connection-card').first
        panel.get_by_role('button', name='Disconnect', exact=True).click()
        panel.get_by_role('button', name='Save & verify', exact=True).click()
        panel.get_by_text('Connected and read successfully. No agent was started.', exact=True).wait_for()
        completed.append('read-only sessions/board and connection configuration')

        page.get_by_role('link', name='Computer control', exact=True).click()
        page.get_by_role('heading', name='Computer control', exact=True).wait_for()
        page.screenshot(path=str(root / 'computer-desktop.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        page.get_by_role('button', name='Open navigation', exact=True).click()
        page.get_by_role('link', name='Task board', exact=True).click()
        page.get_by_role('heading', name='Task board', exact=True).wait_for()
        page.screenshot(path=str(root / 'board-mobile.png'))
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.get_by_role('button', name='Open navigation', exact=True).click()
        page.get_by_role('button', name='Switch interface language', exact=True).click()
        page.get_by_role('link', name='總覽', exact=True).click()
        page.get_by_role('heading', name='總覽', exact=True).wait_for()
        page.screenshot(path=str(root / 'overview-mobile-zh.png'))
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        completed.append('navigation/search and narrow bilingual layout')

        calls = page.evaluate('window.__QA_CALLS__')
        assert not any(x['cmd'] in ['start_agent', 'create_agent', 'send_agent_message', 'computer_local_start', 'sandbox_local_setup', 'start_runtime'] for x in calls)
        assert not errors, errors
        report = {'passed': completed, 'browser': 'Chromium via Playwright', 'viewport_desktop': [1440, 960], 'viewport_mobile': [390, 844], 'fixture_data': True, 'errors': errors, 'commands': sorted(set(c['cmd'] for c in calls))}
        (root / 'ui-qa-results.json').write_text(json.dumps(report, indent=2))
        print('PASS: three UI journeys; no browser errors; no unexpected execution commands')
    except Exception as error:
        page.screenshot(path=str(root / 'failure-desktop.png'))
        (root / 'ui-qa-results.json').write_text(json.dumps({'passed': completed, 'failure': str(error), 'errors': errors, 'fixture_data': True}, indent=2))
        raise
    finally:
        browser.close()
