import test from 'node:test';
import assert from 'node:assert/strict';
let model = {};
try { model = await import('../../src/lib/control-center/model.js'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
test('Anneal-compatible board preserves known columns and never marks unknown states Done', () => {
  assert.equal(typeof model.columnFor, 'function', 'board integration must provide a normalizer');
  assert.deepEqual(model.columns.map(x => x.status), ['BACKLOG','TODO','DOING','REVIEW','DONE']);
  assert.equal(model.columnFor('RUNNING'), null);
  assert.equal(model.columnFor('DONE'), 'DONE');
});
test('local completion requires review and verification evidence', () => {
  assert.equal(typeof model.completionProblem, 'function', 'local review gate must exist');
  assert.ok(model.completionProblem({status:'DONE', review_note:'', verification_note:''}));
  assert.equal(model.completionProblem({status:'DONE',review_note:'Reviewed diff',verification_note:'Focused checks passed'}), '');
  assert.equal(model.completionProblem({status:'TODO',review_note:'',verification_note:''}), '');
});
test('navigation search and board counts use real scoped records only', () => {
  assert.equal(typeof model.filterTasks, 'function', 'scoped task filter must exist');
  const tasks=[{id:'a',workspace_id:'one',title:'Vision',status:'TODO',archived:false},{id:'b',workspace_id:'two',title:'Other',status:'DONE',archived:false},{id:'c',workspace_id:'one',title:'Archived',status:'DONE',archived:true}];
  assert.deepEqual(model.filterTasks(tasks,'one','vis').map(t=>t.id),['a']);
  assert.equal(model.countTasks(model.filterTasks(tasks,'one','')).DONE,0);
  assert.equal(model.canMutateExternal('codex'),false);
  assert.equal(model.canMutateExternal('claude'),false);
});
