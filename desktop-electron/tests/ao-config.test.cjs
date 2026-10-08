const test = require("node:test");
test("cancelling a captured pending edit prevents its timer from applying hidden-task settings", async()=>{
  const {createLatestConfigQueue}=await import("../src/features/ao-config.ts");
  const callbacks=new Map(),sent=[];
  const queue=createLatestConfigQueue({apply:async(scope,draft)=>sent.push([scope,draft]),onState:()=>{},
    setTimer:fn=>{callbacks.set(1,fn);return 1},clearTimer:id=>callbacks.delete(id)});
  const scope={workspaceId:"ws",taskId:"hidden",runId:"r"};
  queue.enqueue(scope,{id:"team",nodes:[]});
  queue.cancel(scope);
  for(const fn of callbacks.values())fn();
  await queue.flush(scope);
  require("node:assert/strict").equal(sent.length,0);
});

const assert = require("node:assert/strict");

function clock() {
  let time = 0, next = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const id = ++next; timers.set(id, { at: time + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } await new Promise(setImmediate); },
  };
}
const scope = { workspaceId: "ws-a", taskId: "task-a", runId: "run-a" };
const draft = (name) => ({ id: "team-a", workspace_id: "ws-a", revision: 1, name: "Team", worker_limit: 2,
  nodes: [{ id: "lead", role: "planner", parents: [], route: { model: "cpa/gpt-5.5", harness_id: "ao:codex" },
    settings: { name, revision: 1 } }] });

test("configuration edits coalesce at 350 ms and retain the newest draft", async () => {
  const { createLatestConfigQueue } = await import("../src/features/ao-config.ts");
  const c = clock(), calls = [];
  const q = createLatestConfigQueue({ ...c, apply: async (s, d) => { calls.push({ scope: s, draft: d }); }, onState() {} });
  q.enqueue(scope, draft("A")); await c.advance(349); assert.equal(calls.length, 0);
  q.enqueue(scope, draft("B")); await c.advance(349); assert.equal(calls.length, 0);
  await c.advance(1); assert.equal(calls.length, 1); assert.equal(calls[0].draft.nodes[0].settings.name, "B");
  q.dispose();
});

test("an in-flight response cannot discard a later draft or change its captured task", async () => {
  const { createLatestConfigQueue } = await import("../src/features/ao-config.ts");
  const c = clock(), calls = [];
  let release;
  const q = createLatestConfigQueue({ ...c, apply: async (s, d) => {
    calls.push({ scope: s, draft: d }); if (calls.length === 1) await new Promise(r => { release = r; });
  }, onState() {} });
  q.enqueue(scope, draft("A"), { immediate: true }); await c.advance(0);
  q.enqueue(scope, draft("Newest")); await c.advance(350); assert.equal(calls.length, 1);
  release(); await new Promise(setImmediate); await c.advance(0);
  assert.equal(calls.length, 2); assert.equal(calls[1].draft.nodes[0].settings.name, "Newest");
  assert.equal(calls[1].scope.taskId, "task-a");
  q.dispose();
});

test("server revision and presentation updates do not replay a configuration; dispose cancels pending work", async () => {
  const { createLatestConfigQueue } = await import("../src/features/ao-config.ts");
  const c = clock(), calls = [];
  const q = createLatestConfigQueue({ ...c, apply: async (s, d) => { calls.push(d); }, onState() {} });
  q.enqueue(scope, draft("Same"), { immediate: true }); await c.advance(0);
  const same = draft("Same"); same.revision = 9; same.nodes[0].settings.revision = 9; same.nodes[0].x = 50;
  q.enqueue(scope, same); await c.advance(350); assert.equal(calls.length, 1);
  q.enqueue(scope, draft("Pending")); q.dispose(); await c.advance(350); assert.equal(calls.length, 1);
});

test("identical configuration on a different run is not suppressed", async () => {
  const {createLatestConfigQueue}=await import("../src/features/ao-config.ts");
  const c=clock(),calls=[]; const q=createLatestConfigQueue({...c,apply:async s=>{calls.push(s.runId)},onState(){}});
  q.enqueue(scope,draft("Same"),{immediate:true}); await c.advance(0);
  q.enqueue({...scope,runId:"run-b"},draft("Same"),{immediate:true}); await c.advance(0);
  assert.deepEqual(calls,["run-a","run-b"]); q.dispose();
});
test("flush waits for the active and newest queued apply, without superseded completion events", async () => {
  const {createLatestConfigQueue}=await import("../src/features/ao-config.ts");
  const c=clock(),calls=[],states=[],releases=[];
  const q=createLatestConfigQueue({...c,apply:async(s,d)=>{calls.push(d.nodes[0].settings.name);await new Promise(r=>releases.push(r));},
    onState:s=>states.push(s)});
  q.enqueue(scope,draft("A"),{immediate:true}); await c.advance(0);
  q.enqueue(scope,draft("B")); let done=false; const flushed=q.flush(scope).then(()=>{done=true});
  await c.advance(0); assert.equal(done,false);
  releases[0](); await c.advance(0); assert.deepEqual(calls,["A","B"]); assert.equal(done,false);
  assert.equal(states.filter(s=>s.phase==="applied"&&s.draft.nodes[0].settings.name==="A").length,0);
  releases[1](); await flushed; assert.equal(done,true);
  assert.equal(states.filter(s=>s.phase==="applied"&&s.draft.nodes[0].settings.name==="B").length,1);
  q.dispose();
});
