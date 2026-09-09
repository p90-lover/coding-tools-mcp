"""Extend the existing rendered-board test without any model or host-control calls."""
from pathlib import Path

path = Path('aiTemp/release-verification/board_ui.py')
source = path.read_text(encoding='utf-8')
marker = "  page.get_by_role('button', name='Change language', exact=True).click()\n"
assert source.count(marker) == 1
extra = '''  # External updates are simulated only at IPC storage; the actual UI refresh runs.
  page.get_by_role('button', name='New task', exact=True).click()
  page.get_by_label('Task title', exact=True).fill('Unsubmitted human draft')
  page.evaluate("""() => {
    const key='qa-synthetic-board', b=JSON.parse(localStorage.getItem(key));
    b.revision++;
    b.tasks.push({id:'mcp-added',workspace_id:'work',title:'MCP synchronized task',description:'Remote observation fixture',state:'blocked',step:0,created_at:3,updated_at:3,evidence:[{step:0,note:'AI found a failing check; operator review required',source:'mcp_observation',recorded_at:3}]});
    localStorage.setItem(key,JSON.stringify(b));
  }""")
  expect(page.locator('[data-task-id="mcp-added"]')).to_be_visible(timeout=8000)
  expect(page.get_by_label('Task title', exact=True)).to_have_value('Unsubmitted human draft')
  page.locator('[data-task-id="mcp-added"] .cc-card-open').click()
  page.get_by_text('Recorded evidence', exact=True).click()
  expect(page.get_by_text('AI / MCP observation — not human approval', exact=True)).to_be_visible()
  # The paragraph contains the provenance <small>, a line break and the note text.
  # Assert the actual paragraph content, not an exact locator for only its text node.
  evidence = page.locator('.cc-chain-steps details[open] p')
  expect(evidence).to_have_count(1)
  expect(evidence).to_be_visible()
  expect(evidence).to_contain_text('AI / MCP observation — not human approval')
  expect(evidence).to_contain_text('AI found a failing check; operator review required')
  remote=next(t for t in page.evaluate("JSON.parse(localStorage.getItem('qa-synthetic-board'))")['tasks'] if t['id']=='mcp-added')
  assert remote['step']==0 and remote['state']=='blocked'
  assert not [c for c in page.evaluate('window.__qaCalls') if 'codex' in c['name'] or c['name']=='integration_read']
'''
source = source.replace(marker, extra + marker, 1)
source = source.replace("'Traditional Chinese and 980px layout'", "'Traditional Chinese and 980px layout','quiet remote refresh preserves unsubmitted draft','MCP observation is visibly separate from human approval'")
source = source.replace("'PASS: direct column creation, real drag, keyboard move, failed save, reload and bilingual labels'", "'PASS: direct column creation, real drag, quiet sync, draft preservation, truthful observation labels and bilingual controls'")
exec(compile(source, str(path), 'exec'), {'__name__': '__main__', '__file__': str(path)})
