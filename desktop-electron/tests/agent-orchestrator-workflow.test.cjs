"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createAgentOrchestratorWorkflow, resolveAoNativeConnection } = require("../electron/agent-orchestrator-workflow.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");
const { invokeContract } = require("../electron/ipc-schema.cjs");

function reconfigureWorld(observation = {status:"needs_input",turnState:"interrupted"}) {
  const calls=[];
  const node={id:"lead",role:"planner",task_id:"task",state:"running",request_key:"request-one",
    route:{harness_id:"ao:codex",model:"agent-model"},settings:{name:"Lead"},
    receipt:{thread_id:"owned",answer:"Visible file A is verified",reasoning:"PRIVATE_THINKING"},history:[]};
  const old={id:"old",workspace_id:"ws",project_id:"task",revision:1,cancelled:false,nodes:[node]};
  const other={id:"other",workspace_id:"ws",project_id:"other-task",revision:1,cancelled:false,nodes:[{...node,id:"other-lead"}]};
  let team={id:"team",workspace_id:"ws",revision:0,worker_limit:2,nodes:[{...node,task_id:"",state:"pending",receipt:null,request_key:null,route:{harness_id:"codex-native",model:"chatgpt-web/high",effort:"xhigh"}}]};
  const saved={ok:true,runs:[old,other],team,task_lifecycle:[]};
  const workflow=createAgentOrchestratorWorkflow({
    findCodexExecutable:()=>"C:/codex.exe",exists:()=>true,confirm:async()=>true,
    resolveHarness:async()=>{calls.push(["resolve-harness"]);throw Error("Harness unavailable in offline test")},
    aoHarness:{interrupt:async id=>{calls.push(["interrupt",id])},observe:async()=>observation},
    requestHeadless:async(endpoint,body,options)=>{
      calls.push([endpoint,structuredClone(body),options]);
      if(endpoint==="/api/v1/ao/read") return structuredClone(saved);
      if(endpoint==="/api/v1/ao/control"){
        const target=saved.runs.find(run=>run.id===body.run_id);target.cancelled=true;target.revision++;target.nodes.forEach(node=>node.state="cancelled");return {ok:true,run:structuredClone(target)};
      }
      if(endpoint==="/api/v1/ao/update"){
        const c=body.change;
        if(c.operation==="save_team"){team={...structuredClone(c.team),revision:team.revision+1};saved.team=team;return {ok:true,team};}
        const m=c.change;
        let life=saved.task_lifecycle[0]??{task_id:"task",workspace_id:"ws",revision:0,visibility:"active",reconfigure:[],schedule:null};
        if(m.operation==="prepare_reconfigure"){
          life.reconfigure.push({id:m.intent_id,previous_run_id:old.id,phase:"prepared",
            required_attempts:[{node_id:"lead",request_key:"request-one"}]});
        } else if(m.operation==="finish_reconfigure"){
          const next={...structuredClone(old),id:m.replacement_run_id,cancelled:false,paused:false,
            team:structuredClone(team),nodes:team.nodes.map(n=>({...n,id:"new-lead",state:"pending"}))};
          saved.runs.push(next);life.reconfigure[0].replacement_run_id=next.id;life.reconfigure[0].phase="replaced";
          life.revision++;saved.task_lifecycle=[life];return {ok:true,lifecycle:life,run:next};
        } else if(m.operation==="reconfigure_attention"){life.reconfigure[0].phase="needs_attention";}
        life.revision++;saved.task_lifecycle=[life];return {ok:true,lifecycle:life};
      }
      if(endpoint==="/api/v1/tools/call")return {ok:true,operation:{state:"completed",result:{
        ok:true,revision:1,tasks:[],task:{id:"task",title:"Original task",description:"Unchanged"}}}};
      throw Error("Unexpected endpoint "+endpoint);
    },
  });
  return {workflow,calls,saved,team};
}

test("reconfigure replaces only the captured task after acknowledged interruption and carries visible work, not private thinking", async()=>{
  const world=reconfigureWorld(),before=structuredClone(world.saved.runs[1]);
  const result=await world.workflow.call("reconfigure_run",{workspaceId:"ws",runId:"old",
    taskId:"task",intentId:"edit",team:world.team});
  assert.equal(result.previousRunId,"old");assert.notEqual(result.runId,"old");
  assert.equal(result.status,"failed");
  assert.deepEqual(world.saved.runs[1],before);
  const finish=world.calls.find(c=>c[1]?.change?.change?.operation==="finish_reconfigure")[1].change.change;
  assert.deepEqual(finish.stopped_attempts,[{node_id:"lead",request_key:"request-one"}]);
  assert.match(finish.handoff,/Visible file A/);assert.ok(!finish.handoff.includes("PRIVATE_THINKING"));
  assert.equal(result.team.nodes[0].route.effort,"xhigh");
  assert.equal(world.saved.runs.length,3);
});

test("reconfigure never creates a replacement when interruption is uncertain or the owned turn is still working", async()=>{
  const world=reconfigureWorld({status:"working",turnState:"running"});
  await assert.rejects(world.workflow.call("reconfigure_run",{workspaceId:"ws",runId:"old",
    taskId:"task",intentId:"edit",team:world.team}),/stop|working|attention/i);
  assert.equal(world.saved.runs.length,2);
  assert.ok(!world.calls.some(c=>c[1]?.change?.change?.operation==="finish_reconfigure"));
});

test("archive cannot hide a cancelled-but-still-live external turn after an uncertain reconfigure stop", async()=>{
  const world=reconfigureWorld({status:"working",turnState:"running"});
  await assert.rejects(world.workflow.call("reconfigure_run",{workspaceId:"ws",runId:"old",
    taskId:"task",intentId:"edit",team:world.team}));
  assert.equal(world.saved.runs[0].nodes[0].state,"cancelled");
  await assert.rejects(world.workflow.call("archive_task",{workspaceId:"ws",taskId:"task"}),/working|stop|attention/i);
  assert.equal(world.saved.task_lifecycle[0].visibility,"active");
  assert.ok(!world.calls.some(c=>c[1]?.change?.change?.operation==="set_visibility"));
});

test("model edits preserve missed, uncertain and cancelled schedule holds rather than launching",async()=>{
  for(const state of ["missed","needs_attention","cancelled","claimed"]){
    const world=reconfigureWorld();
    world.saved.task_lifecycle=[{workspace_id:"ws",task_id:"task",revision:0,visibility:"active",reconfigure:[],
      schedule:{id:"job",run_id:"old",state,due_at_ms:1}}];
    const result=await world.workflow.call("reconfigure_run",{workspaceId:"ws",runId:"old",taskId:"task",team:world.team});
    assert.equal(result.status,state);
    assert.ok(!world.calls.some(call=>call[0]==="resolve-harness"));
  }
});

test("an edit captured before schedule creation retargets the actual scheduled run",async()=>{
  const world=reconfigureWorld();
  world.saved.runs[0].cancelled=true;
  world.saved.runs[0].nodes[0].state="cancelled";
  const pending={...structuredClone(world.saved.runs[0]),id:"scheduled",cancelled:false,nodes:[
    {...world.saved.runs[0].nodes[0],state:"pending",request_key:null,receipt:null}]};
  world.saved.runs.push(pending);
  world.saved.task_lifecycle=[{workspace_id:"ws",task_id:"task",revision:0,visibility:"active",reconfigure:[],
    schedule:{id:"job",run_id:"scheduled",state:"scheduled",due_at_ms:9999999999999}}];
  const result=await world.workflow.call("reconfigure_run",{workspaceId:"ws",runId:"old",taskId:"task",team:world.team});
  const prepared=world.calls.find(call=>call[1]?.change?.change?.operation==="prepare_reconfigure")[1].change.change;
  assert.equal(prepared.run_id,"scheduled");
  assert.equal(result.previousRunId,"scheduled");
  world.workflow.dispose();
});

test("one-time delay validates positive integral seconds, minutes and hours", ()=>{
  const {delayToMilliseconds}=require("../electron/agent-orchestrator-workflow.cjs");
  assert.equal(delayToMilliseconds(2,"minutes"),120000);
  assert.equal(delayToMilliseconds(1,"hours"),3600000);
  for(const [value,unit] of [[0,"seconds"],[-1,"seconds"],[1.5,"seconds"],[1,"days"],[Number.MAX_SAFE_INTEGER,"hours"]])
    assert.throws(()=>delayToMilliseconds(value,unit));
});

test("future schedule wakes from current durable identity, claims once, and restart recovery does not replay", async()=>{
  let now=1000, grants=0;
  const timers=new Map();
  const mission={id:"new-config",workspace_id:"ws",project_id:"task",revision:1,cancelled:false,nodes:[
    {id:"lead",role:"planner",state:"pending",route:{harness_id:"codex-native",model:"chatgpt-web/high"}}]};
  const life={workspace_id:"ws",task_id:"task",revision:1,visibility:"active",
    schedule:{id:"job",run_id:"new-config",due_at_ms:2000,state:"scheduled",revision:1}};
  const workflow=createAgentOrchestratorWorkflow({now:()=>now,
    setTimer:fn=>{const id=timers.size+1;timers.set(id,fn);return id},clearTimer:id=>timers.delete(id),
    findCodexExecutable:()=>"C:/codex.exe",exists:()=>true,
    resolveHarness:async()=>({executable:"C:/codex.exe",expected_sha256:"a".repeat(64)}),
    requestHeadless:async(endpoint,body)=>{
      if(endpoint==="/api/v1/ao/read")return {ok:true,runs:[structuredClone(mission)],task_lifecycle:[structuredClone(life)]};
      if(endpoint==="/api/v1/ao/update"){
        const c=body.change.change;
        assert.equal(c.intent_id,"job");
        if(c.operation==="claim_schedule"){assert.equal(life.schedule.state,"scheduled");life.schedule.state="claimed";}
        else if(c.operation==="recover_schedule")life.schedule.state=c.action;
        else throw Error("unexpected schedule mutation");
        life.revision++;return {ok:true,lifecycle:structuredClone(life),run:structuredClone(mission)};
      }
      if(endpoint==="/api/v1/ao/grant"){
        grants++;mission.nodes[0].state="finished";
        return {ok:true,run:structuredClone(mission),grant:{executable_sha256:"a".repeat(64)}};
      }
      throw Error("Unexpected endpoint "+endpoint);
    },
  });
  assert.equal(typeof workflow.restoreSchedules,"function");
  await workflow.restoreSchedules([{id:"ws"}]);
  assert.equal(timers.size,1);assert.equal(grants,0);
  now=2000;const tick=[...timers.values()][0];await tick();await tick();
  assert.equal(grants,1);assert.equal(life.schedule.state,"started");
  workflow.dispose();
  life.schedule.state="claimed";life.revision++;grants=0;
  await workflow.restoreSchedules([{id:"ws"}]);
  assert.equal(life.schedule.state,"needs_attention");assert.equal(grants,0);
});

test("an invalid saved model reports a safe actionable result through IPC rather than transport failure", async()=>{
  let writes=0;
  const workflow=createAgentOrchestratorWorkflow({findCodexExecutable:()=>"C:/codex.exe",
    requestHeadless:async(endpoint)=>{
      if(endpoint==="/api/v1/ao/read")return {ok:true,runs:[],team:{id:"team",revision:1,nodes:[
        {role:"reviewer",settings:{name:"Reviewer"},route:{model:"default"}}]}};
      writes++;throw Error("must not create task or call a model");
    }});
  const host=createCodingToolsAppsHost({services:{agentOrchestrator:(operation,args)=>workflow.call(operation,args)}});
  const ipc={invoke:(_channel,payload)=>host.call(payload.moduleId,payload.operation,payload.arguments)};
  const response=await invokeContract(ipc,"apps.call",{moduleId:"agent-orchestrator",operation:"chat_send",
    arguments:{workspaceId:"ws",message:"Original user message"}});
  assert.equal(response.result.ok,false);
  assert.match(response.result.reason,/Choose an explicit model for Reviewer/);
  assert.equal(writes,0);
});

test("explicit stop revokes a pending schedule and its timer rather than leaving a scheduled ghost",async()=>{
  const timers=new Map();
  const mission={id:"r",workspace_id:"ws",project_id:"t",revision:1,cancelled:false,nodes:[{id:"p",state:"pending"}]};
  const life={workspace_id:"ws",task_id:"t",revision:1,visibility:"active",schedule:{id:"job",run_id:"r",state:"scheduled",due_at_ms:5000}};
  const workflow=createAgentOrchestratorWorkflow({now:()=>1000,setTimer:fn=>{timers.set(1,fn);return 1},clearTimer:id=>timers.delete(id),
    requestHeadless:async(endpoint,body)=>{
      if(endpoint==="/api/v1/ao/read")return {ok:true,runs:[structuredClone(mission)],task_lifecycle:[structuredClone(life)]};
      if(endpoint==="/api/v1/ao/control"){mission.cancelled=true;mission.nodes[0].state="cancelled";return {ok:true,run:structuredClone(mission)};}
      if(endpoint==="/api/v1/ao/update"){assert.equal(body.change.change.operation,"cancel_schedule");life.schedule.state="cancelled";return {ok:true,lifecycle:structuredClone(life)};}
      throw Error("Unexpected "+endpoint);
    }});
  await workflow.restoreSchedules([{id:"ws"}]);
  assert.equal(timers.size,1);
  await workflow.call("control_run",{workspaceId:"ws",runId:"r",action:"stop"});
  assert.equal(life.schedule.state,"cancelled");
  assert.equal(timers.size,0);
  workflow.dispose();
});

test("team settings use their local UI operation and cannot be changed through mission graph tools", async () => {
  const requests = [];
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: async (endpoint, body, options) => {
    requests.push({ endpoint, body, options });
    return { ok: true, team: { id: "team", workspace_id: "ws-1", revision: 1 } };
  } });
  await assert.rejects(workflow.call("update_run", { workspaceId: "ws-1", change: { operation: "set_limits", max_workers: 24 } }), /supported AO graph/);
  const result = await workflow.call("team_update", { workspaceId: "ws-1", change: { operation: "save_team", expected_revision: 0, team: { id: "team", workspace_id: "ws-1" } } });
  assert.equal(result.team.revision, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].endpoint, "/api/v1/ao/update");
  assert.deepEqual(requests[0].options, { localConfirmation: true });
  assert.equal(requests[0].body.workspace_id, "ws-1");
});

test("AO board list and detail responses remain valid across the renderer IPC boundary", async () => {
  const task = { id: "task-1", title: "Read-only task", state: "backlog", step: 0, clauses: [] };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (_endpoint, body) => ({ ok: true, operation: { state: "completed", result: {
      ok: true, revision: 1, workspace_id: "ws-1", steps: ["Plan"],
      ...(body.arguments.task_id ? { task } : { tasks: [task] }),
    } } }),
  });
  const host = createCodingToolsAppsHost({ services: {
    agentOrchestrator: (operation, args) => workflow.call(operation, args),
  } });
  const ipc = { invoke: (_channel, payload) => host.call(payload.moduleId, payload.operation, payload.arguments) };
  const list = await invokeContract(ipc, "apps.call", {
    moduleId: "agent-orchestrator", operation: "board", arguments: { workspaceId: "ws-1" },
  });
  assert.equal(list.result.tasks.length, 1);
  assert.equal(list.result.task, null);
  const detail = await invokeContract(ipc, "apps.call", {
    moduleId: "agent-orchestrator", operation: "board", arguments: { workspaceId: "ws-1", taskId: "task-1" },
  });
  assert.deepEqual(detail.result.tasks, []);
  assert.equal(detail.result.task.id, "task-1");
});

test("AO keeps manual clauses and applies revisioned mission edits without a second dialog", async () => {
  const task = { id: "old", title: "Improve workflow", state: "in_progress", step: 1, clauses: [] };
  let revision = 4;
  let grants = 0;
  let aoUpdates = 0;
  const confirmations = [];
  const requestHeadless = async (endpoint, body, options) => {
    if (endpoint === "/api/v1/ao/read") {
      assert.equal(body.workspace_id, "ws-1");
      return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", nodes: [] }], board_revision: revision };
    }
    if (endpoint === "/api/v1/ao/update") {
      assert.deepEqual(options, { localConfirmation: true });
      assert.equal(body.workspace_id, "ws-1");
      assert.equal(body.change.operation, "cancel");
      aoUpdates += 1;
      return { ok: true, run: { id: "run-1", workspace_id: "ws-1", cancelled: true } };
    }
    assert.equal(endpoint, "/api/v1/tools/call");
    const args = body.arguments;
    let result;
    if (body.tool === "workflow_list") {
      result = { ok: true, revision, workspace_id: "ws-1", steps: ["Specification", "Plan"],
        ...(args.task_id ? { task } : { tasks: [task] }) };
    } else if (body.tool === "request_permissions") {
      grants += 1;
      result = { ok: true, approval_token: "local-grant" };
    } else if (body.tool === "workflow_update" && !args.approval_token) {
      result = { ok: false, error: { code: "APPROVAL_REQUIRED", details: { request_id: "scoped-request" } } };
    } else if (body.tool === "workflow_update") {
      assert.equal(args.expected_revision, 4);
      assert.equal(args.approval_token, "local-grant");
      assert.equal(args.change.operation, "append_clauses");
      task.clauses = args.change.clauses.map((clause, index) => ({
        id: `clause-${index}`, ...clause, state: "backlog",
      }));
      revision += 1;
      result = { ok: true };
    } else {
      throw new Error("Unexpected tool");
    }
    return { ok: true, operation: { state: "completed", result } };
  };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless,
    cpaConnection: () => { throw new Error("CPA is not an AO planner"); },
    confirm: async (prompt) => { confirmations.push(prompt.message); return true; },
    fetchImpl: () => { throw new Error("AO board must not call a model"); },
  });
  const host = createCodingToolsAppsHost({
    services: { agentOrchestrator: (operation, args) => workflow.call(operation, args) },
  });
  assert.ok(host.list().modules.some((module) => module.id === "agent-orchestrator"));
  assert.equal(host.catalog().modules.find((module) => module.id === "agent-orchestrator")
    .operations.some((operation) => operation.name === "plan"), false);
  assert.equal(host.catalog().modules.find((module) => module.id === "agent-orchestrator")
    .operations.find((operation) => operation.name === "run_status")?.readOnly, true);
  assert.equal(host.catalog().modules.find((module) => module.id === "agent-orchestrator")
    .operations.find((operation) => operation.name === "start_run")?.readOnly, false);
  const saved = (await host.call("agent-orchestrator", "append", {
    workspaceId: "ws-1", taskId: "old", expectedRevision: 4,
    clauses: [{ title: "Plan boundaries", detail: "List scopes" }],
  })).result;
  assert.equal(saved.revision, 5);
  assert.equal(task.clauses.length, 1);
  assert.equal(grants, 1);
  const runs = (await host.call("agent-orchestrator", "runs", { workspaceId: "ws-1" })).result;
  assert.equal(runs.runs[0].id, "run-1");
  const changed = (await host.call("agent-orchestrator", "update_run", {
    workspaceId: "ws-1",
    change: { operation: "cancel", run_id: "run-1", expected_revision: 1 },
  })).result;
  assert.equal(changed.run.cancelled, true);
  assert.equal(aoUpdates, 1);
  assert.deepEqual(confirmations, ["Add clauses to this Coding Tools plan?"]);
});

test("AO readiness requires both the task and its clauses to be complete", () => {
  const { presentTask } = require("../../app-handler/agent-orchestrator/kanban.cjs");
  const task = { state: "done", step: 7, clauses: [{ state: "backlog" }] };
  assert.equal(presentTask(task).lane, "needs_review");
  task.state = "in_progress";
  task.clauses[0].state = "done";
  assert.equal(presentTask(task).lane, "needs_review");
  task.state = "done";
  assert.equal(presentTask(task).lane, "ready");
});

test("AO worker passes the managed CPA key to its child only after exact-model and local approval", async () => {
  const sentinel = "SENTINEL_KEY_DO_NOT_LOG_1234567890";
  const calls = [];
  const confirmations = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", nodes: [{
          id: "worker", role: "worker", state: "pending",
          route: { harness_id: "codex-native", provider_id: "cliproxyapi-antigravity",
            account_id: "shared-cpa-pool", model: "gemini-3.8-flash-high",
            permission_profile: ":read-only" },
        }],
      }] };
      assert.equal(endpoint, "/api/v1/ao/harness/connect");
      calls.push({ body, options });
      return { ok: true, owned: true, route_verified: false,
        status: { connected: true, model: "gemini-3.8-flash-high" } };
    },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: sentinel }),
    resolveHarness: async ({ model }) => ({ executable: "C:\\codex.exe", expected_sha256: "0".repeat(64),
      codex_home: "C:\\ao-home", model, allow_model_usage: true,
      allow_command_execution: false, permission_profile: ":read-only",
      request_limit: 2, lifetime_seconds: 120 }),
    confirm: async (details) => { confirmations.push(details); return true; },
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8317/v1/models");
      assert.equal(options.headers.Authorization, `Bearer ${sentinel}`);
      return { ok: true, json: async () => ({ data: [{ id: "gemini-3.8-flash-high" }] }) };
    },
  });
  await assert.rejects(workflow.call("connect_harness", {
    workspaceId: "ws-1", runId: "run-1", nodeId: "worker", executable: "C:\\codex.exe",
    proxyApiKey: sentinel,
  }), /renderer credential/i);
  assert.equal(calls.length, 0);
  const result = await workflow.call("connect_harness", {
    workspaceId: "ws-1", runId: "run-1", nodeId: "worker", executable: "C:\\codex.exe",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { localConfirmation: true });
  assert.equal(calls[0].body.private_proxy_api_key, sentinel);
  assert.equal(calls[0].body.connection.model, "gemini-3.8-flash-high");
  assert.equal(result.status.model, "gemini-3.8-flash-high");
  assert.equal(JSON.stringify({ result, confirmations }).includes(sentinel), false);
});

test("AO WebGPT connect uses the selected Codex bundled catalog without a CPA key", async () => {
  const calls = [];
  let confirmed = false;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", nodes: [{ id: "planner", role: "planner", state: "pending",
          route: { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
            model: "chatgpt-web/high", permission_profile: ":read-only" } }],
      }] };
      calls.push(body);
      return { ok: true, owned: true, status: { model: "chatgpt-web/high" } };
    },
    cpaConnection: () => { throw new Error("WebGPT must not request a CPA key"); },
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    webModelCatalog: async ({ executable, model }) => {
      assert.equal(confirmed, true, "do not launch a selected executable before local approval");
      assert.equal(executable, "C:\\codex.exe");
      assert.equal(model, "chatgpt-web/high");
      return { models: [{ slug: "chatgpt-web/high", visibility: "list" }] };
    },
    resolveHarness: async () => ({ executable: "C:\\codex.exe", expected_sha256: "0".repeat(64),
      codex_home: "C:\\ao-home", model: "chatgpt-web/high", allow_model_usage: true,
      allow_command_execution: false, permission_profile: ":read-only", request_limit: 2, lifetime_seconds: 120 }),
    confirm: async () => { confirmed = true; return true; },
    fetchImpl: async () => { throw new Error("AO WebGPT catalog must not require a bearer token"); },
  });
  await workflow.call("connect_harness", {
    workspaceId: "ws-1", runId: "run-1", nodeId: "planner", executable: "C:\\codex.exe",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].web_bridge_base_url, "http://127.0.0.1:17841/v1");
  assert.deepEqual(calls[0].web_model_catalog, { models: [{ slug: "chatgpt-web/high", visibility: "list" }] });
  assert.equal(calls[0].private_proxy_api_key, undefined);
});

test("AO WebGPT catalog serves Luna from a Luna-only account's template and renames any tier", () => {
  const { aoWebCatalogForModel } = require("../electron/agent-orchestrator-workflow.cjs");
  // A Free/Go (Luna-only) account's runtime has no High row; its Luna row is the template.
  const luna = { slug: "chatgpt-web/luna", display_name: "ChatGPT Web — Luna", context_window: 1050000 };
  assert.deepEqual(aoWebCatalogForModel({ models: [luna] }, "chatgpt-web/luna"), { models: [luna] });
  assert.deepEqual(aoWebCatalogForModel({ models: [luna] }, "chatgpt-web/think").models[0],
    { ...luna, slug: "chatgpt-web/think", display_name: "ChatGPT Web — Think" });
  const high = { slug: "chatgpt-web/high", display_name: "ChatGPT Web — High" };
  assert.deepEqual(aoWebCatalogForModel({ models: [high] }, "chatgpt-web/luna").models[0],
    { ...high, slug: "chatgpt-web/luna", display_name: "ChatGPT Web — Luna" });
  assert.deepEqual(aoWebCatalogForModel({ models: [high] }, "chatgpt-web/extra-high").models[0].display_name, "ChatGPT Web — Extra High");
  assert.throws(() => aoWebCatalogForModel({ models: [high] }, "gpt-5.5"), /invalid/);
  assert.throws(() => aoWebCatalogForModel({ models: [{ slug: "gpt-5.5" }] }, "chatgpt-web/luna"), /unavailable/);
  assert.throws(() => aoWebCatalogForModel({ models: [high, luna] }, "chatgpt-web/luna"), /unavailable/);
});

test("the desktop main process builds the AO WebGPT catalog through the shared tier helper", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  assert.match(main, /aoWebCatalogForModel\(JSON\.parse\(result\.stdout\), model\)/);
  assert.doesNotMatch(main, /catalog\.models\[0\]\?\.slug !== "chatgpt-web\/high"/);
  const cli = fs.readFileSync(path.join(__dirname, "../../runtime-web/src/cli.ts"), "utf8");
  assert.match(cli, /"chatgpt-web\/luna"/, "a Luna-only account still yields an AO WebGPT template");
});

test("a Luna orchestrator card connects on the Luna tier", async () => {
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", nodes: [{ id: "planner", role: "planner", state: "pending",
          route: { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
            model: "chatgpt-web/luna", permission_profile: ":read-only" } }],
      }] };
      calls.push(body);
      return { ok: true, owned: true, status: { model: "chatgpt-web/luna" } };
    },
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    webModelCatalog: async ({ model }) => ({ models: [{ slug: model }] }),
    resolveHarness: async ({ model, permissionProfile }) => ({ executable: "C:\\codex.exe", expected_sha256: "0".repeat(64),
      codex_home: "C:\\ao-home", model, allow_model_usage: true,
      allow_command_execution: false, permission_profile: permissionProfile, request_limit: 2, lifetime_seconds: 120 }),
    confirm: async () => true,
  });
  const result = await workflow.call("connect_harness", { workspaceId: "ws-1", runId: "run-1", nodeId: "planner", executable: "C:\\codex.exe" });
  assert.equal(result.status.model, "chatgpt-web/luna");
  assert.equal(calls[0].connection.model, "chatgpt-web/luna");
  assert.deepEqual(calls[0].web_model_catalog, { models: [{ slug: "chatgpt-web/luna" }] });
});

test("the role inspector lets every role choose any harness and model", () => {
  const editor = fs.readFileSync(path.join(__dirname, "../src/features/AgentOrchestratorRoleEditor.tsx"), "utf8");
  assert.doesNotMatch(editor, /<span className="ao-chip">WebGPT High<\/span>/, "no fixed WebGPT High chip for non-workers");
  assert.match(editor, /<HarnessPicker route=\{role\.route\} harnesses=\{harnesses\}/, "orchestrator and reviewer see every harness");
  assert.doesNotMatch(editor, /item\.id === NATIVE_HARNESS\)/, "no role is limited to Native Codex");
  const team = fs.readFileSync(path.join(__dirname, "../src/features/AgentOrchestratorTeam.tsx"), "utf8");
  assert.doesNotMatch(team, /nativeOnly/, "the team editor offers every harness too");
  const surface = fs.readFileSync(path.join(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  assert.doesNotMatch(surface, /node\.route\.model === "chatgpt-web\/high" \? "WebGPT High"/, "cards name the chosen tier");
});

test("AO native resolver pins an executable and a distinct unopened home per node", async () => {
  const root = path.resolve(__dirname, "../../aiTemp/ao-native-resolver-tests", `${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const executable = path.join(root, "codex.exe");
  fs.writeFileSync(executable, "MZ fixture");
  const userData = path.join(root, "user-data");
  const input = { workspaceId: "qa", runId: "run-1", nodeId: "worker-a", executable,
    model: "gemini-3.8-flash-high", userData };
  const first = await resolveAoNativeConnection(input);
  const second = await resolveAoNativeConnection({ ...input, nodeId: "worker-b" });
  assert.equal(first.executable, fs.realpathSync.native(executable));
  assert.equal(first.expected_sha256, crypto.createHash("sha256").update("MZ fixture").digest("hex"));
  assert.equal(path.dirname(first.codex_home), path.join(userData, "headless", "ao-homes"));
  assert.match(path.basename(first.codex_home), /^[a-f0-9]{64}$/);
  assert.notEqual(first.codex_home, second.codex_home);
  assert.equal(fs.existsSync(first.codex_home), false, "inspection must not create an AO home before approval");
  assert.equal(first.permission_profile, ":read-only");
  assert.equal(first.allow_command_execution, false);
  // Keep the exact native profile and reviewer; native metadata enforces managed availability.
  const writable = await resolveAoNativeConnection({ ...input, permissionProfile: ":workspace" });
  assert.equal(writable.permission_profile, ":workspace");
  assert.equal(writable.allow_command_execution, false);
  assert.equal(Object.hasOwn(first, "approval_policy"), false, "legacy grants retain absent policy fields");
  for (const permissionProfile of [":danger-full-access", "custom-profile"]) {
    const selected = await resolveAoNativeConnection({ ...input, permissionProfile,
      approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    assert.equal(selected.permission_profile, permissionProfile);
    assert.equal(selected.approval_policy, "on-request");
    assert.equal(selected.approvals_reviewer, "auto_review");
    assert.equal(selected.allow_command_execution, false);
  }
  await assert.rejects(resolveAoNativeConnection({ ...input, approvalPolicy: "always" }), /policy/i);
  await assert.rejects(resolveAoNativeConnection({ ...input, approvalPolicy: "never", approvalsReviewer: "auto_review" }), /review/i);
  await assert.rejects(resolveAoNativeConnection({ ...input, permissionProfile: ":ao-default" }), /profile/i);
  fs.rmSync(root, { recursive: true, force: true });
  await assert.rejects(resolveAoNativeConnection({ ...input, executable: "relative-codex.exe" }), /absolute/i);
});

test("AO advances only a ready card and observes an existing reservation without replay", async () => {
  const calls = [];
  let state = "pending";
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", revision: 3, cancelled: false, nodes: [
          { id: "planner", role: "planner", task_id: "task-1", parents: [], state,
            route: { provider_id: "chatgpt-web", model: "chatgpt-web/high" } },
          { id: "worker", role: "worker", task_id: "task-1", parents: ["planner"], state: "pending",
            route: { provider_id: "cliproxyapi-antigravity", model: "gemini-3.8-flash-high" } },
        ],
      }] };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, owned: true,
        status: { connected: true, model: "chatgpt-web/high" } };
      if (endpoint === "/api/v1/ao/harness/execute") {
        assert.deepEqual(options, { localConfirmation: true });
        assert.equal(body.expected_revision, 3);
        assert.equal(body.node_id, "planner");
        state = "reserved";
        return { ok: true, receipt: { status: "submitted" } };
      }
      if (endpoint === "/api/v1/ao/harness/observe") return { ok: true,
        receipt: { status: "submitted" } };
      throw new Error(`Unexpected AO endpoint ${endpoint}`);
    },
    cpaConnection: () => { throw new Error("Planner must not use CPA"); },
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    confirm: async () => true,
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  const host = createCodingToolsAppsHost({
    services: { agentOrchestrator: (operation, args) => workflow.call(operation, args) },
  });
  assert.equal((await host.call("agent-orchestrator", "advance", input)).result.receipt.status, "submitted");
  assert.equal((await workflow.call("advance", input)).receipt.status, "submitted");
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/harness/execute").length, 1);
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/harness/observe").length, 1);
});

test("a held sibling does not block an independent ready AO worker", async () => {
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", revision: 8, cancelled: false, nodes: [
          { id: "planner", state: "finished", parents: [] },
          { id: "held", state: "held", parents: ["planner"] },
          { id: "ready", role: "worker", state: "pending", parents: ["planner"],
            route: { model: "gemini-3.8-flash-high" } },
        ],
      }] };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true,
        status: { connected: true, model: "gemini-3.8-flash-high" } };
      if (endpoint === "/api/v1/ao/harness/execute") return { ok: true,
        receipt: { status: "submitted" } };
      throw new Error(`Unexpected AO endpoint ${endpoint}`);
    },
    confirm: async () => true,
  });
  await workflow.call("advance", { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" });
  assert.equal(calls.some((call) => call.endpoint === "/api/v1/ao/harness/observe"), false);
  assert.equal(calls.find((call) => call.endpoint === "/api/v1/ao/harness/execute")?.body.node_id, "ready");
});

test("AO tool approval is scoped to a visible pending request and needs local confirmation", async () => {
  const calls = [];
  const prompts = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: {
        pending_approvals: [{ approval_id: "approval-1", kind: "command", command: "Get-Content tool-check.txt", cwd: "C:\\project", reason: "Read file", permissions: { additionalPermissions: null, networkApprovalContext: null } }],
      } };
      if (endpoint === "/api/v1/ao/harness/approval") return { ok: true,
        result: { ok: true, approved: false, scope: "once" } };
      throw new Error(`Unexpected AO endpoint ${endpoint}`);
    },
    confirm: async prompt => { prompts.push(prompt); return true; },
  });
  const input = { workspaceId: "ws-1", runId: "run-1", nodeId: "planner", approvalId: "approval-1", allow: false };
  await assert.rejects(workflow.call("approve_harness", { ...input, approvalId: "forged" }), /pending/i);
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/harness/approval").length, 0);
  const result = await workflow.call("approve_harness", input);
  assert.equal(result.result.approved, false);
  const approved = calls.find((item) => item.endpoint === "/api/v1/ao/harness/approval");
  assert.deepEqual(approved.options, { localConfirmation: true });
  assert.equal(approved.body.allow, false);
  assert.equal(approved.body.approval_id, "approval-1");
  assert.match(prompts[0].detail, /Get-Content tool-check\.txt/);
  assert.match(prompts[0].detail, /C:\\project/);
  assert.doesNotMatch(JSON.stringify(approved.body), /acceptForSession|execpolicy/);
});

test("AO granted run dispatches parallel workers after focus loss and finishes each saved stage once", async () => {
  const roles = ["planner", "worker", "reviewer"];
  const nodes = roles.map((role, index) => ({
    id: role, role, state: "pending", parents: index ? [roles[index - 1]] : [],
    route: role === "worker"
      ? { harness_id: "codex-native", provider_id: "cliproxyapi-antigravity", account_id: "shared-cpa-pool", model: "gemini-3.8-flash-high", permission_profile: ":read-only" }
      : { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only" },
  }));
  const run = { id: "run-1", workspace_id: "ws-1", project_id: "project-1", revision: 3, cancelled: false, nodes };
  nodes.splice(2, 0, { ...structuredClone(nodes[1]), id: "worker-two" });
  nodes[3].parents = ["worker", "worker-two"];
  let workersLaunched = 0;
  let peakWorkers = 0;
  const calls = [];
  let focused = true;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 2 - nodes.filter(node => node.role === "worker" && node.state === "running").length } };
      if (endpoint === "/api/v1/ao/grant") {
        assert.equal(focused, true);
        assert.deepEqual(options, { localConfirmation: true });
        assert.equal(body.expected_revision, 3);
        assert.equal(body.executable_sha256, "a".repeat(64));
        focused = false;
        return { ok: true, run: structuredClone(run), grant: { executable_sha256: "a".repeat(64) } };
      }
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: true,
        model: nodes.find(node => node.id === body.node_id).route.model, permission_profile: ":danger-full-access" } };
      if (endpoint === "/api/v1/ao/harness/connect") {
        assert.equal(body.connection.permission_profile, ":read-only", "stale idle policy is replaced through the existing exact graph grant");
        assert.equal(focused, false);
        assert.equal(body.confirm, false);
        assert.equal(options?.localConfirmation, undefined);
        return { ok: true, owned: true, status: { connected: true, model: body.connection.model } };
      }
      if (endpoint === "/api/v1/ao/harness/execute") {
        assert.equal(focused, false);
        assert.equal(body.confirm, false);
        assert.equal(options?.localConfirmation, undefined);
        const node = nodes.find((entry) => entry.id === body.node_id);
        assert.equal(node.state, "pending");
        node.state = "running";
        if (node.role === "worker") { workersLaunched++; peakWorkers = Math.max(peakWorkers, nodes.filter(node => node.role === "worker" && node.state === "running").length); }
        node.receipt = { status: "submitted" };
        run.revision += 1;
        return { ok: true, run: structuredClone(run), receipt: node.receipt };
      }
      if (endpoint === "/api/v1/ao/harness/observe") {
        const node = nodes.find((entry) => entry.id === body.node_id);
        if (node.role === "worker" && workersLaunched < 2) return { ok: true, run: structuredClone(run), receipt: node.receipt };
        node.state = "finished";
        node.receipt = { status: "completed", answer: "READY" };
        run.revision += 1;
        return { ok: true, run: structuredClone(run), receipt: node.receipt };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "SENTINEL_PRIVATE_KEY_12345678901234567890" }),
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    webModelCatalog: async () => ({ models: [{ slug: "chatgpt-web/high" }] }),
    resolveHarness: async ({ model }) => ({ executable: "C:\\codex.exe", expected_sha256: "a".repeat(64),
      codex_home: "C:\\ao-home", model, allow_model_usage: true,
      allow_command_execution: false, permission_profile: ":read-only", request_limit: 3, lifetime_seconds: 900 }),
    confirm: async () => { throw new Error("Start mission must not open a second confirmation dialog"); },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "gemini-3.8-flash-high" }] }) }),
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  await assert.rejects(workflow.call("start_run", { ...input, proxyApiKey: "SENTINEL_PRIVATE_KEY" }), /renderer credential/i);
  assert.equal(calls.length, 0);
  assert.deepEqual(await workflow.call("start_run", input), { ok: true, started: true, status: "running" });
  assert.equal((await workflow.call("start_run", input)).started, false, "duplicate clicks do not create a second loop");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await workflow.call("run_status", input)).status === "finished") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await workflow.call("run_status", input)).status, "finished");
  assert.deepEqual(calls.filter((item) => item.endpoint === "/api/v1/ao/harness/execute").map((item) => item.body.node_id), ["planner", "worker", "worker-two", "reviewer"]);
  assert.equal(peakWorkers, 2);
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/grant").length, 1);
  assert.equal(JSON.stringify(await workflow.call("run_status", input)).includes("SENTINEL_PRIVATE_KEY"), false);
});

test("AO restart sees a reserved turn as held and never resubmits it", async () => {
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{
        id: "run-1", workspace_id: "ws-1", revision: 5, cancelled: false,
        nodes: [{ id: "planner", role: "planner", state: "reserved", parents: [],
          receipt: { request_key: "ao-first-send", status: "reserved" } }],
      }] };
      throw new Error("A reserved turn must not be sent again");
    },
    confirm: async () => { throw new Error("Do not request another grant for a reserved turn"); },
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  assert.deepEqual(await workflow.call("run_status", input), { ok: true, status: "held", driven: false },
    "after a restart nothing drives the run; the chat settles its cards by observing them");
  await assert.rejects(workflow.call("start_run", input), /active or unresolved card/i);
  assert.deepEqual(calls, ["/api/v1/ao/read", "/api/v1/ao/read"]);
});

test("AO explicit resume observes an existing granted turn without a new grant or send", async () => {
  const route = { model: "chatgpt-web/high" };
  const nodes = [
    { id: "planner", state: "finished", parents: [], route },
    { id: "worker", state: "finished", parents: ["planner"], route },
    { id: "reviewer", role: "reviewer", state: "running", parents: ["worker"],
      route, receipt: { request_key: "ao-original-send", status: "submitted" } },
  ];
  const run = { id: "run-1", workspace_id: "ws-1", revision: 8, nodes,
    grant: { executable_sha256: "a".repeat(64) } };
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 3 } };
      if (endpoint === "/api/v1/ao/harness/observe") {
        nodes[2].state = "finished";
        return { ok: true, run: structuredClone(run), receipt: { status: "completed" } };
      }
      throw new Error("Resume must observe the original turn only");
    },
    resolveHarness: async () => ({ executable: "C:\\codex.exe", expected_sha256: "a".repeat(64) }),
    confirm: async () => true,
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  assert.equal((await workflow.call("start_run", input)).started, true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await workflow.call("run_status", input)).status === "finished") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await workflow.call("run_status", input)).status, "finished");
  assert.deepEqual(calls.filter((endpoint) => endpoint !== "/api/v1/ao/read"), ["/api/v1/ao/harness/observe"]);
});

test("AO background waits for an explicit tool decision without approving it", async () => {
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
    model: "chatgpt-web/high", permission_profile: ":read-only" };
  const nodes = [
    { id: "planner", role: "planner", state: "finished", parents: [], route },
    { id: "worker", role: "worker", state: "finished", parents: ["planner"], route },
    { id: "reviewer", role: "reviewer", state: "pending", parents: ["worker"], route },
  ];
  const run = { id: "run-1", workspace_id: "ws-1", revision: 5, nodes };
  let toolAnswered = false;
  const calls = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 3 } };
      if (endpoint === "/api/v1/ao/grant") return { ok: true, run: structuredClone(run),
        grant: { executable_sha256: "a".repeat(64) } };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: false } };
      if (endpoint === "/api/v1/ao/harness/connect") return { ok: true, status: { model: route.model } };
      if (endpoint === "/api/v1/ao/harness/execute") {
        nodes[2].state = "running";
        run.revision += 1;
        return { ok: true, run: structuredClone(run) };
      }
      if (endpoint === "/api/v1/ao/harness/observe") {
        if (toolAnswered) nodes[2].state = "finished";
        return { ok: true, run: structuredClone(run),
          pending_approvals: toolAnswered ? [] : [{ approval_id: "approval-1" }] };
      }
      throw new Error(`Unexpected ${endpoint} ${body.node_id}`);
    },
    resolveHarness: async ({ model }) => ({ executable: "C:\\codex.exe", expected_sha256: "a".repeat(64),
      model, allow_model_usage: true, allow_command_execution: false, permission_profile: ":read-only" }),
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    webModelCatalog: async () => ({ models: [{ slug: "chatgpt-web/high" }] }),
    confirm: async () => true,
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  await workflow.call("start_run", input);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await workflow.call("run_status", input)).detail === "Waiting for your tool approval") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await workflow.call("run_status", input)).detail, "Waiting for your tool approval");
  assert.equal(calls.includes("/api/v1/ao/harness/approval"), false);
  toolAnswered = true;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    if ((await workflow.call("run_status", input)).status === "finished") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await workflow.call("run_status", input)).status, "finished");
  assert.equal(calls.filter((endpoint) => endpoint === "/api/v1/ao/harness/execute").length, 1);
});

test("AO background runs report progress, approval waits and errors to the MCP event observer", async () => {
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
    model: "chatgpt-web/high", permission_profile: ":read-only" };
  const nodes = [
    { id: "planner", role: "planner", state: "finished", parents: [], route },
    { id: "reviewer", role: "reviewer", state: "pending", parents: ["planner"], route },
  ];
  const run = { id: "run-1", workspace_id: "ws-1", revision: 5, nodes };
  let toolAnswered = false;
  const reports = [];
  const make = (overrides = {}) => createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 3 }, ...overrides.read };
      if (endpoint === "/api/v1/ao/grant") return { ok: true, run: structuredClone(run), grant: { executable_sha256: "a".repeat(64) } };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: false } };
      if (endpoint === "/api/v1/ao/harness/connect") return { ok: true, status: { model: route.model } };
      if (endpoint === "/api/v1/ao/harness/execute") { nodes[1].state = "running"; run.revision += 1; return { ok: true, run: structuredClone(run) }; }
      if (endpoint === "/api/v1/ao/harness/observe") {
        if (toolAnswered) nodes[1].state = "finished";
        return { ok: true, run: structuredClone(run), pending_approvals: toolAnswered ? [] : [{ approval_id: "approval-1" }] };
      }
      throw new Error(`Unexpected ${endpoint}`);
    },
    resolveHarness: async ({ model }) => ({ executable: "C:\\codex.exe", expected_sha256: "a".repeat(64),
      model, allow_model_usage: true, allow_command_execution: false, permission_profile: ":read-only" }),
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    webModelCatalog: async () => ({ models: [{ slug: "chatgpt-web/high" }] }),
    confirm: async () => true,
    onRunState: (update) => {
      reports.push(update);
      throw new Error("observer failures never affect the run");
    },
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:\\codex.exe" };
  const workflow = make();
  await workflow.call("start_run", input);
  for (let attempt = 0; attempt < 40 && !reports.some((r) => r.attention === "pending_approval"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const waiting = reports.find((r) => r.attention === "pending_approval");
  assert.equal(waiting.workspaceId, "ws-1");
  assert.equal(waiting.runId, "run-1");
  assert.equal(waiting.status, "running");
  assert.equal(waiting.fingerprint, "planner:finished,reviewer:running");
  toolAnswered = true;
  for (let attempt = 0; attempt < 70 && reports.at(-1)?.status !== "finished"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reports.at(-1).status, "finished");
  assert.equal(reports.at(-1).attention, null);

  reports.length = 0;
  nodes[1].state = "pending";
  const broken = make({ read: { worker_capacity: undefined } });
  await broken.call("start_run", input);
  for (let attempt = 0; attempt < 40 && !reports.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reports[0].attention, "error");
  assert.equal(reports[0].status, "held");
  assert.match(reports[0].detail, /worker capacity/);
});

test("AO harness workers run as AO sessions and return their answer as the card receipt", async () => {
  const calls = [];
  const spawned = [];
  let worker = { id: "worker", role: "worker", task_id: "task-1", parents: ["planner"], state: "pending",
    route: { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "default", permission_profile: ":ao-default" } };
  let turn = { turnId: "turn-1", turnState: "running", answer: "" };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", revision: 4, cancelled: false, nodes: [
        { id: "planner", role: "planner", task_id: "task-1", parents: [], state: "finished", route: { provider_id: "chatgpt-web", model: "chatgpt-web/high" } },
        worker,
      ] }] };
      if (endpoint === "/api/v1/ao/external/reserve") {
        assert.deepEqual(options, { localConfirmation: true });
        assert.equal(body.confirm, true);
        worker = { ...worker, state: "reserved", receipt: { request_key: "ao-key", status: "reserved" } };
        return { ok: true, request_key: "ao-key", prompt: "Do the task" };
      }
      if (endpoint === "/api/v1/ao/external/submitted") {
        assert.equal(body.request_key, "ao-key");
        worker = { ...worker, state: "running", receipt: { request_key: "ao-key", status: "submitted", thread_id: body.session_id } };
        return { ok: true, run: { id: "run-1" } };
      }
      if (endpoint === "/api/v1/ao/external/terminal") {
        assert.deepEqual({ ...body }, { workspace_id: "ws-1", run_id: "run-1", node_id: "worker", session_id: "sess-1",
          turn_id: "turn-1", answer: "Done with evidence", completed: true });
        worker = { ...worker, state: "finished" };
        return { ok: true, receipt: { status: "completed" } };
      }
      throw new Error(`Unexpected AO endpoint ${endpoint}`);
    },
    aoHarness: {
      spawn: async (input) => { spawned.push(input); return "sess-1"; },
      observe: async () => turn,
      catalog: async () => [{ id: "claude-code", label: "Claude Code", installed: true, chat: true, authStatus: "authorized" },
        { id: "aider", label: "Aider", installed: true, chat: false }],
      models: async () => [{ id: "sonnet" }],
      interrupt: async () => undefined,
    },
    cpaConnection: () => { throw new Error("AO harness workers must not use CPA"); },
    confirm: async () => true,
  });
  const catalog = await workflow.call("harnesses");
  // Any installed AO agent is selectable; agents without chat mode run in their terminal UI.
  assert.deepEqual(catalog.harnesses.map((item) => [item.id, item.runnable, item.chat]),
    [["codex-native", true, undefined], ["ao:claude-code", true, true], ["ao:aider", true, false]]);
  // An agent outside the CPA gateway lists its own models; "default" is never offered.
  assert.deepEqual((await workflow.call("models", { harness: "ao:agy", workspaceId: "ws-1" })).models, ["sonnet"], "\"default\" is never offered");
  await workflow.call("advance", { workspaceId: "ws-1", runId: "run-1", executable: "C:\codex.exe" });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].agent, "claude-code");
  assert.equal(spawned[0].prompt, "Do the task");
  assert.equal((await workflow.call("observe", { workspaceId: "ws-1", runId: "run-1", nodeId: "worker" })).pending_approvals.length, 0);
  assert.equal(calls.filter((item) => item.endpoint === "/api/v1/ao/external/terminal").length, 0);
  turn = { turnId: "turn-1", turnState: "completed", answer: "Done with evidence" };
  assert.equal((await workflow.call("observe", { workspaceId: "ws-1", runId: "run-1", nodeId: "worker" })).receipt.status, "completed");
  assert.equal(calls.filter((item) => item.endpoint.startsWith("/api/v1/ao/harness/")).length, 0);
});

test("Native Codex offers every WebGPT tier, Luna included, and every CPA pool model", async () => {
  const WEB = ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro",
    "chatgpt-web/luna", "chatgpt-web/think"];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async () => { throw new Error("no headless call expected"); },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k".repeat(40) }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "gemini-3.8-flash-high" }, { id: "claude-sonnet-4-6" }, { id: "gpt-5.5" }] }) }),
    confirm: async () => true,
  });
  assert.deepEqual((await workflow.call("models", { harness: "codex-native" })).models,
    [...WEB, "gemini-3.8-flash-high", "claude-sonnet-4-6", "gpt-5.5"], "CPA pool models also run on Native Codex");
  const offline = createAgentOrchestratorWorkflow({
    requestHeadless: async () => { throw new Error("no headless call expected"); },
    cpaConnection: () => null, confirm: async () => true,
  });
  assert.deepEqual((await offline.call("models", { harness: "codex-native" })).models, WEB);
});

test("WebGPT is offered only on Native Codex; AO harnesses get every other CPA model", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async () => { throw new Error("no headless call expected"); },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k".repeat(40) }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "gemini-3.8-flash-high" }, { id: "chatgpt-web/high" }, { id: "chatgpt-web/luna" }] }) }),
    // AO's Codex agent reports WebGPT from the user's Codex config, but cannot run it.
    aoHarness: { catalog: async () => [{ id: "codex", label: "Codex", installed: true, chat: true }], models: async () => [{ id: "gpt-5.5" }, { id: "chatgpt-web/high" }] },
    confirm: async () => true,
  });
  assert.deepEqual((await workflow.call("harnesses")).harnesses.map((item) => [item.id, item.label]),
    [["codex-native", "Native Codex"], ["ao:codex", "Codex"]]);
  assert.deepEqual((await workflow.call("models", { harness: "ao:codex", workspaceId: "ws-1" })).models,
    ["gpt-5.5", "cpa/gemini-3.8-flash-high"]);
  assert.ok((await workflow.call("models", { harness: "codex-native" })).models.includes("chatgpt-web/high"));
});

test("CPA models go only to agents that can use them through the gateway", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async () => { throw new Error("no headless call expected"); },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k".repeat(40) }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "gpt-5.5" }, { id: "gemini-3.8-flash-high" }, { id: "gemini-3.1-pro-low" }] }) }),
    aoHarness: { catalog: async () => [], models: async () => [{ id: "own-model" }] },
    confirm: async () => true,
  });
  // Aider has no gateway launch support: its own models only.
  assert.deepEqual((await workflow.call("models", { harness: "ao:aider" })).models, ["own-model"]);
  // agy's gateway mode sends no tools for CPA's model names, so it keeps its own models.
  assert.deepEqual((await workflow.call("models", { harness: "ao:agy" })).models, ["own-model"]);
  // Claude Code and opencode offer only CPA models: their own aliases (fable/haiku/opus/sonnet)
  // are neither CPA nor WebGPT. Codex keeps its ChatGPT-account models next to CPA's.
  for (const harness of ["ao:claude-code", "ao:opencode"]) {
    assert.deepEqual((await workflow.call("models", { harness })).models,
      ["cpa/gpt-5.5", "cpa/gemini-3.8-flash-high", "cpa/gemini-3.1-pro-low"], harness);
  }
  assert.deepEqual((await workflow.call("models", { harness: "ao:codex" })).models,
    ["own-model", "cpa/gpt-5.5", "cpa/gemini-3.8-flash-high", "cpa/gemini-3.1-pro-low"]);
});

test("a CPA-only agent reports a CPA failure instead of falling back to its own aliases", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async () => { throw new Error("no headless call expected"); },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k".repeat(40) }),
    fetchImpl: async () => { throw new Error("CPA timed out"); },
    aoHarness: { catalog: async () => [], models: async () => [{ id: "sonnet" }] },
    confirm: async () => true,
  });
  await assert.rejects(workflow.call("models", { harness: "ao:claude-code" }), /CPA model list is unavailable: CPA timed out/);
  // Codex still has its own ChatGPT-account models when CPA is down.
  assert.deepEqual((await workflow.call("models", { harness: "ao:codex" })).models, ["sonnet"]);
});

// A fake headless service holding one workspace's board, runs and team.
function chatWorld({ runs = [], tasks = [] } = {}) {
  const state = { revision: 3, tasks: tasks.map((task) => ({ ...task })), runs, updates: [], edits: [] };
  const requestHeadless = async (endpoint, body) => {
    if (endpoint === "/api/v1/tools/call") {
      const args = body.arguments;
      if (body.tool === "workflow_list") {
        const listed = state.tasks.map(({ description, ...rest }) => rest);
        return { operation: { state: "completed", result: { ok: true, revision: state.revision, workspace_id: "ws-1", steps: [],
          ...(args.task_id ? { task: state.tasks.find((task) => task.id === args.task_id) ?? null } : { tasks: listed }) } } };
      }
      assert.equal(args.expected_revision, state.revision);
      if (args.change.operation === "create") state.tasks.push({ id: `task-${state.tasks.length + 1}`, title: args.change.title, description: args.change.description, state: "backlog", clauses: [] });
      if (args.change.operation === "edit") { state.edits.push(args.change); Object.assign(state.tasks.find((task) => task.id === args.change.id), { title: args.change.title, description: args.change.description }); }
      state.revision += 1;
      return { operation: { state: "completed", result: { ok: true } } };
    }
    if (endpoint === "/api/v1/ao/read") {
      const pending = body.run_id ? [{ id: body.run_id, workspace_id: "ws-1", revision: 1, nodes: [{ id: "lead", state: "pending", route: { model: "chatgpt-web/high" } }] }] : state.runs;
      return { ok: true, runs: pending, team: { id: "team-1", revision: 7, worker_limit: 2 } };
    }
    if (endpoint === "/api/v1/ao/update") {
      state.updates.push(body.change);
      return { ok: true, run: { id: body.change.run_id, workspace_id: "ws-1" } };
    }
    throw new Error(`unexpected ${endpoint}`);
  };
  return state.requestHeadless = requestHeadless, state;
}

test("new chats use an explicitly selected saved team and reject an unknown team before creating a task", async () => {
  const world = chatWorld();
  const request = async (endpoint, body, options) => {
    const result = await world.requestHeadless(endpoint, body, options);
    return endpoint === "/api/v1/ao/read" ? { ...result, teams: [result.team, { id: "team-2", revision: 7, worker_limit: 4 }] } : result;
  };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: request, findCodexExecutable: () => "D:/tools/codex.exe",
    resolveHarness: async () => { throw new Error("stop before execution"); },
  });
  await workflow.call("chat_send", { workspaceId: "ws-1", message: "build it", teamId: "team-2" });
  assert.equal(world.updates[0].team_id, "team-2");
  assert.equal(world.updates[0].team_revision, 7);
  assert.equal(world.updates[0].worker_limit, 4);
  const tasksBefore = world.tasks.length;
  await assert.rejects(workflow.call("chat_send", { workspaceId: "ws-1", message: "other", teamId: "missing" }), /team.*(changed|found|unavailable)/i);
  assert.equal(world.tasks.length, tasksBefore);
});

test("a first chat message creates 'New task' and starts a team run on it with the installed Codex", async () => {
  const world = chatWorld();
  const seen = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: world.requestHeadless,
    findCodexExecutable: () => "C:\Codex\codex.exe",
    resolveHarness: async (input) => { seen.push(input.executable); throw new Error("stop before the background loop"); },
  });
  const sent = await workflow.call("chat_send", { workspaceId: "ws-1", message: "fix the email dots" });
  // A failed start still returns the chat, so the UI can open it and show why.
  assert.equal(sent.taskId, "task-1");
  assert.equal(sent.status, "failed");
  assert.match(sent.detail, /stop before the background loop/);
  assert.deepEqual(world.tasks.map((task) => [task.title, task.description]), [["New task", "fix the email dots"]]);
  assert.equal(world.updates.length, 1);
  assert.equal(world.updates[0].operation, "create_from_team");
  assert.equal(world.updates[0].task_id, "task-1");
  assert.equal(world.updates[0].expected_board_revision, 4);
  assert.equal(world.updates[0].team_revision, 7);
  assert.equal(world.updates[0].worker_limit, 2);
  assert.deepEqual(seen, ["C:\Codex\codex.exe"]);
});

test("a follow-up waits for the chat's run, then extends the same task and starts a new run", async () => {
  const task = { id: "task-1", title: "Fix auth", description: "first ask", state: "in_progress", clauses: [] };
  const busy = chatWorld({ tasks: [task], runs: [{ id: "r1", project_id: "task-1", cancelled: false, nodes: [{ state: "running" }] }] });
  const blocked = createAgentOrchestratorWorkflow({ requestHeadless: busy.requestHeadless, findCodexExecutable: () => "C:\c.exe" });
  await assert.rejects(blocked.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "also add tests" }), /still running/);
  assert.equal(busy.edits.length, 0);

  const done = chatWorld({ tasks: [task], runs: [{ id: "r1", project_id: "task-1", cancelled: false, nodes: [{ state: "finished" }] }] });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: done.requestHeadless, findCodexExecutable: () => "C:\c.exe",
    resolveHarness: async () => { throw new Error("stop before the background loop"); } });
  assert.equal((await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "also add tests" })).status, "failed");
  assert.equal(done.edits.length, 1);
  assert.equal(done.edits[0].title, "Fix auth");
  assert.match(done.edits[0].description, /^first ask\n\nFollow-up \([0-9-]+ [0-9:]+ UTC\):\nalso add tests$/);
  assert.equal(done.updates[0].task_id, "task-1");
});

test("a Team follow-up in a chat whose last turn was a single model starts the team run", async () => {
  const task = { id: "task-1", title: "Fix auth", description: "first ask", state: "in_progress", clauses: [] };
  const single = { id: "r1", project_id: "task-1", execution_mode: "single", cancelled: false,
    nodes: [{ id: "one", role: "planner", state: "finished", route: { harness_id: "ao:claude-code", model: "cpa/m" }, receipt: { thread_id: "sess-1" } }] };
  const world = chatWorld({ tasks: [task], runs: [single] });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:\c.exe",
    resolveHarness: async () => { throw new Error("stop before the background loop"); } });
  // It used to compare the single card's route with the (absent) single route and throw
  // "Cannot read properties of undefined (reading 'harness_id')" on every Team send.
  const result = await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "now as a team", executionMode: "team", teamId: "team-1", teamRevision: 7 });
  assert.equal(result.status, "failed", "the team run was created (it stops at the stubbed harness)");
  assert.equal(world.edits.length, 1);
});

test("without an installed Codex a chat send explains what to set", async () => {
  const world = chatWorld();
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => null });
  await assert.rejects(workflow.call("chat_send", { workspaceId: "ws-1", message: "hi" }), /Codex CLI was not found; install it with npm install -g @openai\/codex/);
  assert.equal(world.tasks.length, 0, "nothing is created when the run could not start");
});

test("a saved codex.exe removed by a Codex update falls back to the installed one", async () => {
  const world = chatWorld();
  const seen = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: world.requestHeadless,
    findCodexExecutable: () => "C:/Codex/bin/new/codex.exe",
    exists: (file) => !file.includes("old"),
    resolveHarness: async (input) => { seen.push(input.executable); throw new Error("stop"); },
  });
  await workflow.call("chat_send", { workspaceId: "ws-1", message: "hi", executable: "C:/Codex/bin/old/codex.exe" });
  assert.deepEqual(seen, ["C:/Codex/bin/new/codex.exe"]);
  const kept = [];
  const chosen = createAgentOrchestratorWorkflow({ requestHeadless: chatWorld().requestHeadless, findCodexExecutable: () => "C:/x.exe",
    exists: () => true, resolveHarness: async (input) => { kept.push(input.executable); throw new Error("stop"); } });
  await chosen.call("chat_send", { workspaceId: "ws-1", message: "hi", executable: "D:/tools/codex.exe" });
  assert.deepEqual(kept, ["D:/tools/codex.exe"], "an existing chosen executable is kept");
});

function startableChatWorld() {
  const world = chatWorld();
  const base = world.requestHeadless;
  world.controls = [];
  world.requestHeadless = async (endpoint, body, options) => {
    if (endpoint === "/api/v1/ao/grant") return { ok: true, run: { id: body.run_id, workspace_id: "ws-1" }, grant: { executable_sha256: "a".repeat(64) } };
    if (endpoint === "/api/v1/ao/control") { world.controls.push(body.action); return { ok: true, run: { id: body.run_id, workspace_id: "ws-1", nodes: [] } }; }
    return base(endpoint, body, options);
  };
  return world;
}

async function until(check) {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("once its run starts, a 'New task' chat is renamed after what was asked", async () => {
  const world = startableChatWorld();
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: world.requestHeadless,
    findCodexExecutable: () => "C:/Codex/codex.exe",
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k" }),
    fetchImpl: async (url) => ({ ok: true, json: async () => (String(url).endsWith("/v1/models")
      ? { data: [{ id: "gpt-6-luna" }] }
      : { choices: [{ message: { content: "\"Fix unread email dots\"\n" } }] }) }),
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }),
  });
  const sent = await workflow.call("chat_send", { workspaceId: "ws-1", message: "the unread dots in email are wrong" });
  assert.equal(sent.status, "running");
  await until(() => world.edits.length > 0);
  assert.deepEqual(world.edits.map((edit) => [edit.title, edit.description]), [["Fix unread email dots", "the unread dots in email are wrong"]]);
});

test("a chat the user named keeps its name, and without CPA the message names it", async () => {
  const named = startableChatWorld();
  const options = (world) => ({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }) });
  await createAgentOrchestratorWorkflow(options(named)).call("chat_send", { workspaceId: "ws-1", title: "Mine", message: "do it" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(named.edits, []);

  const plain = startableChatWorld();
  await createAgentOrchestratorWorkflow(options(plain)).call("chat_send", { workspaceId: "ws-1", message: "add   dark mode to the settings page please now" });
  await until(() => plain.edits.length > 0);
  assert.equal(plain.edits[0].title, "add dark mode to the settings page please", "first 8 words");
});

test("starting a mission whose card is held retries that card first", async () => {
  let held = true;
  const controls = [];
  const requestHeadless = async (endpoint, body) => {
    if (endpoint === "/api/v1/ao/read") return { ok: true, team: null, runs: [{ id: "r1", workspace_id: "ws-1", revision: 2, cancelled: false,
      nodes: [{ id: "lead", state: held ? "held" : "pending", route: { model: "chatgpt-web/high" }, receipt: held ? { error: "did not confirm" } : null }] }] };
    if (endpoint === "/api/v1/ao/control") { controls.push(body.action); held = false; return { ok: true, run: { id: "r1", workspace_id: "ws-1", nodes: [] } }; }
    if (endpoint === "/api/v1/ao/grant") return { ok: true, run: { id: "r1", workspace_id: "ws-1" }, grant: { executable_sha256: "a".repeat(64) } };
    throw new Error(`unexpected ${endpoint}`);
  };
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }) });
  const started = await workflow.call("start_run", { workspaceId: "ws-1", runId: "r1" });
  assert.equal(started.status, "running");
  assert.deepEqual(controls, ["retry"]);
  await assert.rejects(workflow.call("control_run", { workspaceId: "ws-1", runId: "r1", action: "rewind" }), /Choose a mission control/);
});

function heldMissionWorld({ history = [], error = "ChatGPT did not confirm that the prompt was sent" } = {}) {
  const world = { reads: 0, controls: [], grants: 0, held: false };
  world.requestHeadless = async (endpoint, body) => {
    if (endpoint === "/api/v1/ao/read") {
      world.reads += 1;
      // The first start sees a pending card; the loop then finds it held until a retry re-queues it.
      if (world.reads === 2 && !world.controls.length) world.held = true;
      return { ok: true, team: null, worker_capacity: { r1: 1 }, runs: [{ id: "r1", workspace_id: "ws-1", project_id: "task-1", revision: 2, cancelled: false,
        nodes: [{ id: "lead", role: "planner", state: world.held ? "held" : "pending", route: { model: "chatgpt-web/high", provider_id: "chatgpt-web" },
          history, receipt: world.held ? { error } : null }] }] };
    }
    if (endpoint === "/api/v1/ao/control") { world.controls.push(body.action); world.held = false; return { ok: true, run: { id: "r1", workspace_id: "ws-1", nodes: [] } }; }
    if (endpoint === "/api/v1/ao/grant") { world.grants += 1; return { ok: true, run: { id: "r1", workspace_id: "ws-1" }, grant: { executable_sha256: "a".repeat(64) } }; }
    if (endpoint === "/api/v1/tools/call") return { operation: { state: "completed", result: { ok: true, revision: 1, workspace_id: "ws-1", steps: [], task: { id: "task-1", title: "T", description: "d" } } } };
    throw new Error(`stop at ${endpoint}`);
  };
  return world;
}

test("a held card is handed to the recovery helper, which retries it and restarts the mission", async () => {
  const world = heldMissionWorld();
  const asked = [];
  const states = [];
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k" }),
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/v1/models")) return { ok: true, json: async () => ({ data: [{ id: "gpt-6-luna" }] }) };
      asked.push(JSON.parse(init.body).messages[0].content);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"retry","reason":"The send timed out"}' } }] }) };
    },
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    onRunState: (update) => states.push(update?.detail),
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }) });
  await workflow.call("start_run", { workspaceId: "ws-1", runId: "r1" });
  await until(() => world.grants >= 2);
  assert.deepEqual(world.controls, ["retry"]);
  assert.equal(world.grants, 2, "the mission was started again after the retry");
  assert.match(asked[0], /did not confirm that the prompt was sent/);
});

test("a card interrupted by an app restart is retried directly, without asking the helper", async () => {
  const world = heldMissionWorld({ error: "The agent's process ended before it finished (the app restarted); retry this card." });
  let asked = 0;
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k" }),
    fetchImpl: async () => { asked += 1; throw new Error("the helper must not be asked"); },
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }) });
  await workflow.call("start_run", { workspaceId: "ws-1", runId: "r1" });
  await until(() => world.grants >= 2);
  assert.deepEqual(world.controls, ["retry"]);
  assert.equal(asked, 0);
});

test("the helper stops retrying a card that already failed three times", async () => {
  const world = heldMissionWorld({ history: [{}, {}] });
  let asked = 0;
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    fetchImpl: async () => { asked += 1; throw new Error("no"); },
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }) });
  await workflow.call("start_run", { workspaceId: "ws-1", runId: "r1" });
  await until(() => world.reads >= 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const status = await workflow.call("run_status", { workspaceId: "ws-1", runId: "r1" });
  assert.deepEqual(world.controls, []);
  assert.equal(asked, 0);
  assert.match(JSON.stringify(status), /failed 3 times/);
});


function failedWorkerReviewWorld({ active = false, queued = false, blocked = false, reviewerFailure = null, manual = false } = {}) {
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
    model: "chatgpt-web/high", permission_profile: ":read-only" };
  const receipt = { status: "held", error: "Worker send timed out", answer: "Partial implementation" };
  const failed = { id: "failed", role: "worker", state: manual ? "held" : "pending", parents: ["planner"],
    route, history: [{ ...receipt, error: "First send failed" }, { ...receipt, error: "Second send failed" }], receipt };
  const reviewer = { id: "reviewer", role: "reviewer", state: "pending", parents: ["failed"], route: { ...route, model: "chatgpt-web/pro" } };
  const nodes = [{ id: "planner", role: "planner", state: "finished", parents: [], route }, failed];
  if (active) nodes.push({ id: "active", role: "worker", state: "running", parents: ["planner"], route,
    receipt: { status: "submitted", request_key: "active-turn" } });
  if (queued) nodes.push({ id: "queued", role: "worker", state: "pending", parents: [blocked ? "failed" : "planner"], route });
  reviewer.parents.push(...nodes.filter(node => node.role === "worker" && node.id !== "failed").map(node => node.id));
  nodes.push(reviewer);
  const run = { id: "run-failed", workspace_id: "ws-1", project_id: "task-1", revision: 7, nodes,
    grant: { executable_sha256: "a".repeat(64) } };
  const world = { nodes, failed, reviewer, run, calls: [], reads: 0, observed: 0, released: !active, confirmations: 0 };
  world.workflow = createAgentOrchestratorWorkflow({
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    requestHeadless: async (endpoint, body, options) => {
      world.calls.push({ endpoint, body, options });
      if (endpoint === "/api/v1/ao/read") {
        if (++world.reads >= 2 && failed.state === "pending") failed.state = "held";
        return { ok: true, runs: [structuredClone(run)], worker_capacity: { [run.id]: 2 } };
      }
      if (endpoint === "/api/v1/ao/grant") return { ok: true, run: structuredClone(run), grant: run.grant };
      if (endpoint === "/api/v1/ao/control") {
        assert.equal(body.action, "review_failures");
        assert.equal(body.confirm, true);
        assert.deepEqual(options, { localConfirmation: true });
        const node = nodes.find(node => node.id === body.node_id);
        assert.equal(node.state, "held"); node.state = "failed";
        if (node.role === "worker") {
          for (const review of nodes.filter(item => ["review_split", "sub_reviewer", "reviewer"].includes(item.role))) {
            if (["finished", "held", "failed"].includes(review.state)) {
              review.history ||= []; if (review.receipt) review.history.push(review.receipt);
              review.receipt = null; review.state = "pending";
            }
          }
        }
        run.revision++;
        return { ok: true, run: structuredClone(run) };
      }
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: {
        connected: true, model: nodes.find(node => node.id === body.node_id).route.model } };
      if (endpoint === "/api/v1/ao/harness/execute") {
        const node = nodes.find(node => node.id === body.node_id);
        if (node.role === "reviewer") {
          assert.equal(failed.state, "failed");
          assert.equal(node.route.model, "chatgpt-web/pro", "use the configured reviewer, not the CPA helper");
          assert(nodes.filter(item => item.role === "worker" && item !== failed).every(item => item.state === "finished" || (item.state === "pending" && item.parents.includes("failed"))),
            "both active and queued nonfailed workers must settle before escalation");
        }
        assert.equal(node.state, "pending");
        node.state = "running";
        node.receipt = { status: "submitted" };
        run.revision++;
        return { ok: true, run: structuredClone(run), receipt: node.receipt };
      }
      if (endpoint === "/api/v1/ao/harness/observe") {
        const node = nodes.find(node => node.id === body.node_id);
        if (node.id === "active") {
          world.observed++;
          if (!world.released) return { ok: true, receipt: node.receipt };
        }
        if (node.role === "reviewer") {
          node.state = "held";
          node.receipt = reviewerFailure ? { status: "held", error: reviewerFailure }
            : { status: "held", verdict: "CHANGES_REQUIRED", answer: "CHANGES_REQUIRED wait until sign-in is restored",
              error: "Reviewer requested changes" };
        } else if (node.state === "running") {
          node.state = "finished";
          node.receipt = { status: "completed", answer: "Sibling done", turn_id: node.id + "-done" };
        }
        run.revision++;
        return { ok: true, run: structuredClone(run), receipt: node.receipt };
      }
      throw new Error("Unexpected failure-review operation: " + endpoint);
    },
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }),
    confirm: async () => { world.confirmations++; return true; },
    fetchImpl: async () => { throw new Error("Exhausted workers must use the saved reviewer route, not an unconfigured helper"); },
  });
  return world;
}

test("exhausted worker failures drain active and queued siblings before the configured reviewer", async () => {
  const world = failedWorkerReviewWorld({ active: true, queued: true });
  const input = { workspaceId: "ws-1", runId: "run-failed", executable: path.resolve("codex.exe") };
  await world.workflow.call("start_run", input);
  await until(() => world.observed > 0);
  assert.equal(world.calls.some(call => call.endpoint.endsWith("/execute") && call.body.node_id === "reviewer"), false, "no escalation while a sibling is active");
  world.released = true;
  for (let i = 0; i < 4; i++) {
    await until(() => world.reviewer.state === "held");
    if (world.reviewer.state === "held") break;
  }
  await until(() => world.calls.some(call => call.endpoint.endsWith("/execute") && call.body.node_id === "reviewer"));
  const sent = world.calls.filter(call => call.endpoint.endsWith("/execute"));
  assert.deepEqual(sent.map(call => call.body.node_id), ["queued", "reviewer"]);
  assert(sent.every(call => call.body.confirm === false && !call.options), "existing grant covers only the saved routes");
  assert.equal(world.failed.state, "failed");
  assert.equal(world.failed.history.length, 2);
  assert.equal(world.failed.receipt.answer, "Partial implementation");
  const status = await world.workflow.call("run_status", input);
  assert.equal(status.status, "held", "failed work is never a successful mission");
  assert.match(status.detail, /reviewer.*sign-in/i);
  assert.equal(world.calls.some(call => /\/grant$|\/approval$/.test(call.endpoint)), false);
  assert.equal(world.calls.filter(call => call.endpoint.endsWith("/control")).length, 1);
});

test("manual advance can review an exhausted worker only after local confirmation", async () => {
  const world = failedWorkerReviewWorld({ manual: true });
  await world.workflow.call("advance", { workspaceId: "ws-1", runId: "run-failed", executable: path.resolve("codex.exe") });
  const sent = world.calls.filter(call => call.endpoint.endsWith("/execute"));
  assert.deepEqual(sent.map(call => call.body.node_id), ["reviewer"]);
  assert.equal(world.confirmations, 2, "handoff and manual model execution each require local confirmation");
  assert.equal(sent[0].body.confirm, true);
  assert.deepEqual(sent[0].options, { localConfirmation: true });
  assert.equal(world.failed.state, "failed");
});

test("reviewer failure is bounded and blocked pending workers are not silently skipped", async () => {
  for (const blocked of [false, true]) {
    const world = failedWorkerReviewWorld({ queued: blocked, blocked, reviewerFailure: "Reviewer connection failed" });
    const input = { workspaceId: "ws-1", runId: "run-failed", executable: path.resolve("codex.exe") };
    await world.workflow.call("start_run", input);
    await until(() => world.reads >= 2);
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      if ((await world.workflow.call("run_status", input)).status === "held") break;
    }
    const status = await world.workflow.call("run_status", input);
    assert.equal(status.status, "held");
    assert.match(status.detail, /reviewer.*connection failed/i);
    const sent = world.calls.filter(call => call.endpoint.endsWith("/execute"));
    assert.deepEqual(sent.map(call => call.body.node_id), ["reviewer"]);
    assert.equal(world.failed.state, "failed");
    if (blocked) assert.equal(world.nodes.find(node => node.id === "queued").state, "pending");
    assert.equal(world.calls.some(call => /\/approval$/.test(call.endpoint)), false);
    assert.equal(world.calls.filter(call => call.endpoint.endsWith("/control")).length, 1);
  }
});

test("missions run on the Codex CLI; the desktop app's bundled codex is only a fallback", () => {
  const { findInstalledCodexExecutable } = require("../electron/agent-orchestrator-workflow.cjs");
  const root = path.resolve(__dirname, "../../aiTemp/codex-cli-discovery", `${process.pid}-${crypto.randomUUID()}`);
  const env = { APPDATA: path.join(root, "Roaming"), LOCALAPPDATA: path.join(root, "Local") };
  const desktop = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "build1", "codex.exe");
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, "MZ desktop");
  if (process.platform === "win32") assert.equal(findInstalledCodexExecutable(env), desktop, "desktop copy only when no CLI");
  const arch = process.arch === "arm64" ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"] : ["codex-win32-x64", "x86_64-pc-windows-msvc"];
  const cli = path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", arch[0], "vendor", arch[1], "bin", "codex.exe");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "MZ cli");
  if (process.platform === "win32") assert.equal(findInstalledCodexExecutable(env), cli, "the CLI wins once installed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a saved desktop-app codex.exe gives way to the Codex CLI, but another chosen codex.exe is kept", async () => {
  const local = process.env.LOCALAPPDATA || "C:/Users/test/AppData/Local";
  const desktop = path.join(local, "OpenAI", "Codex", "bin", "build1", "codex.exe");
  const cli = "C:/Users/test/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.exe";
  const seen = [];
  const make = () => createAgentOrchestratorWorkflow({ requestHeadless: chatWorld().requestHeadless,
    findCodexExecutable: () => cli, exists: () => true,
    resolveHarness: async (input) => { seen.push(input.executable); throw new Error("stop"); } });
  await make().call("chat_send", { workspaceId: "ws-1", message: "hi", executable: desktop });
  await make().call("chat_send", { workspaceId: "ws-1", message: "hi", executable: "D:/tools/codex.exe" });
  assert.deepEqual(seen, [cli, "D:/tools/codex.exe"]);
});

test("a follow-up to a chat whose last run is stuck stops that run and starts a new one", async () => {
  for (const state of ["pending", "held"]) {
    const world = chatWorld({
      tasks: [{ id: "task-1", title: "Fix dots", description: "fix the email dots", state: "backlog", clauses: [] }],
      runs: [{ id: "old-run", project_id: "task-1", workspace_id: "ws-1", revision: 4, cancelled: false,
        nodes: [{ id: "lead", state }, { id: "w1", state: "pending" }] }],
    });
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: world.requestHeadless,
      findCodexExecutable: () => "C:/Codex/codex.exe",
      resolveHarness: async () => { throw new Error("stop before the background loop"); },
    });
    const sent = await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "and the other dots" });
    assert.equal(sent.taskId, "task-1", state);
    assert.deepEqual(world.updates.map((change) => change.operation), ["cancel", "create_from_team"], state);
    assert.deepEqual(world.updates[0], { operation: "cancel", run_id: "old-run", expected_revision: 4 }, state);
    assert.match(world.tasks[0].description, /Follow-up \(.* UTC\):\nand the other dots$/, state);
  }
});

test("a follow-up still waits while the chat's last run has a card working", async () => {
  const world = chatWorld({
    tasks: [{ id: "task-1", title: "Fix dots", description: "fix the email dots", state: "backlog", clauses: [] }],
    runs: [{ id: "busy-run", project_id: "task-1", workspace_id: "ws-1", revision: 2, cancelled: false,
      nodes: [{ id: "lead", state: "finished" }, { id: "w1", state: "running" }] }],
  });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe" });
  await assert.rejects(workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "more" }), /still running/);
  assert.deepEqual(world.updates, []);
});

test("restart runs the same task again with the current team, stopping a stuck run first", async () => {
  for (const [state, cancelsFirst] of [["finished", false], ["held", true]]) {
    const world = chatWorld({
      tasks: [{ id: "task-1", title: "Fix dots", description: "fix the email dots", state: "backlog", clauses: [] }],
      runs: [{ id: "old-run", project_id: "task-1", workspace_id: "ws-1", revision: 5, cancelled: false,
        nodes: [{ id: "lead", state: "finished" }, { id: "w1", state }] }],
    });
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: world.requestHeadless,
      findCodexExecutable: () => "C:/Codex/codex.exe",
      resolveHarness: async () => { throw new Error("stop before the background loop"); },
    });
    const restarted = await workflow.call("restart_run", { workspaceId: "ws-1", runId: "old-run" });
    const expected = cancelsFirst ? ["cancel", "create_from_team"] : ["create_from_team"];
    assert.deepEqual(world.updates.map((change) => change.operation), expected, state);
    const created = world.updates.at(-1);
    assert.equal(created.task_id, "task-1", state);
    assert.equal(restarted.runId, created.run_id, state);
    assert.notEqual(restarted.runId, "old-run", state);
    assert.equal(restarted.status, "failed", "a failed start is reported, not thrown");
  }
});

test("restart refuses while the mission has a card working", async () => {
  const world = chatWorld({
    tasks: [{ id: "task-1", title: "Fix dots", description: "x", state: "backlog", clauses: [] }],
    runs: [{ id: "busy-run", project_id: "task-1", workspace_id: "ws-1", revision: 2, cancelled: false,
      nodes: [{ id: "lead", state: "finished" }, { id: "w1", state: "running" }] }],
  });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe" });
  await assert.rejects(workflow.call("restart_run", { workspaceId: "ws-1", runId: "busy-run" }), /still running/);
  assert.deepEqual(world.updates, []);
});

test("relinking or removing a working card stops its turn; an idle card is just relinked", async () => {
  for (const [state, stops] of [["running", true], ["pending", false]]) {
    const calls = [];
    const route = { harness_id: "codex-native", model: "gemini-3.8-flash-high" };
    const requestHeadless = async (endpoint, body) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", nodes: [{ id: "w2", state, route }] }] };
      if (endpoint === "/api/v1/ao/update") return { ok: true, run: { id: "run-1", workspace_id: "ws-1", nodes: [{ id: "w2", state: "pending", route }] } };
      if (endpoint === "/api/v1/ao/harness/disconnect") { assert.equal(body.node_id, "w2"); return { ok: true }; }
      throw new Error(`unexpected ${endpoint}`);
    };
    const workflow = createAgentOrchestratorWorkflow({ requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe" });
    await workflow.call("update_run", { workspaceId: "ws-1", change: { operation: "graph", run_id: "run-1",
      expected_revision: 3, change: { operation: "set_parents", node_id: "w2", parents: ["planner"] } } });
    assert.equal(calls.includes("/api/v1/ao/harness/disconnect"), stops, state);
  }
});



function retryRoleWorld(failureCount, failure = "socket disconnected") {
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only" };
  const run = { id: "policy", workspace_id: "ws-1", revision: 1, nodes: [
    { id: "lead", role: "planner", state: "finished", parents: [], route },
    { id: "worker", role: "worker", state: "pending", parents: ["lead"], route, history: [] },
    { id: "retry", role: "retry", state: "pending", parents: ["lead"], route: { ...route, model: "chatgpt-web/pro" }, history: [] },
    { id: "review", role: "reviewer", state: "pending", parents: ["worker"], route },
  ] };
  const world = { run, workerAttempts: 0, retryAttempts: 0, controls: [], grants: 0, clock: 1 };
  world.workflow = createAgentOrchestratorWorkflow({
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    requestHeadless: async (endpoint, body, options) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { policy: 1 - run.nodes.filter(node => node.role === "worker" && node.state === "running").length } };
      if (endpoint === "/api/v1/ao/grant") {
        world.grants++;
        run.grant = { executable_sha256: "a".repeat(64) };
        return { ok: true, run: structuredClone(run), grant: run.grant };
      }
      const node = run.nodes.find(node => node.id === body.node_id);
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: true, model: node.route.model } };
      if (endpoint === "/api/v1/ao/harness/execute") {
        assert.equal(body.expected_revision, run.revision);
        assert.equal(body.confirm, false);
        if (node.role === "retry") {
          assert.equal(node.route.model, "chatgpt-web/pro", "Retry uses its configured route");
          assert.equal(run.nodes[1].state, "held", "dormant Retry cannot start early");
          world.retryAttempts++;
        }
        if (node.role === "worker") world.workerAttempts++;
        node.state = "running";
        node.receipt = { request_key: node.id + "-" + world.clock, status: "submitted", started_at_ms: world.clock++ };
        run.revision++;
        return { ok: true, run: structuredClone(run) };
      }
      if (endpoint === "/api/v1/ao/harness/observe") {
        if (node.role === "worker" && world.workerAttempts <= failureCount) {
          node.state = "held";
          Object.assign(node.receipt, { status: "held", answer: "partial " + world.workerAttempts, error: failure });
        } else if (node.role === "retry") {
          node.state = "finished";
          Object.assign(node.receipt, { status: "completed", answer: '{"action":"retry","reason":"transient send failure"}' });
        } else {
          node.state = run.nodes[1].state === "failed" && node.role === "reviewer" ? "failed" : "finished";
          Object.assign(node.receipt, { status: node.state === "failed" ? "held" : "completed",
            answer: node.state === "failed" ? "CHANGES_REQUIRED partial worker evidence" : "APPROVED" });
        }
        run.revision++;
        return { ok: true, run: structuredClone(run) };
      }
      if (endpoint === "/api/v1/ao/control") {
        assert.deepEqual(options, { localConfirmation: true });
        const grant = structuredClone(run.grant);
        world.controls.push({ action: body.action, nodeId: body.node_id });
        if (body.action === "retry" || body.action === "retry_auto") {
          if (body.action === "retry_auto") assert.ok(node.role === "worker" && node.state === "held" && node.history.length < 2);
          node.history.push(node.receipt);
          node.receipt = null; node.state = "pending";
        } else if (body.action === "review_failures") node.state = "failed";
        else throw new Error("unexpected control");
        assert.deepEqual(run.grant, grant);
        run.revision++;
        return { ok: true, run: structuredClone(run) };
      }
      throw new Error(endpoint);
    },
    resolveHarness: async () => ({ executable: path.resolve("codex.exe"), expected_sha256: "a".repeat(64) }),
    fetchImpl: async () => { throw new Error("configured Retry must not invoke an unconfigured CPA helper"); },
  });
  return world;
}

test("runtime recovery executes the configured Retry role twice then reviews intact exhausted evidence", async () => {
  const world = retryRoleWorld(3);
  const input = { workspaceId: "ws-1", runId: "policy", executable: path.resolve("codex.exe") };
  await world.workflow.call("start_run", input);
  await until(() => world.run.nodes[3].state === "failed");
  assert.equal(world.workerAttempts, 3, "initial attempt plus at most two automatic retries");
  assert.equal(world.retryAttempts, 2);
  assert.equal(world.grants, 1);
  assert.equal(world.controls.filter(item => item.nodeId === "worker" && item.action === "retry_auto").length, 2);
  assert.equal(world.run.nodes[1].state, "failed");
  assert.equal(world.run.nodes[1].history.length, 2);
  assert.equal(world.run.nodes[1].receipt.answer, "partial 3");
  assert.equal((await world.workflow.call("run_status", input)).status, "failed");
});

test("runtime recovery account exhaustion goes to review without credential or policy retry", async () => {
  const world = retryRoleWorld(1, "auth_unavailable: account pool exhausted");
  const input = { workspaceId: "ws-1", runId: "policy", executable: path.resolve("codex.exe") };
  await world.workflow.call("start_run", input);
  await until(() => world.run.nodes[3].state === "failed");
  assert.equal(world.workerAttempts, 1);
  assert.equal(world.retryAttempts, 0);
  assert.equal(world.run.nodes[1].receipt.error, "auth_unavailable: account pool exhausted");
  assert.deepEqual(world.controls, [{ action: "review_failures", nodeId: "worker" }]);
});

test("runtime recovery dormant Retry does not block successful completion", async () => {
  const world = retryRoleWorld(0);
  const input = { workspaceId: "ws-1", runId: "policy", executable: path.resolve("codex.exe") };
  await world.workflow.call("start_run", input);
  await until(() => world.run.nodes[3].state === "finished");
  assert.equal(world.retryAttempts, 0);
  assert.equal(world.run.nodes[2].state, "pending");
  assert.equal((await world.workflow.call("run_status", input)).status, "finished");
});


test("final review independently returns healthy activity and coalesces a slow owned attempt", async () => {
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const counts = { slow: 0, healthy: 0 };
  let generation = 1;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async endpoint => {
      assert.equal(endpoint, "/api/v1/ao/read");
      return { ok: true, runs: [{ id: "frames", workspace_id: "ws-1", nodes: [
        { id: "slow", state: "running", route: { harness_id: "ao:codex" }, receipt: { request_key: "slow-" + generation, thread_id: "slow-" + generation } },
        { id: "healthy", state: "running", route: { harness_id: "ao:codex" }, receipt: { request_key: "healthy", thread_id: "healthy" } },
      ] }] };
    },
    aoHarness: { observe: async session => {
      if (session.startsWith("slow")) { counts.slow++; await stalled; return { turnState: "running", liveOutput: session === "slow-1" ? "old slow output" : "new slow output" }; }
      counts.healthy++; return { turnState: "running", liveOutput: "healthy current output" };
    } },
  });
  const input = { workspaceId: "ws-1", runId: "frames" };
  const first = workflow.call("activity", input);
  try {
    const frame = await Promise.race([first, new Promise(resolve => setImmediate(() => resolve(null)))]);
    assert.ok(frame, "slow sibling must not hold the activity response");
    await new Promise(resolve => setImmediate(resolve));
    const healthy = await workflow.call("activity", input);
    assert.equal(healthy.nodes.healthy.output, "healthy current output");
    await workflow.call("activity", input);
    assert.equal(counts.slow, 1, "repeat calls coalesce the same in-flight owned attempt");
    generation = 2;
    const changed = await workflow.call("activity", input);
    assert.equal(changed.nodes.slow.output, "", "new attempt must not inherit old output");
    release(); await first;
    await new Promise(resolve => setImmediate(resolve));
    const current = await workflow.call("activity", input);
    assert.notEqual(current.nodes.slow.output, "old slow output", "a late old-attempt frame cannot repopulate a new owner");
  } finally { release(); await first; }
});

test("final review refreshes an old planner-only APPROVED review for newly failed evidence", async () => {
  const world = failedWorkerReviewWorld();
  world.reviewer.parents = ["planner"];
  world.reviewer.state = "finished";
  world.reviewer.receipt = { request_key: "old-review", status: "completed", verdict: "APPROVED", answer: "APPROVED old evidence" };
  const input = { workspaceId: "ws-1", runId: "run-failed", executable: path.resolve("codex.exe") };
  await world.workflow.call("start_run", input);
  await until(() => world.calls.some(call => call.endpoint.endsWith("/execute") && call.body.node_id === "reviewer"));
  assert.equal(world.calls.filter(call => call.endpoint.endsWith("/execute") && call.body.node_id === "reviewer").length, 1,
    "new failure evidence must reach the configured reviewer even with planner-only parents");
  assert.equal(world.reviewer.history[0].answer, "APPROVED old evidence");
  assert.equal(world.failed.state, "failed");
});

test("runtime recovery launches ready siblings before a slow worker observation", async () => {
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only" };
  const run = { id: "wave", workspace_id: "ws-1", revision: 1, nodes: [
    { id: "lead", role: "planner", state: "finished", parents: [], route },
    { id: "one", role: "worker", state: "pending", parents: ["lead"], route },
    { id: "two", role: "worker", state: "pending", parents: ["lead"], route },
    { id: "review", role: "reviewer", state: "pending", parents: ["one", "two"], route },
  ] };
  const sent = [];
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const workflow = createAgentOrchestratorWorkflow({
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { wave: 2 - run.nodes.filter(node => node.role === "worker" && node.state === "running").length } };
      if (endpoint === "/api/v1/ao/grant") {
        run.grant = { executable_sha256: "a".repeat(64) };
        return { ok: true, run: structuredClone(run), grant: run.grant };
      }
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: { connected: true, model: route.model } };
      if (endpoint === "/api/v1/ao/harness/execute") {
        assert.equal(body.expected_revision, run.revision, "launch revisions are serialized");
        const node = run.nodes.find(node => node.id === body.node_id);
        node.state = "running"; run.revision++; sent.push(node.id);
        return { ok: true, run: structuredClone(run) };
      }
      if (endpoint === "/api/v1/ao/harness/observe") {
        if (body.node_id === "one") await stalled;
        return { ok: true, run: structuredClone(run) };
      }
      if (endpoint === "/api/v1/ao/control") { run.cancelled = true; return { ok: true, run: structuredClone(run) }; }
      throw new Error(endpoint);
    },
    resolveHarness: async () => ({ executable: path.resolve("codex.exe"), expected_sha256: "a".repeat(64) }),
  });
  try {
    await workflow.call("start_run", { workspaceId: "ws-1", runId: "wave", executable: path.resolve("codex.exe") });
    await until(() => sent.includes("two"));
    assert.deepEqual(sent, ["one", "two"], "second worker is sent while first observe remains unresolved");
  } finally {
    await workflow.call("control_run", { workspaceId: "ws-1", runId: "wave", action: "stop" });
    release();
  }
});

test("runtime recovery defers startup but returns saved chat IDs immediately", async () => {
  const world = chatWorld();
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: world.requestHeadless, findCodexExecutable: () => path.resolve("codex.exe"),
    resolveHarness: async () => { await stalled; throw new Error("approval expired before startup"); },
  });
  const sent = workflow.call("chat_send", { workspaceId: "ws-1", message: "build it", teamId: "team-1", teamRevision: 7, deferStart: true });
  try {
    const result = await Promise.race([sent, new Promise(resolve => setTimeout(() => resolve(null), 80))]);
    assert.equal(result?.status, "starting");
    assert.equal(result.taskId, "task-1");
    assert.equal(result.run.id, result.runId);
    assert.equal((await workflow.call("run_status", { workspaceId: "ws-1", runId: result.runId })).status, "starting");
  } finally { release(); await sent; }
});

test("runtime recovery rejects a stale selected team revision before task writes", async () => {
  const world = chatWorld();
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless,
    findCodexExecutable: () => path.resolve("codex.exe"), resolveHarness: async () => { throw new Error("not reached"); } });
  await assert.rejects(workflow.call("chat_send", { workspaceId: "ws-1", message: "build it", teamId: "team-1", teamRevision: 6, deferStart: true }), /team.*revision|team.*changed/i);
  assert.equal(world.tasks.length, 0);
  assert.equal(world.updates.length, 0);
});

test("runtime recovery activity exposes only bounded sanitized current output", async () => {
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async endpoint => {
      assert.equal(endpoint, "/api/v1/ao/read");
      return { ok: true, runs: [{ id: "live", workspace_id: "ws-1", nodes: [
        { id: "worker", state: "running", route: { harness_id: "ao:codex" }, receipt: { thread_id: "session" } },
      ] }] };
    },
    aoHarness: { observe: async () => ({ turnState: "running", answer: "partial answer Bearer SECRET_TOKEN sk-privatekey " + "x".repeat(10_000), error: "oops sk-privatekey" }) },
  });
  await workflow.call("activity", { workspaceId: "ws-1", runId: "live" });
  await new Promise(resolve => setImmediate(resolve));
  const live = await workflow.call("activity", { workspaceId: "ws-1", runId: "live" });
  assert.match(live.nodes.worker.output, /partial answer/);
  assert.ok(live.nodes.worker.output.length <= 4096);
  assert.doesNotMatch(JSON.stringify(live), /SECRET_TOKEN|sk-privatekey/);
});

test("activity reports each working card's runtime and current step without advancing the run", async () => {
  const calls = [];
  const native = { id: "w1", role: "worker", state: "running", route: { harness_id: "codex-native", provider_id: "chatgpt-web", model: "chatgpt-web/high" },
    receipt: { status: "submitted", thread_id: "thread-1", started_at_ms: 1_000 } };
  const stuck = { id: "w2", role: "worker", state: "running", route: { harness_id: "codex-native", provider_id: "chatgpt-web", model: "chatgpt-web/high" },
    receipt: { status: "submitted", thread_id: "thread-2", started_at_ms: 2_000 } };
  const agent = { id: "w3", role: "worker", state: "running", route: { harness_id: "ao:codex", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gpt-6-luna", permission_profile: ":ao-default" },
    receipt: { status: "submitted", thread_id: "sess-3" } };
  const done = { id: "p", role: "planner", state: "finished", route: native.route, receipt: { status: "completed" } };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      calls.push(endpoint);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", nodes: [done, native, stuck, agent] }] };
      if (endpoint === "/api/v1/ao/harness/status") {
        return { ok: true, status: { connected: true, live_output: body.node_id === "w1" ? "native partial Bearer SECRET_TOKEN" : "", threads: body.node_id === "w1"
          ? [{ id: "thread-1", turn_id: "turn-1", activity: "running a command", activity_at_ms: 5_000, last_event_at_ms: 6_000 }]
          : [{ id: "thread-2", turn_id: null, activity: null, started_at_ms: 2_000 }] } };
      }
      throw new Error(`unexpected ${endpoint}`);
    },
    aoHarness: { observe: async () => ({ turnState: "running", turnId: "t-3" }) },
    confirm: async () => true,
  });
  await workflow.call("activity", { workspaceId: "ws-1", runId: "run-1" });
  await new Promise(resolve => setImmediate(resolve));
  const result = await workflow.call("activity", { workspaceId: "ws-1", runId: "run-1" });
  assert.deepEqual(Object.keys(result.nodes).sort(), ["w1", "w2", "w3"], "only working cards");
  assert.equal(result.nodes.w1.activity, "running a command");
  assert.equal(result.nodes.w1.output, "native partial [redacted]");
  assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN/);
  assert.equal(result.nodes.w1.last_event_at_ms, 6_000);
  assert.equal(result.nodes.w1.started_at_ms, 1_000);
  assert.equal(result.nodes.w2.activity, "waiting for the turn to start");
  assert.equal(result.nodes.w2.turn_started, false);
  assert.equal(result.nodes.w3.activity, "running");
  assert.ok(calls.every((endpoint) => endpoint === "/api/v1/ao/read" || endpoint === "/api/v1/ao/harness/status"), "read-only calls only");
});

test("AO chat reads native managed capability for exactly one consented node", async () => {
  const calls = [];
  const capability = { supported: true, profiles: [{ id: ":workspace", allowed: true }],
    requirements: {}, approval_policies: ["on-request", "never"], approvals_reviewers: ["user", "auto_review"] };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => { calls.push({ endpoint, body }); return { ok: true, capability }; },
  });
  const host = createCodingToolsAppsHost({ services: { agentOrchestrator: (operation, args) => workflow.call(operation, args) } });
  const reply = await host.call("agent-orchestrator", "permission_profiles", { workspaceId: "ws", runId: "run", nodeId: "planner" });
  assert.deepEqual(reply.result.capability, capability);
  assert.deepEqual(calls, [{ endpoint: "/api/v1/ao/harness/permission-profiles",
    body: { workspace_id: "ws", run_id: "run", node_id: "planner" } }]);
});

test("AO typed native replies preserve exact payload and thread/turn scope after local confirmation", async () => {
  const calls = [], prompts = [];
  const pending = { approval_id: "approval", kind: "command", method: "item/commandExecution/requestApproval",
    thread_id: "thread", turn_id: "turn", request: { command: "Get-Content test.txt", availableDecisions: ["accept", "decline"] } };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options });
      if (endpoint.endsWith("/status")) return { ok: true, status: { pending_approvals: [pending] } };
      return { ok: true, result: { ok: true } };
    },
    confirm: async prompt => { prompts.push(prompt); return true; },
  });
  const base = { workspaceId: "ws", runId: "run", nodeId: "worker", approvalId: "approval", threadId: "thread", turnId: "turn" };
  for (const response of [{ decision: "accept" }, { permissions: { filesystem: { read: ["C:/project"] } }, scope: "turn" },
    { answers: { choice: { answers: ["Yes"] } } }, { action: "accept", content: { approved: true } }]) {
    await workflow.call("approve_harness", { ...base, response });
    const sent = calls.at(-1);
    assert.deepEqual(sent.body, { workspace_id: "ws", run_id: "run", node_id: "worker",
      approval_id: "approval", thread_id: "thread", turn_id: "turn", response, confirm: true });
    assert.deepEqual(sent.options, { localConfirmation: true });
  }
  assert.match(prompts[0].detail, /thread.*turn/s);
  assert.match(prompts[0].detail, /accept/);
  for (const invalid of [{ ...base, response: { decision: "accept" }, allow: true },
    { ...base, turnId: "stale", response: { decision: "accept" } },
    { ...base, threadId: undefined, response: { decision: "accept" } }]) {
    const before = calls.filter(call => call.endpoint.endsWith("/approval")).length;
    await assert.rejects(workflow.call("approve_harness", invalid), /scope|reply|either|turn|thread|pending/i);
    assert.equal(calls.filter(call => call.endpoint.endsWith("/approval")).length, before);
  }
});

test("AO typed approval cancelled in the local confirmation never forwards", async () => {
  let sent = 0;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      if (endpoint.endsWith("/status")) return { ok: true, status: { pending_approvals: [
        { approval_id: "a", method: "mcpServer/elicitation/request", thread_id: "t", turn_id: "v", kind: "mcp_url" }] } };
      sent++; return { ok: true, result: { ok: true } };
    },
    confirm: async () => false,
  });
  const result = await workflow.call("approve_harness", { workspaceId: "ws", runId: "run", nodeId: "worker",
    approvalId: "a", threadId: "t", turnId: "v", response: { action: "decline" } });
  assert.equal(result.cancelled, true);
  assert.equal(sent, 0);
});

test("AO connection forwards saved native policy and rejects a resolver substitution", async () => {
  const calls = [], selections = [];
  let substitute = false;
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
    model: "chatgpt-web/high", permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run", workspace_id: "ws",
        nodes: [{ id: "worker", role: "worker", state: "pending", route }] }] };
      calls.push({ endpoint, body }); return { ok: true, status: { model: route.model } };
    },
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    webModelCatalog: async () => ({ models: [{ slug: route.model }] }),
    resolveHarness: async selection => {
      selections.push(selection);
      return { executable: "C:/codex.exe", model: route.model, permission_profile: route.permission_profile,
        allow_model_usage: true, allow_command_execution: false, approval_policy: selection.approvalPolicy,
        approvals_reviewer: substitute ? "user" : selection.approvalsReviewer };
    },
    confirm: async () => true,
  });
  const input = { workspaceId: "ws", runId: "run", nodeId: "worker", executable: "C:/codex.exe" };
  await workflow.call("connect_harness", input);
  assert.equal(selections[0].approvalPolicy, "on-request");
  assert.equal(selections[0].approvalsReviewer, "auto_review");
  assert.equal(calls[0].body.connection.approvals_reviewer, "auto_review");
  substitute = true;
  await assert.rejects(workflow.call("connect_harness", input), /saved.*permission|policy/i);
  assert.equal(calls.length, 1);
});

test("background command approver leaves typed non-command, truncated and unoffered grants for the person", async () => {
  for (const scenario of ["non-command", "unoffered", "truncated"]) {
    const route = { harness_id: "codex-native", provider_id: "cliproxyapi-antigravity",
      model: "test-model", permission_profile: ":read-only" };
    const pending = scenario === "non-command"
      ? ["permissions", "questions", "file_change", "mcp_form", "mcp_url", "file_write"].map(kind =>
        ({ approval_id: kind, kind, method: "native/" + kind }))
      : [{ approval_id: scenario, kind: "command", command: "Get-Content test.txt", cwd: "C:/outside",
        request: { availableDecisions: ["decline"],
          ...(scenario === "truncated" ? { additionalPermissions: "requested".repeat(150),
            networkApprovalContext: { host: "outside.invalid", protocol: "https" } } : {}) } }];
    const mission = { id: "run", workspace_id: "ws", revision: 3, grant: { executable_sha256: "a".repeat(64) }, nodes: [
      { id: "approver", role: "approver", state: "finished", parents: [], route,
        receipt: { verdict: "APPROVED" }, settings: { auto_decide: true } },
      { id: "worker", role: "worker", state: "running", parents: ["approver"], route },
    ] };
    let finished = false, sent = 0, asked = 0;
    const workflow = createAgentOrchestratorWorkflow({
      findCodexExecutable: () => process.execPath,
      resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
      cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
      fetchImpl: async url => {
        if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "test-model" }] }) };
        asked++;
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"allow","reason":"Fixture only"}' } }] }) };
      },
      requestHeadless: async endpoint => {
        if (endpoint.endsWith("/read")) return { ok: true, runs: [mission], worker_capacity: { run: 1 } };
        if (endpoint.endsWith("/observe")) {
          if (finished) mission.nodes[1].state = "finished";
          return { ok: true, pending_approvals: finished ? [] : pending };
        }
        if (endpoint.endsWith("/approval")) { sent++; throw new Error("A non-command/unoffered grant must not auto-submit"); }
        throw new Error("Unexpected endpoint " + endpoint);
      },
    });
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    let status;
    for (let tries = 0; tries < 40; tries++) {
      status = await workflow.call("run_status", { workspaceId: "ws", runId: "run" });
      if (status.detail === "Waiting for your tool approval" || status.status === "held") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 20)); // let the mock advisor complete its awaited callbacks
    status = await workflow.call("run_status", { workspaceId: "ws", runId: "run" });
    finished = true;
    assert.equal(status.status, "running", scenario + ": " + JSON.stringify(status));
    assert.match(status.detail, /Waiting for your tool approval|checking it yourself/, scenario);
    assert.equal(sent, 0, scenario);
    if (scenario !== "unoffered") assert.equal(asked, 0, scenario + " must not send incomplete/native form scope to command advisor");
    for (let tries = 0; tries < 70; tries++) {
      if ((await workflow.call("run_status", { workspaceId: "ws", runId: "run" })).status === "finished") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
});

test("manual dispatch reconnects a stale idle native policy through exact normal consent", async () => {
  const calls = [], prompts = [];
  const route = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web",
    model: "chatgpt-web/high", permission_profile: ":read-only", approval_policy: "on-request", approvals_reviewer: "user" };
  const mission = { id: "run", workspace_id: "ws", revision: 2, nodes: [
    { id: "worker", role: "worker", state: "pending", parents: [], route }] };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body, options) => {
      if (endpoint.endsWith("/read")) return { ok: true, runs: [mission] };
      if (endpoint.endsWith("/status")) return { ok: true, status: { connected: true, model: route.model,
        permission_profile: ":danger-full-access", approval_policy: "never", approvals_reviewer: "user" } };
      calls.push({ endpoint, body, options });
      return { ok: true, status: { model: route.model } };
    },
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    webModelCatalog: async () => ({ models: [{ slug: route.model }] }),
    resolveHarness: async selected => ({ executable: "C:/codex.exe", model: route.model,
      permission_profile: selected.permissionProfile, approval_policy: selected.approvalPolicy,
      approvals_reviewer: selected.approvalsReviewer, allow_model_usage: true, allow_command_execution: false }),
    confirm: async prompt => { prompts.push(prompt); return true; },
  });
  await workflow.call("advance", { workspaceId: "ws", runId: "run", executable: "C:/codex.exe" });
  assert.deepEqual(calls.map(call => call.endpoint), ["/api/v1/ao/harness/connect", "/api/v1/ao/harness/execute"]);
  assert.equal(calls[0].body.connection.permission_profile, ":read-only");
  assert.equal(calls[0].body.confirm, true);
  assert.deepEqual(calls[0].options, { localConfirmation: true });
  assert.match(prompts[0].detail, /Permission: read-only/);
});

test("secret native question answers are forwarded but masked in local confirmation", async () => {
  let detail = "", sent;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      if (endpoint.endsWith("/status")) return { ok: true, status: { pending_approvals: [{
        approval_id: "a", method: "item/tool/requestUserInput", kind: "questions", thread_id: "t", turn_id: "v",
        request: { questions: [{ id: "code", isSecret: true, question: "Enter code" }] },
      }] } };
      sent = body; return { ok: true, result: { ok: true } };
    },
    confirm: async prompt => { detail = prompt.detail; return true; },
  });
  const response = { answers: { code: { answers: ["private-code-answer"] } } };
  await workflow.call("approve_harness", { workspaceId: "ws", runId: "run", nodeId: "worker",
    approvalId: "a", threadId: "t", turnId: "v", response });
  assert.deepEqual(sent.response, response);
  assert.doesNotMatch(detail, /private-code-answer/);
  assert.match(detail, /redacted/i);
});

test("explicit single chat binds one selected route without a saved team", async () => {
  const world = chatWorld(), route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local",
    model: "cpa/gemini-3.8-flash-high", permission_profile: ":ao-default" };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (...args) => {
      const result = await world.requestHeadless(...args);
      return args[0] === "/api/v1/ao/read" ? { ...result, team: null, teams: [] } : result;
    },
    findCodexExecutable: () => "C:/Codex/codex.exe",
    resolveHarness: async () => { throw new Error("fixture stop"); },
  });
  const sent = await workflow.call("chat_send", { workspaceId: "ws-1", message: "single task", executionMode: "single", singleRoute: route });
  assert.equal(sent.taskId, "task-1");
  assert.equal(world.updates.length, 1);
  assert.equal(world.updates[0].execution_mode, "single");
  assert.deepEqual(world.updates[0].single_route, route);
  assert.equal(Object.hasOwn(world.updates[0], "team_revision"), false);
  assert.equal(Object.hasOwn(world.updates[0], "team_id"), false);
});

test("team chat binds selected identity and rejects stale config before writing", async () => {
  for (const stale of [false, true]) {
    const world = chatWorld(), selected = { id: "team-picked", revision: 9, worker_limit: 1 };
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: async (...args) => {
        const result = await world.requestHeadless(...args);
        return args[0] === "/api/v1/ao/read" ? { ...result, teams: [result.team, selected] } : result;
      },
      findCodexExecutable: () => "C:/Codex/codex.exe",
      resolveHarness: async () => { throw new Error("fixture stop"); },
    });
    const input = { workspaceId: "ws-1", message: "team task", executionMode: "team", teamId: "team-picked", teamRevision: stale ? 8 : 9 };
    if (stale) {
      await assert.rejects(workflow.call("chat_send", input), /team.*changed|revision|saved/i);
      assert.equal(world.tasks.length, 0);
    } else {
      await workflow.call("chat_send", input);
      assert.equal(world.updates[0].team_id, selected.id);
      assert.equal(world.updates[0].team_revision, 9);
      assert.equal(world.updates[0].execution_mode, "team");
      assert.equal(Object.hasOwn(world.updates[0], "single_route"), false);
    }
  }
});

test("external Codex-style permission tuples map to the real AO approval mode at spawn", async () => {
  // Claude Code's own "auto" mode exists only for Claude models, so its "Approve for me" accepts edits
  // and leaves tool requests to our reviewer; Codex keeps its native auto-review.
  for (const agent of ["codex", "claude-code"]) for (const [policy, reviewer, expected] of [["on-request","user","accept-edits"],["on-request","auto_review",agent === "codex" ? "auto" : "accept-edits"],["never","user","bypass-permissions"]]) {
    let launched;
    const route = { harness_id: `ao:${agent}`, provider_id: "agent-orchestrator", account_id: "ao-local", model: "gpt-6-luna",
      permission_profile: ":ao-default", native_permission_profile: policy === "never" ? ":danger-full-access" : ":workspace", approval_policy: policy, approvals_reviewer: reviewer };
    const mission = { id:"run", workspace_id:"ws", revision:1, nodes:[{id:"one",role:"planner",state:"pending",parents:[],route}] };
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: async endpoint => endpoint.endsWith("/read") ? {ok:true,runs:[mission],worker_capacity:{run:1}}
        : endpoint.endsWith("/reserve") ? {ok:true,request_key:"key",prompt:"direct task"} : {ok:true,run:mission},
      aoHarness: { spawn: async input => { launched=input;return "session"; } },
      confirm: async () => true,
    });
    await workflow.call("advance", {workspaceId:"ws",runId:"run",executable:"C:/codex.exe"});
    assert.equal(launched.approvalMode, expected);
  }
});

test("permission capabilities use installed AO adapter modes without fabricating native metadata", async () => {
  const reads = [], launches = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => { reads.push(endpoint); throw new Error("No native connection"); },
    aoHarness: { catalog: async () => [
      { id: "claude-code", installed: true }, { id: "codex", installed: true }, { id: "opencode", installed: true },
    ], spawn: async (...args) => { launches.push(args); } },
  });
  const capability = (await workflow.call("permission_profiles", { workspaceId: "ws-1", route: { harness_id: "ao:claude-code" } })).capability;
  assert.equal(capability.supported, true);
  assert.equal(capability.source, "ao-adapter");
  assert.equal(capability.requested_only, true, "adapter modes are requests, not effective native readback");
  assert.deepEqual(capability.profiles.map(profile => profile.id), [":workspace", ":danger-full-access"]);
  assert.deepEqual(capability.approval_policies, ["on-request", "never"]);
  assert.deepEqual(capability.approvals_reviewers, ["user", "auto_review"]);
  for (const harness_id of ["ao:opencode", "codex-native"]) {
    const unsupported = await workflow.call("permission_profiles", { workspaceId: "ws-1", route: { harness_id } });
    assert.equal(unsupported.capability.supported, false);
  }
  assert.deepEqual(reads, []);
  assert.deepEqual(launches, []);
});

test("explicit single mode has no hidden task-naming or recovery model", async () => {
  const naming = startableChatWorld();
  const requests = [];
  const options = requestHeadless => ({
    requestHeadless, findCodexExecutable: () => "C:/Codex/codex.exe",
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async url => {
      requests.push(String(url));
      return { ok: true, json: async () => String(url).endsWith("/v1/models")
        ? { data: [{ id: "another-model" }] } : { choices: [{ message: { content: "Another model named it" } }] } };
    },
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    resolveHarness: async () => ({ expected_sha256: "a".repeat(64), executable: path.resolve("codex.exe") }),
  });
  await createAgentOrchestratorWorkflow(options(naming.requestHeadless)).call("chat_send", {
    workspaceId: "ws-1", message: "Single task", executionMode: "single",
    singleRoute: { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":workspace" },
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(requests, [], "no separate model names a single-mode chat");

  const recovery = heldMissionWorld();
  const requestHeadless = async (...args) => {
    const result = await recovery.requestHeadless(...args);
    if (args[0] === "/api/v1/ao/read") result.runs[0].execution_mode = "single";
    return result;
  };
  const workflow = createAgentOrchestratorWorkflow(options(requestHeadless));
  await workflow.call("start_run", { workspaceId: "ws-1", runId: "r1" });
  await until(() => recovery.reads >= 2);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await workflow.call("run_status", { workspaceId: "ws-1", runId: "r1" })).status, "held");
  assert.deepEqual(recovery.controls, [], "a failed single model requires an explicit retry");
  assert.deepEqual(requests, [], "no recovery model is invoked");
});

test("external dispatch refuses permission tuples the adapter cannot honor", async () => {
  for (const tuple of [
    { native_permission_profile: ":read-only" },
    { native_permission_profile: "managed/custom" },
    { native_permission_profile: ":workspace" },
    { native_permission_profile: ":read-only", approval_policy: "never", approvals_reviewer: "user" },
    { native_permission_profile: "managed/custom", approval_policy: "on-request", approvals_reviewer: "user" },
    { native_permission_profile: ":workspace", approval_policy: "untrusted", approvals_reviewer: "user" },
  ]) {
    let launched = false;
    const route = { harness_id: "ao:codex", model: "gpt-6-luna", permission_profile: ":ao-default", ...tuple };
    const mission = { id:"run",workspace_id:"ws",revision:1,nodes:[{id:"one",role:"planner",state:"pending",parents:[],route}] };
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: async endpoint => endpoint.endsWith("/read") ? {ok:true,runs:[mission],worker_capacity:{run:1}}
        : endpoint.endsWith("/reserve") ? {ok:true,request_key:"key",prompt:"direct"} : {ok:true,run:mission},
      aoHarness: { spawn: async () => { launched=true;return "session"; } }, confirm: async()=>true,
    });
    await assert.rejects(workflow.call("advance", {workspaceId:"ws",runId:"run"}), /cannot honor|permission tuple|unsupported.*permission/i);
    assert.equal(launched, false);
  }
});

test("single restart honors deferred narrowing without rewriting its completed full-access receipt", async () => {
  for (const harness_id of ["codex-native", "ao:codex"]) {
    const native = harness_id === "codex-native";
    const originalRoute = { harness_id, provider_id:native?"chatgpt-web":"agent-orchestrator", account_id:"local",
      model:native?"chatgpt-web/high":"gpt-6-luna", permission_profile:native?":danger-full-access":":ao-default",
      native_permission_profile:":danger-full-access", approval_policy:"never", approvals_reviewer:"user", effort:"high" };
    const receipt = { status:"finished", answer:"Old answer", route:structuredClone(originalRoute) };
    const mission = { id:"old-single", project_id:"task-1", workspace_id:"ws-1", revision:6, cancelled:false, execution_mode:"single",
      nodes:[{id:"attempt",template_role_id:"selected",state:"finished",route:originalRoute,receipt}],
      team:{id:"single-snapshot",permission_selections:{selected:{permission_profile:":workspace",approval_policy:"on-request",approvals_reviewer:"user"}}} };
    const snapshot = structuredClone(mission);
    const world = chatWorld({ runs:[mission], tasks:[{id:"task-1",title:"Single",description:"Task",state:"backlog",clauses:[]}] });
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless:world.requestHeadless,findCodexExecutable:()=>"C:/Codex/codex.exe",
      resolveHarness:async()=>{throw new Error("fixture stop before dispatch")},
    });
    await workflow.call("restart_run", {workspaceId:"ws-1",runId:"old-single"});
    const replacement = world.updates.find(change=>change.operation==="create_from_team");
    assert.equal(replacement.execution_mode,"single");
    assert.deepEqual(replacement.single_route, {...originalRoute,native_permission_profile:":workspace",
      permission_profile:native?":workspace":":ao-default",approval_policy:"on-request",approvals_reviewer:"user"});
    assert.deepEqual(mission,snapshot,"historical raw route/receipt/model and harness stay immutable");
    assert.equal(Object.hasOwn(replacement,"team_id"),false);
  }
});

test("chat rename keeps the messages; archive and restore are the lifecycle's own operations", async () => {
  const task = { id: "task-1", title: "Old name", description: "first message\n\nFollow-up (2026-10-08 01:00 UTC):\nsecond", state: "done" };
  let revision = 7;
  const updates = [];
  let runNodes = [{ id: "p", role: "planner", state: "running" }];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run-1", workspace_id: "ws-1", project_id: "task-1", cancelled: false, nodes: runNodes }] };
      assert.equal(endpoint, "/api/v1/tools/call");
      const args = body.arguments;
      if (body.tool === "workflow_list") {
        return { ok: true, operation: { state: "completed", result: { ok: true, revision, workspace_id: "ws-1", steps: [],
          ...(args.task_id ? { task } : { tasks: [task] }), included_archived: args.include_archived } } };
      }
      if (body.tool === "workflow_update") {
        updates.push(args);
        revision += 1;
        return { ok: true, operation: { state: "completed", result: { ok: true } } };
      }
      throw new Error(`unexpected ${body.tool}`);
    },
    confirm: async () => true,
  });
  await workflow.call("task_rename", { workspaceId: "ws-1", taskId: "task-1", title: "  New name " });
  assert.deepEqual(updates[0], { expected_revision: 7, change: { operation: "edit", id: "task-1", title: "New name", description: task.description } },
    "the description, which holds every message, is kept");
  await assert.rejects(workflow.call("task_rename", { workspaceId: "ws-1", taskId: "task-1", title: "   " }), /Give the chat a name/);
  // #256's archive_task / delete_task / restore_task own the chat lifecycle; no second set exists.
  await assert.rejects(workflow.call("task_archive", { workspaceId: "ws-1", taskId: "task-1" }), /Unknown|unknown|unsupported|not supported/i);
  assert.equal(updates.length, 1);
  void runNodes;
  const listed = await workflow.call("board", { workspaceId: "ws-1", includeArchived: true });
  assert.equal(listed.ok, true);
});

test("AO connects every ready worker's harness together so slow Codex starts do not serialize workers", async () => {
  const web = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only" };
  const nodes = [
    { id: "planner", role: "planner", state: "pending", parents: [], route: web },
    { id: "worker", role: "worker", state: "pending", parents: ["planner"], route: web },
    { id: "worker-two", role: "worker", state: "pending", parents: ["planner"], route: web },
    { id: "reviewer", role: "reviewer", state: "pending", parents: ["worker", "worker-two"], route: web },
  ];
  const run = { id: "run-1", workspace_id: "ws-1", project_id: "project-1", revision: 3, cancelled: false, nodes };
  const connected = new Set();
  let connecting = 0;
  let peakConnecting = 0;
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 2 - nodes.filter(node => node.role === "worker" && node.state === "running").length } };
      if (endpoint === "/api/v1/ao/grant") return { ok: true, run: structuredClone(run), grant: { executable_sha256: "a".repeat(64) } };
      if (endpoint === "/api/v1/ao/harness/status") return { ok: true, status: connected.has(body.node_id)
        ? { connected: true, model: web.model, permission_profile: ":read-only" } : { connected: false } };
      if (endpoint === "/api/v1/ao/harness/connect") {
        connecting++; peakConnecting = Math.max(peakConnecting, connecting);
        await new Promise((resolve) => setTimeout(resolve, 20));
        connecting--; connected.add(body.node_id);
        return { ok: true, owned: true, status: { connected: true, model: body.connection.model } };
      }
      if (endpoint === "/api/v1/ao/harness/execute") {
        const node = nodes.find((entry) => entry.id === body.node_id);
        node.state = "running"; node.receipt = { status: "submitted" }; run.revision += 1;
        return { ok: true, run: structuredClone(run), receipt: node.receipt };
      }
      if (endpoint === "/api/v1/ao/harness/observe") {
        const node = nodes.find((entry) => entry.id === body.node_id);
        node.state = "finished"; node.receipt = { status: "completed", answer: "READY" }; run.revision += 1;
        return { ok: true, run: structuredClone(run), receipt: node.receipt };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "SENTINEL_PRIVATE_KEY_12345678901234567890" }),
    webBridgeConnection: () => ({ baseUrl: "http://127.0.0.1:17841/v1" }),
    webBridgeReadiness: async () => ({ authenticated: true, ready: true }),
    webModelCatalog: async () => ({ models: [{ slug: "chatgpt-web/high" }] }),
    resolveHarness: async ({ model }) => ({ executable: "C:/codex.exe", expected_sha256: "a".repeat(64),
      codex_home: "C:/ao-home", model, allow_model_usage: true,
      allow_command_execution: false, permission_profile: ":read-only", request_limit: 3, lifetime_seconds: 900 }),
    confirm: async () => { throw new Error("Start mission must not open a second confirmation dialog"); },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:/codex.exe" };
  assert.equal((await workflow.call("start_run", input)).started, true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await workflow.call("run_status", input)).status === "finished") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await workflow.call("run_status", input)).status, "finished");
  assert.equal(peakConnecting, 2, "both workers' harnesses start at the same time");
});

test("a start blocked on the browser returns its reason instead of a generic transport failure", async () => {
  const web = { harness_id: "codex-native", provider_id: "chatgpt-web", account_id: "chatgpt-web", model: "chatgpt-web/high", permission_profile: ":read-only" };
  const run = { id: "run-1", workspace_id: "ws-1", project_id: "p", revision: 1, cancelled: false,
    nodes: [{ id: "planner", role: "planner", state: "pending", parents: [], route: web }] };
  let ready = { authenticated: true, ready: false };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [structuredClone(run)], worker_capacity: { "run-1": 1 } };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
    webBridgeReadiness: async () => ready,
    resolveHarness: async () => { throw new Error("must not resolve a harness while the browser is not ready"); },
    confirm: async () => true,
  });
  const input = { workspaceId: "ws-1", runId: "run-1", executable: "C:/codex.exe" };
  assert.deepEqual({ ...(await workflow.call("start_run", input)) },
    { ok: false, started: false, reason: "Browser is not ready; open Browser and check the ChatGPT session" });
  ready = { authenticated: false, ready: true };
  assert.match((await workflow.call("start_run", input)).reason, /Sign in to ChatGPT/);
  await assert.rejects(workflow.call("start_run", { ...input, proxyApiKey: "x" }), /refused/, "other start errors still throw");
});

// ---- Codex slash commands: /goal, /compact, /diff ----

const { goalVerdict, closingAnswers, createGoalStore, goalPrompt } = require("../electron/chat-goals.cjs");

test("a goal reads the closing cards' verdicts: a team's reviewer, a Single card, or a solo orchestrator", () => {
  assert.equal(goalVerdict(["Done.\nGOAL: ACHIEVED — all tests pass"]), "achieved");
  assert.equal(goalVerdict(["**GOAL: CONTINUE** — two tests still fail"]), "continue");
  assert.equal(goalVerdict(["no verdict at all"]), null);
  assert.equal(goalVerdict(["GOAL: CONTINUE — x", "GOAL: ACHIEVED"]), "achieved", "any closing card that saw it achieved wins");
  const team = { nodes: [
    { id: "lead", role: "planner", parents: [], receipt: { answer: "plan" } },
    { id: "w", role: "worker", parents: ["lead"], receipt: { answer: "GOAL: ACHIEVED (a worker can't close it)" } },
    { id: "rev", role: "reviewer", parents: ["w"], receipt: { answer: "APPROVED\nGOAL: CONTINUE — docs" } },
    { id: "retry", role: "retry", parents: ["lead"], receipt: { answer: "GOAL: ACHIEVED" } },
  ] };
  assert.deepEqual(closingAnswers(team), ["APPROVED\nGOAL: CONTINUE — docs"], "only the reviewer closes a team; workers and the retry sidecar don't");
  assert.equal(goalVerdict(closingAnswers({ ...team, solo: true })), "continue");
  assert.deepEqual(closingAnswers({ nodes: [{ id: "one", role: "planner", parents: [], receipt: { answer: "GOAL: ACHIEVED" } }] }), ["GOAL: ACHIEVED"]);
  assert.match(goalPrompt("ship it", 2, 6), /^Continue pursuing the goal \(round 2 of 6\)[\s\S]*Goal: ship it[\s\S]*GOAL: ACHIEVED[\s\S]*GOAL: CONTINUE/);
});

test("goals are kept per chat in a file and survive a restart", () => {
  const file = path.join(require("node:os").tmpdir(), `ct-goals-${crypto.randomUUID()}.json`);
  try {
    const store = createGoalStore({ file, now: () => 1000 });
    store.set("ws-1", "task-1", "  make the build green  ");
    store.update("ws-1", "task-1", { round: 2 });
    const again = createGoalStore({ file });
    assert.equal(again.get("ws-1", "task-1").objective, "make the build green");
    assert.equal(again.get("ws-1", "task-1").round, 2);
    assert.deepEqual(Object.keys(again.forWorkspace("ws-1")), ["task-1"]);
    assert.deepEqual(again.forWorkspace("ws-2"), {});
    assert.throws(() => again.set("ws-1", "task-2", "   "), /Describe your goal/);
    assert.equal(again.clear("ws-1", "task-1"), true);
    assert.equal(createGoalStore({ file }).get("ws-1", "task-1"), null);
  } finally { fs.rmSync(file, { force: true }); }
});

test("/goal starts the chat's first round with the goal and keeps it for the chat", async () => {
  const world = chatWorld();
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/codex.exe",
    resolveHarness: async () => { throw new Error("stop before the background loop"); } });
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gpt-6-luna", permission_profile: ":ao-default" };
  const sent = await workflow.call("chat_send", { workspaceId: "ws-1", message: "make every test pass", goal: "make every test pass", executionMode: "single", singleRoute: route });
  assert.equal(sent.taskId, "task-1");
  assert.equal(world.tasks[0].title, "make every test pass", "the chat is named after the goal, not the round's instructions");
  assert.match(world.tasks[0].description, /^Goal \(round 1 of 6\):\nGoal: make every test pass[\s\S]*GOAL: ACHIEVED/);
  const { goals } = await workflow.call("runs", { workspaceId: "ws-1" });
  assert.equal(goals["task-1"].objective, "make every test pass");
  assert.equal(goals["task-1"].status, "active");
  assert.equal(goals["task-1"].round, 1);
  await assert.rejects(workflow.call("chat_send", { workspaceId: "ws-1", message: "x", goal: "   " }), /Describe your goal/);
});

/** A chat whose goal was set with its first round; tests push settled runs and call goalAfterRun. */
async function goalChat() {
  const world = chatWorld({ tasks: [{ id: "task-1", title: "Green build", description: "x", state: "in_progress", clauses: [] }], runs: [] });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/codex.exe",
    resolveHarness: async () => { throw new Error("stop before the background loop"); } });
  await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "build green", goal: "build green" });
  return { world, workflow };
}
const goalOf = async (workflow) => (await workflow.call("runs", { workspaceId: "ws-1" })).goals["task-1"];

test("after a round without the goal achieved, the chat runs the next round with the same Single model", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/gpt-6-luna", permission_profile: ":ao-default", effort: "max" };
  const { world, workflow } = await goalChat();
  world.runs.push({ id: "r1", workspace_id: "ws-1", project_id: "task-1", execution_mode: "single", cancelled: false,
    nodes: [{ id: "one", role: "planner", parents: [], state: "finished", route, receipt: { answer: "Fixed 3 of 5.\nGOAL: CONTINUE — 2 tests fail" } }] });
  const updatesBefore = world.updates.length;
  await workflow.goalAfterRun("ws-1", "r1", "finished", null);
  const next = world.updates.slice(updatesBefore);
  assert.equal(next.length, 1, "one new round");
  assert.equal(next[0].execution_mode, "single");
  assert.deepEqual(next[0].single_route, route, "the same Single model, effort and permissions");
  assert.match(world.edits.at(-1).description, /Continue pursuing the goal \(round 2 of 6\)/);
  const goal = await goalOf(workflow);
  assert.equal(goal.status, "active");
  assert.equal(goal.round, 2);
  // The same settled run is not evaluated twice.
  await workflow.goalAfterRun("ws-1", "r1", "finished", null);
  assert.equal(world.updates.length, updatesBefore + 1);
});

test("a team's goal round continues on the chat's team; an achieved, failed, stopped or spent goal stops", async () => {
  const teamRun = (id, answer) => ({ id, workspace_id: "ws-1", project_id: "task-1", cancelled: false, team: { id: "team-1", revision: 7 }, nodes: [
    { id: "lead", role: "planner", parents: [], state: "finished", receipt: { answer: "plan" } },
    { id: "rev", role: "reviewer", parents: ["lead"], state: "finished", receipt: { answer } }] });
  let { world, workflow } = await goalChat();
  world.runs.push(teamRun("t1", "APPROVED\nGOAL: CONTINUE — docs"));
  const before = world.updates.length;
  await workflow.goalAfterRun("ws-1", "t1", "finished", null);
  assert.equal(world.updates.length, before + 1);
  assert.equal(world.updates.at(-1).operation, "create_from_team");
  assert.equal(world.updates.at(-1).team_id, "team-1", "the next round keeps the chat's team");

  ({ world, workflow } = await goalChat());
  world.runs.push(teamRun("t2", "APPROVED\nGOAL: ACHIEVED"));
  await workflow.goalAfterRun("ws-1", "t2", "finished", null);
  assert.equal((await goalOf(workflow)).status, "achieved");

  for (const [status, attention, expected] of [["failed", "error", "stalled"], ["held", null, "stalled"], ["held", "stopped", "paused"]]) {
    ({ world, workflow } = await goalChat());
    world.runs.push(teamRun("t3", "anything"));
    const count = world.updates.length;
    await workflow.goalAfterRun("ws-1", "t3", status, attention);
    assert.equal((await goalOf(workflow)).status, expected, `${status}/${attention}`);
    assert.equal(world.updates.length, count, "no new round");
  }

  ({ world, workflow } = await goalChat());
  // Spend every round: the goal stops as limited, and /goal resume allows more.
  for (let round = 0; round < 10 && (await goalOf(workflow)).status === "active"; round++) {
    world.runs.push(teamRun(`t4-${round}`, "GOAL: CONTINUE"));
    await workflow.goalAfterRun("ws-1", `t4-${round}`, "finished", null);
  }
  let goal = await goalOf(workflow);
  assert.equal(goal.status, "limited");
  assert.equal(goal.round, 6);
  const resumed = await workflow.call("chat_goal", { workspaceId: "ws-1", taskId: "task-1", action: "resume" });
  assert.equal(resumed.goal.status, "active");
  assert.equal(resumed.goal.rounds, 12, "resuming a spent goal allows as many rounds again");
  assert.equal(resumed.goal.round, 7, "and starts the next round right away");
  await workflow.call("chat_goal", { workspaceId: "ws-1", taskId: "task-1", action: "edit", objective: "build green on CI" });
  assert.equal((await goalOf(workflow)).objective, "build green on CI");
  assert.equal((await goalOf(workflow)).round, 7, "editing starts no round");
  await workflow.call("chat_goal", { workspaceId: "ws-1", taskId: "task-1", action: "pause" });
  goal = await goalOf(workflow);
  assert.equal(goal.status, "paused");
  world.runs.push(teamRun("t5", "GOAL: CONTINUE"));
  const paused = world.updates.length;
  await workflow.goalAfterRun("ws-1", "t5", "finished", null);
  assert.equal(world.updates.length, paused, "a paused goal starts no round");
  assert.equal((await workflow.call("chat_goal", { workspaceId: "ws-1", taskId: "task-1", action: "clear" })).cleared, true);
  assert.equal(await goalOf(workflow), undefined);
  await assert.rejects(workflow.call("chat_goal", { workspaceId: "ws-1", taskId: "task-1", action: "pause" }), /No goal is currently set/);
});

test("/compact replaces a long chat's context with Codex's handoff summary; /diff reads the git tool", async () => {
  const long = "Fix the login flow.\n\n" + "Follow-up: more detail. ".repeat(120);
  const world = chatWorld({ tasks: [{ id: "task-1", title: "Login", description: long, state: "in_progress", clauses: [] }], runs: [] });
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/v1/models")) return { ok: true, json: async () => ({ data: [{ id: "gpt-5.5" }] }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "Progress: login fixed. Next: add tests." } }] }) };
  };
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, fetchImpl, findCodexExecutable: () => "C:/codex.exe",
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k".repeat(40) }) });
  const compacted = await workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" });
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.after < compacted.before);
  assert.match(world.tasks[0].description, /^Summary of the earlier conversation \(compacted [0-9-]+ [0-9:]+ UTC\):\nProgress: login fixed\. Next: add tests\.$/);
  const completion = requests.find(entry => entry.url.endsWith("/v1/chat/completions"));
  assert.match(completion.body.messages[0].content, /^You are performing a CONTEXT CHECKPOINT COMPACTION/);
  assert.equal(completion.body.messages[1].content, long);
  // A short chat has nothing to compact.
  assert.equal((await workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" })).compacted, false);
  // A working chat refuses, as Codex does.
  world.runs.push({ id: "busy", workspace_id: "ws-1", project_id: "task-1", cancelled: false, nodes: [{ id: "a", state: "running" }] });
  await assert.rejects(workflow.call("compact_chat", { workspaceId: "ws-1", taskId: "task-1" }), /disabled while a chat is in progress/);

  const diffWorld = async (endpoint, body) => {
    if (endpoint === "/api/v1/tools/call" && body.tool === "git_diff") {
      assert.deepEqual({ ...body.arguments }, { staged: true, unstaged: true, max_bytes: 120000 });
      return { operation: { state: "completed", result: { ok: true, diff: "diff --git a/x b/x\n+y\n", files: ["x"], truncated: false, warnings: [] } } };
    }
    return world.requestHeadless(endpoint, body);
  };
  const differ = createAgentOrchestratorWorkflow({ requestHeadless: diffWorld, findCodexExecutable: () => "C:/codex.exe" });
  const diff = await differ.call("chat_diff", { workspaceId: "ws-1" });
  assert.equal(diff.diff, "diff --git a/x b/x\n+y\n");
  assert.deepEqual([...diff.files], ["x"]);
});

test("a single AO card set to Approve for me has its parked tool requests reviewed and answered through AO", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const decisions = [{ id: "yes", kind: "allow_once", label: "Allow" }, { id: "always", kind: "allow_always", label: "Always" }, { id: "no", kind: "reject_once", label: "Reject" }];
  const requests = [
    { approval_id: "safe", source: "ao", kind: "command", command: "npm test", tool: "Bash", summary: "Bash", decisions },
    { approval_id: "push", source: "ao", kind: "command", command: "git push origin main", tool: "Bash", summary: "Bash", decisions },
    { approval_id: "unclear", source: "ao", kind: "permission", path: "C:/elsewhere/file", tool: "Write", summary: "Write", decisions },
  ];
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) }, nodes: [
    { id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session-1", request_key: "k" } }] };
  const resolved = [], advised = [];
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "test-model" }] }) };
      const prompt = JSON.parse(init.body).messages[0].content;
      advised.push(JSON.parse(init.body).model);
      const action = prompt.includes("npm test") ? "allow" : "ask";
      return { ok: true, json: async () => ({ choices: [{ message: { content: `{"action":"${action}","reason":"fixture"}` } }] }) };
    },
    requestHeadless: async endpoint => {
      if (endpoint.endsWith("/read")) return { ok: true, runs: [mission], worker_capacity: { run: 1 } };
      if (endpoint.endsWith("/approval")) throw new Error("AO requests are answered through AO, not the native hub");
      return { ok: true, run: mission };
    },
    aoHarness: {
      observe: async () => ({ status: "working", turnId: "t", turnState: "running",
        approvals: requests.filter(request => !resolved.some(([, id]) => id === request.approval_id)) }),
      resolveApproval: async (session, requestId, decisionId) => { resolved.push([session, requestId, decisionId]); return { ok: true }; },
    },
    confirm: async () => true,
  });
  await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
  for (let tries = 0; tries < 200 && resolved.length < 2; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  mission.nodes[0].state = "finished"; // ends the run loop, as the turn finishing would
  for (let tries = 0; tries < 100; tries++) {
    if ((await workflow.call("run_status", { workspaceId: "ws", runId: "run" })).status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(resolved)).sort(), [["session-1", "push", "no"], ["session-1", "safe", "yes"]],
    "allowed once by the reviewer, git push denied by the hard rules, the unclear write left for the person; never an always-grant");
  assert.ok(advised.length >= 1 && advised.every(model => model === "test-model"), "the card's own CPA model reviews");
});

test("the pinned executable digest is reused only while the file is unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ct-exe-digest-"));
  const exe = path.join(dir, "codex.exe");
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  const resolve = () => resolveAoNativeConnection({ workspaceId: "ws", runId: "run", nodeId: "n", executable: exe, model: "gemini-3.8-flash-high", userData: path.join(dir, "user-data") });
  fs.writeFileSync(exe, "first-binary");
  assert.equal((await resolve()).expected_sha256, sha("first-binary"));
  assert.equal((await resolve()).expected_sha256, sha("first-binary"));
  await new Promise((done) => setTimeout(done, 20));
  fs.writeFileSync(exe, "other-binary"); // same size, new content
  assert.equal((await resolve()).expected_sha256, sha("other-binary"), "a replaced executable is hashed again");
});

test("a single-model follow-up continues the chat's live AO session with just the new message", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "user" };
  const task = { id: "task-1", title: "Fix auth", description: "first ask", state: "in_progress", clauses: [] };
  const previous = { id: "r1", project_id: "task-1", execution_mode: "single", cancelled: false,
    nodes: [{ id: "one", role: "planner", state: "finished", parents: [], route, receipt: { thread_id: "sess-1" } }] };
  const world = chatWorld({ tasks: [task], runs: [previous] });
  const created = new Map();
  const spawned = [], sent = [], observedWith = [];
  const request = async (endpoint, body, options) => {
    if (endpoint === "/api/v1/ao/read" && body.run_id) {
      const run = created.get(body.run_id) ?? { id: body.run_id, workspace_id: "ws-1", project_id: "task-1", execution_mode: "single", revision: 1,
        grant: { executable_sha256: "a".repeat(64) }, nodes: [{ id: "one", role: "planner", state: "pending", parents: [], route }] };
      created.set(body.run_id, run);
      return { ok: true, runs: [run], worker_capacity: { [body.run_id]: 1 } };
    }
    const latest = [...created.values()].at(-1);
    if (endpoint === "/api/v1/ao/grant") return { ok: true, run: latest, grant: { executable_sha256: "a".repeat(64) } };
    if (endpoint === "/api/v1/ao/external/reserve") { latest.nodes[0].state = "reserved"; return { ok: true, request_key: "key-1", prompt: "first ask\n\nFollow-up: now run the tests" }; }
    if (endpoint === "/api/v1/ao/external/submitted") { latest.nodes[0].state = "running"; latest.nodes[0].receipt = { thread_id: body.session_id }; return { ok: true, run: latest }; }
    if (endpoint === "/api/v1/ao/external/terminal") { latest.nodes[0].state = "finished"; return { ok: true, run: latest }; }
    return world.requestHeadless(endpoint, body, options);
  };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: request, findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    aoHarness: {
      spawn: async input => { spawned.push(input); return "new-session"; },
      continuable: async id => id === "sess-1",
      send: async (id, text, key) => { sent.push([id, text, key]); return { turnId: "turn-2", state: "running" }; },
      observe: async (id, expected) => { observedWith.push([id, expected]); return { status: "idle", turnId: expected, turnState: "completed", answer: "tests pass" }; },
    },
  });
  await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "now run the tests", executionMode: "single", singleRoute: route });
  for (let tries = 0; tries < 200 && !observedWith.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(spawned.length, 0, "no new session or worktree");
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [["sess-1", "now run the tests", "key-1"]], "only the new message, idempotent by its request key");
  assert.deepEqual(JSON.parse(JSON.stringify(observedWith[0])), ["sess-1", "turn-2"], "observed on the follow-up's own turn");
  assert.match(world.edits[0].description, /Follow-up \([^)]+ UTC\):\nnow run the tests$/, "the chat still records the follow-up");
});

test("steering hands the message to the running AO agent and notes it in the chat", async () => {
  const route = { harness_id: "ao:claude-code", model: "cpa/test-model" };
  const task = { id: "task-1", title: "Fix auth", description: "first ask", state: "in_progress", clauses: [] };
  const world = chatWorld({ tasks: [task], runs: [{ id: "r1", project_id: "task-1", cancelled: false,
    nodes: [{ id: "one", role: "planner", state: "running", route, receipt: { thread_id: "sess-1" } }] }] });
  const steered = [];
  let ended = false;
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless,
    aoHarness: { steer: async (id, text) => { steered.push([id, text]); return { steered: !ended }; } } });
  const result = await workflow.call("chat_steer", { workspaceId: "ws-1", taskId: "task-1", message: "use pnpm, not npm" });
  assert.equal(result.steered, true);
  assert.deepEqual(steered, [["sess-1", "use pnpm, not npm"]]);
  assert.match(world.edits[0].description, /^first ask\n\n↳ Steer \([^)]+ UTC\): use pnpm, not npm$/);
  ended = true;
  assert.equal((await workflow.call("chat_steer", { workspaceId: "ws-1", taskId: "task-1", message: "late" })).steered, false,
    "a turn that already ended is reported, so the chat sends it as a follow-up");
  assert.equal(world.edits.length, 1, "nothing is noted for an undelivered steer");
});

test("a run waiting on input reports it steadily, not on and off with each observation tick", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model" };
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) },
    nodes: [{ id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session-1" } }] };
  const reported = [];
  let done = false;
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    requestHeadless: async endpoint => endpoint.endsWith("/read") ? { ok: true, runs: [mission], worker_capacity: { run: 1 } } : { ok: true, run: mission },
    aoHarness: { observe: () => new Promise(resolve => setTimeout(() => resolve({ status: "needs_input", needsInput: true, turnId: "t", turnState: "running", approvals: [] }), 40)) },
    onRunState: update => { if (!done && update.runId === "run" && update.status === "running") reported.push(update.attention ?? null); },
  });
  await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
  await new Promise(resolve => setTimeout(resolve, 1600));
  done = true; // a finished card rightly clears its attention
  mission.nodes[0].state = "finished";
  for (let tries = 0; tries < 100; tries++) {
    if ((await workflow.call("run_status", { workspaceId: "ws", runId: "run" })).status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const first = reported.indexOf("needs_input");
  assert.ok(first >= 0, "the wait was reported: " + JSON.stringify(reported));
  assert.deepEqual([...new Set(reported.slice(first))], ["needs_input"], "never flips back to no attention while it still waits: " + JSON.stringify(reported));
});

test("a follow-up after a permission change starts a fresh session; a refused send falls back to one", async () => {
  const base = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":danger-full-access", approval_policy: "never", approvals_reviewer: "user" };
  const scenario = async ({ followRoute, sendFails }) => {
    const task = { id: "task-1", title: "Fix auth", description: "first ask", state: "in_progress", clauses: [] };
    const previous = { id: "r1", project_id: "task-1", execution_mode: "single", cancelled: false,
      nodes: [{ id: "one", role: "planner", state: "finished", parents: [], route: base, receipt: { thread_id: "sess-1" } }] };
    const world = chatWorld({ tasks: [task], runs: [previous] });
    const created = new Map();
    const spawned = [], sent = [];
    const request = async (endpoint, body, options) => {
      if (endpoint === "/api/v1/ao/read" && body.run_id) {
        const run = created.get(body.run_id) ?? { id: body.run_id, workspace_id: "ws-1", project_id: "task-1", execution_mode: "single", revision: 1,
          grant: { executable_sha256: "a".repeat(64) }, nodes: [{ id: "one", role: "planner", state: "pending", parents: [], route: followRoute }] };
        created.set(body.run_id, run);
        return { ok: true, runs: [run], worker_capacity: { [body.run_id]: 1 } };
      }
      const latest = [...created.values()].at(-1);
      if (endpoint === "/api/v1/ao/grant") return { ok: true, run: latest, grant: { executable_sha256: "a".repeat(64) } };
      if (endpoint === "/api/v1/ao/external/reserve") { latest.nodes[0].state = "reserved"; return { ok: true, request_key: "key-1", prompt: "full prompt" }; }
      if (endpoint === "/api/v1/ao/external/submitted") { latest.nodes[0].state = "running"; latest.nodes[0].receipt = { thread_id: body.session_id }; return { ok: true, run: latest }; }
      if (endpoint === "/api/v1/ao/external/terminal") { latest.nodes[0].state = "finished"; return { ok: true, run: latest }; }
      return world.requestHeadless(endpoint, body, options);
    };
    const workflow = createAgentOrchestratorWorkflow({
      requestHeadless: request, findCodexExecutable: () => process.execPath,
      resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
      aoHarness: {
        spawn: async input => { spawned.push(input); return "fresh-session"; },
        continuable: async () => true,
        send: async (id, text) => { sent.push([id, text]); if (sendFails) throw new Error("CHAT_TURN_RUNNING"); return { turnId: "turn-2" }; },
        observe: async (id, expected) => ({ status: "idle", turnId: expected ?? "t1", turnState: "completed", answer: "ok" }),
      },
    });
    await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "now run the tests", executionMode: "single", singleRoute: followRoute });
    for (let tries = 0; tries < 200 && !spawned.length && !(sent.length && !sendFails); tries++) await new Promise(resolve => setTimeout(resolve, 10));
    return { spawned, sent };
  };
  const tightened = await scenario({ followRoute: { ...base, native_permission_profile: ":workspace", approval_policy: "on-request" } });
  assert.equal(tightened.sent.length, 0, "a session started with full access is not reused once the user asks for approval");
  assert.equal(tightened.spawned.length, 1);
  assert.equal(tightened.spawned[0].approvalMode, "accept-edits", "the fresh session gets the new permission mode");
  const refused = await scenario({ followRoute: base, sendFails: true });
  assert.equal(refused.sent.length, 1);
  assert.equal(refused.spawned.length, 1, "a refused follow-up starts a fresh session instead of failing the card");
});

test("reading an AO card's status never records its result, and team steering goes to the orchestrator", async () => {
  const route = { harness_id: "ao:claude-code", model: "cpa/test-model" };
  const mission = { id: "run", workspace_id: "ws", revision: 1, execution_mode: "team", nodes: [
    { id: "lead", role: "planner", state: "running", route, receipt: { thread_id: "lead-session" } },
    { id: "w1", role: "worker", state: "running", route, receipt: { thread_id: "worker-session" } }] };
  const posted = [], steered = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async (endpoint) => {
      if (endpoint.endsWith("/harness/status")) return { ok: true, status: { connected: false } };
      if (endpoint.endsWith("/read")) return { ok: true, runs: [mission] };
      posted.push(endpoint);
      return { ok: true, run: mission };
    },
    aoHarness: {
      observe: async () => ({ status: "idle", turnId: "t", turnState: "completed", answer: "done",
        approvals: [] }),
      steer: async (id, text) => { steered.push([id, text]); return { steered: true }; },
    },
  });
  const status = await workflow.call("harness_status", { workspaceId: "ws", runId: "run", nodeId: "w1" });
  assert.equal(status.status.connected, true);
  assert.deepEqual(posted, [], "a status read must not post the finished turn's result");
});

test("a team with a Command approver never falls back to card-level auto-review", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
  const decisions = [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }];
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "team", grant: { executable_sha256: "a".repeat(64) }, nodes: [
    { id: "approver", role: "approver", state: "running", parents: [], route },
    { id: "w1", role: "worker", state: "running", parents: [], route, receipt: { thread_id: "worker-session" } }] };
  const resolved = [];
  let asked = 0;
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "test-model" }] }) };
      asked++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"allow","reason":"fixture"}' } }] }) };
    },
    requestHeadless: async endpoint => endpoint.endsWith("/read") ? { ok: true, runs: [mission], worker_capacity: { run: 2 } } : { ok: true, run: mission },
    aoHarness: {
      observe: async (id) => ({ status: "working", turnId: "t", turnState: "running",
        approvals: id === "worker-session" ? [{ approval_id: "req", source: "ao", kind: "command", command: "npm test", tool: "Bash", decisions }] : [] }),
      resolveApproval: async (...args) => { resolved.push(args); return { ok: true }; },
    },
  });
  await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
  await new Promise(resolve => setTimeout(resolve, 600));
  mission.nodes.forEach(node => { node.state = "finished"; });
  for (let tries = 0; tries < 100; tries++) {
    if ((await workflow.call("run_status", { workspaceId: "ws", runId: "run" })).status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(resolved.length, 0, "the request waits for the team's approver (or the person), not the card's own reviewer");
  assert.equal(asked, 0);
});

test("steering a team chat reaches its orchestrator, not a worker", async () => {
  const route = { harness_id: "ao:claude-code", model: "cpa/test-model" };
  const task = { id: "task-1", title: "Fix auth", description: "first ask", state: "in_progress", clauses: [] };
  const world = chatWorld({ tasks: [task], runs: [{ id: "r1", project_id: "task-1", execution_mode: "team", cancelled: false, nodes: [
    { id: "w1", role: "worker", state: "running", route, receipt: { thread_id: "worker-session" } },
    { id: "lead", role: "planner", state: "running", route, receipt: { thread_id: "lead-session" } }] }] });
  const steered = [];
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless,
    aoHarness: { steer: async (id, text) => { steered.push([id, text]); return { steered: true }; } } });
  await workflow.call("chat_steer", { workspaceId: "ws-1", taskId: "task-1", message: "focus on the UI" });
  assert.deepEqual(steered, [["lead-session", "focus on the UI"]]);
});

test("a follow-up that would overflow a long chat compacts it first instead of refusing", async () => {
  const task = { id: "task-1", title: "Long job", description: "x".repeat(8180), state: "in_progress", clauses: [] };
  const world = chatWorld({ tasks: [task], runs: [{ id: "r1", project_id: "task-1", cancelled: false, nodes: [{ state: "finished" }] }] });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/c.exe",
    resolveHarness: async () => { throw new Error("stop before the background loop"); },
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "fixture" }),
    fetchImpl: async (url) => String(url).endsWith("/models")
      ? { ok: true, json: async () => ({ data: [{ id: "test-model" }] }) }
      : { ok: true, json: async () => ({ choices: [{ message: { content: "Did the first half; next: the second half." } }] }) },
  });
  await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "keep going" });
  const final = world.tasks[0].description;
  assert.match(final, /^Summary of the earlier conversation \(compacted [^)]+ UTC\):\nDid the first half; next: the second half\.\n\nFollow-up \([^)]+ UTC\):\nkeep going$/);
  assert.ok(final.length < 8192);
});

test("a card stopped while its agent launched also stops that agent once its session arrives", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model" };
  const mission = { id: "run", workspace_id: "ws", revision: 1, execution_mode: "single", cancelled: false, grant: { executable_sha256: "a".repeat(64) },
    nodes: [{ id: "one", role: "planner", state: "pending", parents: [], route }] };
  const interrupted = [];
  const workflow = createAgentOrchestratorWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    requestHeadless: async (endpoint) => {
      if (endpoint.endsWith("/read")) return { ok: true, runs: [mission], worker_capacity: { run: 1 } };
      if (endpoint.endsWith("/grant")) return { ok: true, run: mission, grant: { executable_sha256: "a".repeat(64) } };
      if (endpoint.endsWith("/external/reserve")) { mission.nodes[0].state = "reserved"; return { ok: true, request_key: "k", prompt: "task" }; }
      if (endpoint.endsWith("/external/submitted")) throw new Error("AO node is not reserved");
      return { ok: true, run: mission };
    },
    aoHarness: {
      // The user stops the card while AO is still launching its agent.
      spawn: async () => { mission.cancelled = true; mission.nodes[0].state = "cancelled"; return "late-session"; },
      interrupt: async (id) => { interrupted.push(id); },
      observe: async () => ({ status: "idle", turnState: "completed" }),
    },
  });
  await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
  for (let tries = 0; tries < 200 && !interrupted.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(interrupted, ["late-session"], "the agent launched for a stopped card is not left running unseen");
});

test("a new chat's first message runs in the session pre-warmed for its model, and another is warmed", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "user" };
  const world = chatWorld();
  const created = new Map();
  const spawned = [], sent = [], observedWith = [], killed = [];
  const request = async (endpoint, body, options) => {
    if (endpoint === "/api/v1/ao/read" && body.run_id) {
      const run = created.get(body.run_id) ?? { id: body.run_id, workspace_id: "ws-1", project_id: "task-1", execution_mode: "single", revision: 1,
        grant: { executable_sha256: "a".repeat(64) }, nodes: [{ id: "one", role: "planner", state: "pending", parents: [], route }] };
      created.set(body.run_id, run);
      return { ok: true, runs: [run], worker_capacity: { [body.run_id]: 1 } };
    }
    const latest = [...created.values()].at(-1);
    if (endpoint === "/api/v1/ao/grant") return { ok: true, run: latest, grant: { executable_sha256: "a".repeat(64) } };
    if (endpoint === "/api/v1/ao/external/reserve") { latest.nodes[0].state = "reserved"; return { ok: true, request_key: "key-1", prompt: "fix the login" }; }
    if (endpoint === "/api/v1/ao/external/submitted") { latest.nodes[0].state = "running"; latest.nodes[0].receipt = { thread_id: body.session_id }; return { ok: true, run: latest }; }
    if (endpoint === "/api/v1/ao/external/terminal") { latest.nodes[0].state = "finished"; return { ok: true, run: latest }; }
    return world.requestHeadless(endpoint, body, options);
  };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: request, findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    aoHarness: {
      spawn: async input => { spawned.push(input); return `warm-${spawned.length}`; },
      continuable: async id => id.startsWith("warm-"),
      send: async (id, text, key) => { sent.push([id, text, key]); return { turnId: "turn-1", state: "running" }; },
      observe: async (id, expected) => { observedWith.push([id, expected]); return { status: "idle", turnId: expected, turnState: "completed", answer: "fixed" }; },
      warmSessions: async () => ["left-over"],
      kill: async id => { killed.push(id); return { ok: true }; },
    },
  });
  const warmed = await workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "single", singleRoute: route });
  assert.equal(warmed.warmed, true);
  assert.equal((await workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "single", singleRoute: { ...route } })).warmed, true);
  assert.equal(spawned.length, 1, "one warm session per project and route");
  assert.equal(spawned[0].prompt, "", "started without a prompt");
  assert.equal(spawned[0].warm, true);
  assert.equal(spawned[0].plain, true, "a single-model chat is plain, like its real launch");
  assert.equal(spawned[0].model, "test-model");
  for (let tries = 0; tries < 50 && !killed.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(killed, ["left-over"], "an unused warm session from an earlier run is ended");

  await workflow.call("chat_send", { workspaceId: "ws-1", message: "fix the login", executionMode: "single", singleRoute: route });
  for (let tries = 0; tries < 200 && !observedWith.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [["warm-1", "fix the login", "key-1"]], "the first message is the warm session's first turn");
  assert.deepEqual(JSON.parse(JSON.stringify(observedWith[0])), ["warm-1", "turn-1"], "observed on that turn");
  for (let tries = 0; tries < 50 && spawned.length < 2; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(spawned.length, 2, "the next chat on this route finds one waiting too");
  assert.equal(spawned[1].prompt, "");
});

test("pre-warming skips a team without an orchestrator and native Codex routes", async () => {
  const world = chatWorld();
  const spawned = [];
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless,
    aoHarness: { spawn: async input => { spawned.push(input); return "s"; } } });
  assert.equal((await workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "team", teamId: "team-1" })).warmed, false);
  assert.equal((await workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "single", singleRoute: { harness_id: "codex", model: "gpt-5" } })).warmed, false);
  assert.equal(spawned.length, 0);
});

test("idle agents are released on a timer, never a pre-warmed one, and the timer stops on dispose", async () => {
  const timers = [];
  const released = [];
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model" };
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: chatWorld().requestHeadless, releaseIdleAgents: true,
    setTimer: (run, delay) => { const timer = { run, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    aoHarness: {
      spawn: async () => "warm-1",
      idleChatSessions: async idleMs => { assert.equal(idleMs, 30 * 60_000); return ["old-1", "warm-1", "old-2"]; },
      exitAgent: async id => { released.push(id); if (id === "old-2") throw new Error("busy now"); return { ok: true }; },
    } });
  await workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "single", singleRoute: route });
  await new Promise(resolve => setTimeout(resolve, 10));
  const first = timers.find(timer => timer.delay === 2 * 60_000);
  assert.ok(first, "the first sweep runs two minutes after start");
  first.run();
  for (let tries = 0; tries < 50 && timers.length < 3; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(released, ["old-1", "old-2"], "the pre-warmed session is kept; a refused release does not stop the sweep");
  assert.ok(timers.some(timer => timer.delay === 10 * 60_000), "then every ten minutes");
  workflow.dispose();
  assert.ok(timers.at(-1).cleared, "dispose stops it");
});

test("an open chat pre-warms only when its next message cannot continue its agent, and at most two wait", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model" };
  const other = { ...route, model: "cpa/other-model" };
  const third = { ...route, model: "cpa/third-model" };
  const task = { id: "task-1", title: "Fix auth", description: "first ask", state: "in_progress", clauses: [] };
  const stopped = { id: "r1", project_id: "task-1", execution_mode: "single", cancelled: true,
    nodes: [{ id: "one", role: "planner", state: "cancelled", parents: [], route, receipt: { thread_id: "sess-1" } }] };
  const world = chatWorld({ tasks: [task], runs: [stopped] });
  const spawned = [], killed = [], checked = [];
  let alive = true;
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless,
    aoHarness: {
      spawn: async input => { spawned.push(input.model); return `warm-${spawned.length}`; },
      continuable: async id => { checked.push(id); return id === "sess-1" ? alive : true; },
      kill: async id => { killed.push(id); return { ok: true }; },
      warmSessions: async () => [],
    } });
  const same = await workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "single", singleRoute: route, taskId: "task-1" });
  assert.equal(same.continues, true, "a stopped card's live agent takes the next message (Stop only interrupts the turn)");
  assert.deepEqual(checked, ["sess-1"], "checking it also wakes an agent released while idle");
  assert.equal(spawned.length, 0);
  alive = false;
  assert.equal((await workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "single", singleRoute: route, taskId: "task-1" })).warmed, true,
    "an agent that is gone is replaced ahead of the message");
  await workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "single", singleRoute: other, taskId: "task-1" });
  await workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "single", singleRoute: third });
  for (let tries = 0; tries < 50 && !killed.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(spawned, ["test-model", "other-model", "third-model"]);
  assert.deepEqual(killed, ["warm-1"], "the oldest waiting agent is ended once a third is warmed");
});

// ---- Delete message ----

test("deleting a chat message removes it and its steers from the task and hides its run from the chat", async () => {
  const description = "first ask\n\nFollow-up (2026-10-10 10:00 UTC):\nsecond ask\n\n↳ Steer (2026-10-10 10:05 UTC): use pnpm"
    + "\n\nFollow-up (2026-10-10 11:00 UTC):\nthird ask";
  const done = (id, task = "task-1") => ({ id, workspace_id: "ws-1", project_id: task, cancelled: false, nodes: [{ id: "one", role: "planner", state: "finished" }] });
  const world = chatWorld({ tasks: [{ id: "task-1", title: "Fix auth", description, state: "in_progress", clauses: [] },
    { id: "task-2", title: "Alone", description: "only ask", state: "in_progress", clauses: [] }],
  runs: [done("r1"), done("other", "task-2"), done("r2"), done("r3")] });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless });
  const remove = (index, runId, extra = {}) => workflow.call("chat_delete_message", { workspaceId: "ws-1", taskId: "task-1", index, runId, ...extra });
  const deleted = await remove(1, "r2");
  assert.deepEqual(JSON.parse(JSON.stringify(deleted)), { ok: true, taskId: "task-1", index: 1, runIds: ["r2"] }, "the run the chat showed under message 1");
  assert.equal(world.tasks[0].description, "first ask\n\nFollow-up (2026-10-10 11:00 UTC):\nthird ask", "the steer goes with its message");
  assert.equal(world.edits[0].title, "Fix auth");
  assert.deepEqual((await workflow.call("runs", { workspaceId: "ws-1" })).runs.map(run => run.id), ["r1", "other", "r3"],
    "the run stays in AO's history but not in the chat, so r3 still answers the third message");
  // Indexes count the messages the chat shows now: deleting the first makes the next one first.
  assert.deepEqual([...(await remove(0, "r1")).runIds], ["r1"]);
  assert.equal(world.tasks[0].description, "third ask");
  assert.deepEqual((await workflow.call("runs", { workspaceId: "ws-1" })).runs.map(run => run.id), ["other", "r3"]);
  await assert.rejects(remove(0, "r3"), /only message; archive or delete the chat instead/);
  await assert.rejects(workflow.call("chat_delete_message", { workspaceId: "ws-1", taskId: "task-2", index: 0, runId: "other" }), /only message/);
  world.tasks[0].description = description;
  await assert.rejects(remove(4, "r3"), /no longer in this chat/);
  // The reply must be one this chat shows: not a deleted run, another chat's run, or none at all.
  await assert.rejects(remove(1, "r2"), /reply was not found; reload the chat/);
  await assert.rejects(remove(1, "other"), /reply was not found/);
  await assert.rejects(remove(1, "r3", { runIds: ["r2"] }), /reply was not found/);
  await assert.rejects(remove(1, undefined), /no reply yet/);
  // A working chat refuses: its latest run is still open.
  world.runs.push({ id: "busy", workspace_id: "ws-1", project_id: "task-1", cancelled: false, nodes: [{ id: "a", role: "planner", state: "running" }] });
  const edits = world.edits.length;
  await assert.rejects(remove(1, "r3"), /Stop the chat first/);
  assert.equal(world.edits.length, edits, "nothing is changed");
});

// The chat's own pairing (ao-chat.ts), to check what a deletion leaves on screen.
const aoChat = (() => {
  const vm = require("node:vm");
  const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ao-chat.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { exports, require: () => ({}) });
  return exports;
})();

test("a restarted message keeps its restart: deleting the next message hides that message's own run, and every turn keeps its message", async () => {
  const description = "first ask\n\nFollow-up (2026-10-10 10:00 UTC):\nsecond ask\n\nFollow-up (2026-10-10 11:00 UTC):\nthird ask";
  const done = (id) => ({ id, workspace_id: "ws-1", project_id: "task-1", cancelled: false, revision: 1,
    nodes: [{ id: "lead", role: "planner", state: "finished", receipt: { answer: `answer of ${id}` } }] });
  const world = chatWorld({ tasks: [{ id: "task-1", title: "Fix auth", description, state: "in_progress", clauses: [] }], runs: [done("r1")] });
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: world.requestHeadless, findCodexExecutable: () => "C:/codex.exe",
    resolveHarness: async () => { throw new Error("stop before the background loop"); } });
  // Restart mission on the first message: a second run of it, with no new message.
  const restarted = await workflow.call("restart_run", { workspaceId: "ws-1", runId: "r1" });
  world.runs.push(done(restarted.runId), done("r2"), done("r3"));
  const shown = async () => (await workflow.call("runs", { workspaceId: "ws-1" })).runs.filter(run => run.project_id === "task-1");
  const turns = async () => aoChat.chatTurns(await shown(), world.tasks[0].description)
    .map(turn => [turn.runId === restarted.runId ? "restart" : turn.runId, turn.user?.text ?? null, turn.messageIndex ?? null]);
  assert.deepEqual(JSON.parse(JSON.stringify(await turns())),
    [["r1", "first ask", 0], ["restart", null, null], ["r2", "second ask", 1], ["r3", "third ask", 2]],
    "the restart answers the first message again; it does not take the second message");
  // Delete the second message as the chat does: its turn's run, and the runs of that message.
  const second = aoChat.chatTurns(await shown(), world.tasks[0].description).find(turn => turn.messageIndex === 1);
  const runIds = aoChat.chatRunsOfMessage(await shown(), second.runId);
  assert.deepEqual([...runIds], ["r2"]);
  await workflow.call("chat_delete_message", { workspaceId: "ws-1", taskId: "task-1", index: second.messageIndex, runId: runIds[0], runIds: runIds.slice(1) });
  assert.deepEqual(JSON.parse(JSON.stringify(await turns())), [["r1", "first ask", 0], ["restart", null, null], ["r3", "third ask", 1]],
    "the second message's own run is hidden, not the first message's restart");
  // Deleting the first message takes its restart along, even if the chat named only the first run.
  await workflow.call("chat_delete_message", { workspaceId: "ws-1", taskId: "task-1", index: 0, runId: "r1" });
  assert.deepEqual(JSON.parse(JSON.stringify(await turns())), [["r3", "third ask", 0]], "no turn is left without its message");
});

test("after a deleted message the next turn starts a fresh agent session (chat_send and chat_prewarm), then continues its own", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
    permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "user" };
  const task = { id: "task-1", title: "Fix auth", description: "first ask\n\nFollow-up (2026-10-10 10:00 UTC):\nsecond ask", state: "in_progress", clauses: [] };
  const single = (id, session) => ({ id, workspace_id: "ws-1", project_id: "task-1", execution_mode: "single", cancelled: false,
    nodes: [{ id: "one", role: "planner", state: "finished", parents: [], route, receipt: { thread_id: session } }] });
  const world = chatWorld({ tasks: [task], runs: [single("r1", "sess-1"), single("r2", "sess-1")] });
  const created = new Map();
  const spawned = [], sent = [], observed = [];
  const request = async (endpoint, body, options) => {
    if (endpoint === "/api/v1/ao/read" && body.run_id) {
      const run = created.get(body.run_id) ?? { id: body.run_id, workspace_id: "ws-1", project_id: "task-1", execution_mode: "single", revision: 1,
        grant: { executable_sha256: "a".repeat(64) }, nodes: [{ id: "one", role: "planner", state: "pending", parents: [], route }] };
      created.set(body.run_id, run);
      return { ok: true, runs: [run], worker_capacity: { [body.run_id]: 1 } };
    }
    const latest = [...created.values()].at(-1);
    if (endpoint === "/api/v1/ao/grant") return { ok: true, run: latest, grant: { executable_sha256: "a".repeat(64) } };
    if (endpoint === "/api/v1/ao/external/reserve") { latest.nodes[0].state = "reserved"; return { ok: true, request_key: `key-${created.size}`, prompt: "first ask\n\nFollow-up: third ask" }; }
    if (endpoint === "/api/v1/ao/external/submitted") { latest.nodes[0].state = "running"; latest.nodes[0].receipt = { thread_id: body.session_id }; return { ok: true, run: latest }; }
    if (endpoint === "/api/v1/ao/external/terminal") { latest.nodes[0].state = "finished"; return { ok: true, run: latest }; }
    return world.requestHeadless(endpoint, body, options);
  };
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: request, findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    aoHarness: {
      spawn: async input => { spawned.push(input); return input.warm ? "warm-1" : "new-session"; },
      continuable: async () => true,
      send: async (id, text, key) => { sent.push([id, text, key]); return { turnId: `turn-${sent.length}`, state: "running" }; },
      observe: async (id, expected) => { observed.push([id, expected]); return { status: "idle", turnId: expected, turnState: "completed", answer: "done" }; },
      kill: async () => ({ ok: true }), warmSessions: async () => [],
    },
  });
  const prewarm = () => workflow.call("chat_prewarm", { workspaceId: "ws-1", executionMode: "single", singleRoute: route, taskId: "task-1" });
  assert.equal((await prewarm()).continues, true, "before the delete the chat's agent takes the next message");
  await workflow.call("chat_delete_message", { workspaceId: "ws-1", taskId: "task-1", index: 1, runId: "r2" });
  const warmed = await prewarm();
  assert.equal(warmed.continues, undefined, "the old agent still remembers the deleted exchange");
  assert.equal(warmed.warmed, true, "a fresh agent is made ready instead");
  await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "third ask", executionMode: "single", singleRoute: route });
  for (let tries = 0; tries < 200 && !observed.length; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(observed.length, "the fresh turn ran");
  assert.ok(!sent.some(([id]) => id === "sess-1"), "nothing continues the old session");
  const fresh = [...spawned.filter(input => !input.warm).map(input => input.prompt), ...sent.map(([, text]) => text)];
  assert.ok(fresh.includes("first ask\n\nFollow-up: third ask"), "the fresh agent gets the whole chat as it now reads");
  for (let tries = 0; tries < 200 && [...created.values()][0]?.nodes[0].state !== "finished"; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  // The flag is cleared by that turn: its own session is continued from here on.
  world.runs.push(single("r3", "sess-3"));
  assert.equal((await prewarm()).continues, true);
  const before = sent.length;
  await workflow.call("chat_send", { workspaceId: "ws-1", taskId: "task-1", message: "fourth ask", executionMode: "single", singleRoute: route });
  for (let tries = 0; tries < 200 && sent.length === before; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(sent.at(-1).slice(0, 2), ["sess-3", "fourth ask"]);
});

test("an AO request can be answered with any decision the agent offered, and only those", async () => {
  const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model" };
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) },
    nodes: [{ id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "session-1" } }] };
  const resolved = [], confirmed = [];
  const workflow = createAgentOrchestratorWorkflow({
    requestHeadless: async endpoint => endpoint.endsWith("/read") ? { ok: true, runs: [mission], worker_capacity: { run: 1 } }
      : endpoint.endsWith("/harness/status") ? { ok: true, status: { connected: false } } : { ok: true, run: mission },
    confirm: async input => { confirmed.push(input.message); return true; },
    aoHarness: {
      observe: async () => ({ status: "needs_input", turnState: "running", approvals: [{ approval_id: "req-plan", source: "ao", kind: "plan", tool: "ExitPlanMode",
        plan: "1. Add /register", decisions: [{ id: "acceptEdits", kind: "allow_always", label: "Yes, and accept edits" }, { id: "plan", kind: "reject_once", label: "No, keep planning" }] }] }),
      resolveApproval: async (session, request, decision) => { resolved.push([session, request, decision]); return { ok: true }; },
    },
  });
  const input = { workspaceId: "ws", runId: "run", nodeId: "one", approvalId: "req-plan" };
  await workflow.call("approve_harness", { ...input, decisionId: "acceptEdits" });
  assert.deepEqual(resolved, [["session-1", "req-plan", "acceptEdits"]], "the chosen option, not a generic allow");
  assert.deepEqual(confirmed, ["Yes, and accept edits?"]);
  await assert.rejects(workflow.call("approve_harness", { ...input, decisionId: "bypassPermissions" }), /did not offer that answer/);
  await assert.rejects(workflow.call("approve_harness", { ...input, decisionId: "plan", allow: true }), /typed native reply or legacy Allow\/Deny/);
});
