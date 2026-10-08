const test = require("node:test");
const assert = require("node:assert/strict");
const { lookupCpaRate, estimateCpaCost, accountingMeasurements } = require("../electron/agent-orchestrator-accounting.cjs");
const rate = { provider:"openai",model:"gpt-5.5",input_usd_per_million:2,output_usd_per_million:8,
  cache_read_usd_per_million:0.5,cache_creation_usd_per_million:3,request_usd:0,source:"manual",updated_ms:123 };
const catalog={prices:[rate]};

test("mission accounting deduplicates owned session history and ignores foreign or unscoped sessions", async () => {
  const {collectMissionAccounting}=require("../electron/agent-orchestrator-accounting.cjs");
  const receipt={thread_id:"owned",route:{harness_id:"ao:codex",model:"cpa/gpt-5.5"}};
  const runs=[{id:"run-a",nodes:[{receipt,history:[receipt,{...receipt,thread_id:"foreign"}]}]},
    {id:"run-b",nodes:[{receipt}]}];
  const calls=[];
  const result=await collectMissionAccounting({runs,projectId:"project-a",catalog,
    readSession:async id=>{
      calls.push(id);
      return {session:{id,projectId:id==="foreign"?"project-b":"project-a"},
        normalized:{sessionId:id,harnesses:[{harness:"codex",models:[{modelId:"gpt-5.5",
          totals:{uncachedInputTokens:10,cachedInputTokens:2,outputTokens:3,processedTokens:15}}]}]}};
    }});
  assert.deepEqual(calls.sort(),["foreign","owned"]);
  assert.equal(result["run-a"].processedTokens,15);
  assert.equal(result["run-a"].coverage,"partial");
  assert.equal(result["run-a"].cost.source,"CPA Helper");
  assert.equal(result["run-b"].processedTokens,15);
  assert.equal(result["run-b"].coverage,"complete");
  const unscoped=await collectMissionAccounting({runs,projectId:null,catalog,readSession:()=>{throw Error("must not read")}});
  assert.equal(unscoped["run-a"].processedTokens,null);
});

test("latest mission snapshots remain partial and missing pricing never turns into a vendor price", async () => {
  const {collectMissionAccounting}=require("../electron/agent-orchestrator-accounting.cjs");
  const result=await collectMissionAccounting({projectId:"p",catalog:{prices:[]},
    runs:[{id:"r",nodes:[{receipt:{thread_id:"s",route:{harness_id:"ao:opencode",model:"cpa/gpt-5.5"}}}]}],
    readSession:async()=>({session:{id:"s",projectId:"p"},conversation:{usage:{inputTokens:10,
      cachedTokens:0,outputTokens:2,totalTokens:13,cost:400}}})});
  assert.equal(result.r.processedTokens,13);
  assert.equal(result.r.coverage,"partial");
  assert.equal(result.r.cost.totalNanos,null);
  assert.equal(result.r.sessions[0].measurements[0].source,"latest_snapshot");
});
const full={source:"normalized_session",uncachedInputTokens:1000000,cachedInputTokens:1000000,
  cacheCreationTokens:0,outputTokens:1000000,processedTokens:3000000,cacheWritesPossible:false};

test("actual subscription-route tokens are retained without labelling them CPA billing",async()=>{
  const {collectMissionAccounting}=require("../electron/agent-orchestrator-accounting.cjs");
  const make=async model=>collectMissionAccounting({projectId:"p",catalog,runs:[{id:"r",nodes:[{receipt:{
    thread_id:"s",route:{harness_id:"ao:codex",model}}}]}],readSession:async()=>({
    session:{id:"s",projectId:"p"},normalized:{sessionId:"s",harnesses:[{harness:"codex",models:[
      {modelId:"gpt-5.5",totals:{uncachedInputTokens:1000000,cachedInputTokens:0,outputTokens:1000000,processedTokens:2000000}}]}]}})});
  const subscription=await make("gpt-5.5"),gateway=await make("cpa/gpt-5.5");
  assert.equal(subscription.r.processedTokens,2000000);
  assert.equal(subscription.r.cost.totalNanos,null);
  assert.equal(gateway.r.cost.totalNanos,8000000000);
});

test("bounded board accounting prioritizes newest actual missions over old retained attempts", async()=>{
  const {collectMissionAccounting}=require("../electron/agent-orchestrator-accounting.cjs");
  const runs=Array.from({length:205},(_,i)=>({id:"r"+i,nodes:[{receipt:{
    thread_id:"s"+i,route:{harness_id:"ao:codex",model:"cpa/gpt-5.5"}}}]}));
  const result=await collectMissionAccounting({runs,projectId:"p",catalog,readSession:async id=>({
    session:{id,projectId:"p"},normalized:{sessionId:id,harnesses:[{harness:"codex",models:[{
      modelId:"gpt-5.5",totals:{uncachedInputTokens:1,cachedInputTokens:0,outputTokens:1,processedTokens:2}}]}]}})});
  assert.equal(result.r204.processedTokens,2);
  assert.equal(result.r0.processedTokens,null);
});

test("CPA estimates use exact configured category rates rather than an AO estimate", () => {
  const found=lookupCpaRate(catalog,"cpa/gpt-5.5");
  const result=estimateCpaCost({...full,estimatedCost:{totalNanos:999}},found);
  assert.equal(result.totalNanos,10500000000);
  assert.equal(result.coverage,"complete");
  assert.equal(result.source,"CPA Helper");
});

test("unknown or ambiguous exact prices stay unavailable; measured zero is not missing usage", () => {
  assert.equal(lookupCpaRate(catalog,"gemini-3.8-flash-high"),null);
  assert.equal(lookupCpaRate({prices:[rate,{...rate,provider:"other"}]},"gpt-5.5"),null);
  assert.equal(estimateCpaCost(full,null).totalNanos,null);
  assert.equal(estimateCpaCost({...full,uncachedInputTokens:0,cachedInputTokens:0,outputTokens:0,processedTokens:0},rate).totalNanos,0);
  assert.equal(estimateCpaCost({source:"unreported"},rate).totalNanos,null);
});

test("folded cache writes and unreported request counts produce partial estimates, not invented splits", () => {
  const result=estimateCpaCost({...full,cacheWritesPossible:true,cacheCreationTokens:undefined},rate);
  assert.equal(result.totalNanos,8500000000);
  assert.equal(result.coverage,"partial");
  const requestFee=estimateCpaCost(full,{...rate,request_usd:0.1});
  assert.equal(requestFee.totalNanos,10500000000);
  assert.equal(requestFee.coverage,"partial");
  assert.equal(estimateCpaCost(full,{...rate,input_usd_per_million:-1}).totalNanos,null);
});

test("normalized model measurements win; actual latest snapshot remains explicitly partial", () => {
  const normalized={sessionId:"s1",incomplete:false,harnesses:[{harness:"codex",models:[{modelId:"gpt-5.5",
    totals:{uncachedInputTokens:10,cachedInputTokens:2,outputTokens:3,processedTokens:15}}]}]};
  const snapshot={usage:{inputTokens:8869,outputTokens:38,cachedTokens:0,totalTokens:8944,contextUsed:8869,cost:0.046595}};
  const n=accountingMeasurements(normalized,snapshot,"cpa/gpt-5.5","codex");
  assert.equal(n.length,1); assert.equal(n[0].source,"normalized_session"); assert.equal(n[0].processedTokens,15);
  const latest=accountingMeasurements(null,snapshot,"cpa/gpt-5.5","opencode");
  assert.equal(latest.length,1); assert.equal(latest[0].source,"latest_snapshot"); assert.equal(latest[0].processedTokens,8944);
  assert.equal(estimateCpaCost(latest[0],rate).coverage,"partial");
  assert.deepEqual(accountingMeasurements(null,{usage:null},"gemini-3.8-flash-high","agy"),[]);
});

test("normalized Codex usage does not certify that a CPA model has no cache writes", () => {
  const normalized={sessionId:"s",harnesses:[{harness:"codex",models:[{modelId:"gpt-5.5",totals:{
    uncachedInputTokens:1000000,cachedInputTokens:0,outputTokens:1000000,processedTokens:2000000}}]}]};
  const [m]=accountingMeasurements(normalized,null,"cpa/gpt-5.5","codex");
  assert.equal(m.cacheCreationTokens,null); assert.equal(m.cacheWritesPossible,true);
  const result=estimateCpaCost(m,rate);
  assert.equal(result.totalNanos,8000000000); assert.equal(result.coverage,"partial");
});

test("CPA catalog reader uses saved rows, refreshes on modification and fails closed on malformed replacement", async () => {
  const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
  const {readCpaCatalog}=require("../electron/agent-orchestrator-accounting.cjs");
  const dir=path.resolve(__dirname,"../../aiTemp/mission-accounting",crypto.randomUUID());
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,"prices.json");
  try {
    fs.writeFileSync(file,JSON.stringify({version:1,prices:[rate]}));
    const first=readCpaCatalog(file);
    assert.equal(lookupCpaRate(first,"gpt-5.5").input_usd_per_million,2);
    assert.equal(readCpaCatalog(file),first);
    fs.writeFileSync(file,JSON.stringify({version:1,prices:[{...rate,input_usd_per_million:9}]}));
    const future=new Date(Date.now()+1000);fs.utimesSync(file,future,future);
    assert.equal(lookupCpaRate(readCpaCatalog(file),"gpt-5.5").input_usd_per_million,9);
    fs.writeFileSync(file,"{bad");
    assert.equal(readCpaCatalog(file).unavailable,true);
    assert.equal(lookupCpaRate(readCpaCatalog(file),"gpt-5.5"),null);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
