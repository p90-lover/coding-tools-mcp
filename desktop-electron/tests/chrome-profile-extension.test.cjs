"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),crypto=require("node:crypto");
const {createChromeProfileCapture,EXTENSION_ID,EXTENSION_ORIGIN}=require("../electron/chrome-profile-login.cjs");
const keys=crypto.generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"der"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
const identity={publicKey:keys.publicKey.toString("base64"),privateKey:keys.privateKey};
const FIXTURE_USER={id:"user-Fixture0000000000000001",email:"fixture@example.test"};
const wait=async condition=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error("Extension fixture did not settle");};
function worker({trusted,authenticated=true,cookieState,helloTransform,platformTabs=[]}={}){
 const session={},local=trusted?{trustedAppKey:trusted}:{},listeners={},calls={cookies:[],tabs:[],captures:0,checks:0};
 const event=name=>({addListener:fn=>{listeners[name]=fn;}});
 const storage=store=>({get:async name=>({[name]:store[name]}),set:async value=>Object.assign(store,structuredClone(value))});
 const cookie=(domain,name="session")=>({domain,name,value:"fixture-only",path:"/",httpOnly:true,secure:true,sameSite:"lax"});
 let tabs=[{id:7,url:"https://chatgpt.com/",active:true}];
 const chrome={runtime:{id:EXTENSION_ID,getURL:name=>`${EXTENSION_ORIGIN}/${name}`,onMessageExternal:event("external"),onMessage:event("internal")},storage:{session:storage(session),local:storage(local)},
  cookies:{onChanged:event("cookies"),getAll:async query=>{calls.cookies.push(query.domain);return cookieState?.(query.domain)??[cookie(`.${query.domain}`)];}},
  // A signed-in tab answers with its session's ChatGPT login; `authenticated` may give another.
  scripting:{executeScript:async options=>{calls.checks++;assert.equal(options.target.tabId,7);assert(options.func.toString().includes("/api/auth/session"));assert(!options.func.toString().includes("accessToken"));return[{result:authenticated===true?FIXTURE_USER:authenticated}];}},
  // Platform tabs (connector 1.2.0) are read by URL and load state only, never scripted.
  tabs:{onUpdated:event("tabs"),query:async query=>{if(Array.from(query.url)[0]==="https://platform.openai.com/*")return platformTabs;assert.deepEqual(Array.from(query.url),["https://chatgpt.com/*"]);return tabs;},create:async value=>{calls.tabs.push(value.active===false?`${value.url} (background)`:value.url);return{id:9,...value};}}};
 const fetcher=async(url,options)=>{if(new URL(url).pathname==="/capture"){calls.captures++;assert(!options.body.includes('fixture-only'));assert(!options.body.includes('excluded'));}const response=await fetch(url,{...options,headers:{...options.headers,Origin:EXTENSION_ORIGIN}});if(helloTransform&&new URL(url).pathname==="/hello"){const body=helloTransform(await response.json());return{ok:response.ok,status:response.status,url:response.url,text:async()=>JSON.stringify(body)};}return response;};
 const context={chrome,fetch:fetcher,crypto:crypto.webcrypto,URL,TextEncoder,Uint8Array,atob,btoa,Date,queueMicrotask,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,1)),clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../assets/chrome-profile-connector/background.js"),"utf8")+";globalThis.fixture={begin,check};",context);
 return{...context.fixture,session,local,calls,listeners,tabs:value=>{tabs=value;},platformTabs:value=>{platformTabs=value;},approve:()=>new Promise(resolve=>listeners.internal({type:"approve",code:session.pairing?.code},{id:EXTENSION_ID,url:`${EXTENSION_ORIGIN}/confirm.html`},resolve))};
}
async function connection(t,target){const value=await createChromeProfileCapture({identity,timeoutMs:5000,...target?{target}:{}});t.after(()=>value.cancel());const url=new URL(value.url);return{value,message:{type:"connect",port:Number(url.port),token:url.hash.slice(1),...target?{target}:{}},sender:{url:url.origin+"/connect"}};}

// Live 2026-11-18: accounts whose MCP setup stopped at OpenAI Platform's login. The person signs in to
// Platform in their Chrome; only OpenAI's cookies come back, with the ChatGPT login that says whose they are.
test("a Platform connection opens Platform's login and sends only OpenAI cookies once a Platform page is past it",async t=>{
 const c=await connection(t,"platform"),w=worker({trusted:identity.publicKey});
 const page=await fetch(new URL("/connect.js",c.value.url)).then(response=>response.text());
 assert.match(page,/target:'platform'/,"the connection page asks the connector for Platform's sign-in");
 await w.begin(c.message,c.sender);await wait(()=>w.calls.tabs.length>0);
 assert.deepEqual(w.calls.tabs,["https://platform.openai.com/login"]);
 await w.check();assert.equal(w.calls.captures,0);assert.match(w.session.pairing.status,/Waiting for OpenAI Platform sign-in/);
 w.platformTabs([{id:8,url:"https://platform.openai.com/login?next=%2Fhome",status:"complete"}]);await w.check();assert.equal(w.calls.captures,0,"Platform's login page is not signed in");
 w.platformTabs([{id:8,url:"https://platform.openai.com/home",status:"loading"}]);await w.check();assert.equal(w.calls.captures,0,"a page still loading is not yet signed in");
 w.platformTabs([{id:8,url:"https://platform.openai.com/home",status:"complete"}]);await w.check();
 const transfer=await c.value.result;
 assert.deepEqual(w.calls.cookies,["openai.com"],"ChatGPT's own cookies stay in Chrome");
 assert.equal(transfer.origin,"https://platform.openai.com");assert.equal(transfer.target,"platform");
 assert.deepEqual(transfer.expectedUser,FIXTURE_USER);transfer.complete(true);
});
test("signed in to Platform with no ChatGPT tab, the connector opens one in the background once to learn whose sign-in it is",async t=>{
 const c=await connection(t,"platform"),w=worker({trusted:identity.publicKey,platformTabs:[{id:8,url:"https://platform.openai.com/home",status:"complete"}]});
 w.tabs([]);await w.begin(c.message,c.sender);await wait(()=>w.calls.tabs.includes("https://chatgpt.com/ (background)"));
 await w.check();assert.equal(w.calls.tabs.filter(url=>url.startsWith("https://chatgpt.com/")).length,1,"opened once");assert.equal(w.calls.captures,0);
 w.tabs([{id:7,url:"https://chatgpt.com/",active:false}]);await w.check();
 const transfer=await c.value.result;assert.deepEqual(transfer.expectedUser,FIXTURE_USER);transfer.complete(true);
});
test("a ChatGPT connection is unchanged, and a Platform capture never answers it",async t=>{
 const c=await connection(t);const page=await fetch(new URL("/connect.js",c.value.url)).then(response=>response.text());
 assert.match(page,/target:'chatgpt'/);
 const {validCapture}=require("../electron/chrome-profile-login.cjs");
 const body=origin=>({version:1,origin,sessionAuthenticated:true,cookies:[{name:"a",value:"b",domain:".openai.com",path:"/",secure:true,httpOnly:true,sameSite:"Lax",expires:-1}]});
 assert.throws(()=>validCapture(body("https://platform.openai.com")),/Invalid Chrome sign-in capture/);
 assert(validCapture(body("https://platform.openai.com"),"platform"));
 assert(validCapture(body("https://chatgpt.com"),"platform"),"connector 1.1 answers a Platform connection with a ChatGPT capture");
 await assert.rejects(createChromeProfileCapture({identity,target:"other"}),/Invalid Chrome connector options/);
});

test("a first app identity requires explicit Chrome approval before any cookie export",async t=>{
 const c=await connection(t),w=worker();const answer=await w.begin(c.message,c.sender);assert.equal(answer.approvalRequired,true);assert.deepEqual(w.calls.cookies,[]);assert(w.calls.tabs.includes(`${EXTENSION_ORIGIN}/confirm.html`));
 assert.equal((await w.approve()).ok,true);assert.equal(w.local.trustedAppKey,identity.publicKey);
 const transfer=await c.value.result;assert.equal(w.calls.captures,1);assert.deepEqual(w.calls.cookies,["chatgpt.com","openai.com"]);await wait(()=>w.session.pairing.status.startsWith("Session sent"));assert(!w.session.pairing.status.startsWith("Verified"),"receipt is never evidence of authentication");transfer.complete(true);
 assert(!JSON.stringify(w.session).includes("fixture-only"));assert(!JSON.stringify(w.local).includes("PRIVATE KEY"));
});
test("a paired current profile verifies automatically without a Continue or close event",async t=>{
 const c=await connection(t),w=worker({trusted:identity.publicKey});await w.begin(c.message,c.sender);const transfer=await c.value.result;
 assert.equal(w.calls.captures,1);await w.check();assert.equal(w.calls.captures,1);transfer.complete(true);await wait(()=>w.session.pairing.status.startsWith("Session sent"));
 assert.equal(w.calls.tabs.length,0,"existing ChatGPT tabs stay in use");
 assert.deepEqual(transfer.expectedUser,FIXTURE_USER,"the app learns which ChatGPT login Chrome's page was signed in as");
});
test("a session without a ChatGPT user id never exports cookies, and a malformed email is not sent",async t=>{
 const c=await connection(t),w=worker({trusted:identity.publicKey,authenticated:{id:"not-a-user",email:"x@example.test"}});await w.begin(c.message,c.sender);await wait(()=>w.calls.checks>0);
 await w.check();assert.deepEqual(w.calls.cookies,[]);assert.equal(w.calls.captures,0);
 const d=await connection(t),v=worker({trusted:identity.publicKey,authenticated:{id:FIXTURE_USER.id,email:"no at sign"}});await v.begin(d.message,d.sender);
 const transfer=await d.value.result;assert.deepEqual(transfer.expectedUser,{id:FIXTURE_USER.id,email:null});transfer.complete(true);
});
test("a page without a positive session check never exports cookies",async t=>{
 const c=await connection(t),w=worker({trusted:identity.publicKey,authenticated:false});await w.begin(c.message,c.sender);await wait(()=>w.calls.checks>0);assert.deepEqual(w.calls.cookies,[]);assert.equal(w.calls.captures,0);
});
test("Google/lookalike/partitioned cookies never leave the current profile",async t=>{
 const c=await connection(t),w=worker({trusted:identity.publicKey,cookieState:domain=>domain==="chatgpt.com"?[{name:"ok",value:"fixture",domain:".chatgpt.com",path:"/",secure:true,httpOnly:true,sameSite:"lax"},{name:"google",value:"excluded",domain:".google.com",path:"/"},{name:"bad",value:"excluded",domain:".chatgpt.com.attacker.example",path:"/"},{name:"partitioned",value:"excluded",domain:".chatgpt.com",partitionKey:{topLevelSite:"https://chatgpt.com"}}]:[]});
 await w.begin(c.message,c.sender);const transfer=await c.value.result;assert.deepEqual(transfer.storageState.cookies.map(cookie=>cookie.name),["ok"]);transfer.complete(true);
});
test("a replacement pairing fences an old cookie read and queues only the fresh capture",async t=>{
 const first=await connection(t),second=await connection(t);let release,blocked=false;
 const gate=new Promise(resolve=>{release=resolve;});
 const w=worker({trusted:identity.publicKey,cookieState:async domain=>{
  if(!blocked){blocked=true;await gate;}
  return domain==="chatgpt.com"?[{name:"fresh",value:"fixture-only",domain:".chatgpt.com",path:"/",secure:true,httpOnly:true,sameSite:"lax"}]:[];
 }});
 await w.begin(first.message,first.sender);await wait(()=>w.calls.cookies.length>0);
 await w.begin(second.message,second.sender);release();
 const transfer=await second.value.result;assert.equal(w.calls.captures,1);transfer.complete(true);await wait(()=>w.session.pairing.status.startsWith("Session sent"));
 first.value.cancel();await assert.rejects(first.value.result,/cancelled/);
});

test("non-loopback, wrong-port and malformed requests cannot pair",async()=>{
 const w=worker();for(const sender of[{url:"https://attacker.example/connect"},{url:"http://localhost:1/connect"},{url:"http://127.0.0.1:2/connect"}])await assert.rejects(w.begin({port:1,token:"a".repeat(64)},sender));assert.deepEqual(w.calls.cookies,[]);
});
test("the visible pairing code cannot be changed without invalidating its signed app binding",async t=>{
 const c=await connection(t),w=worker({helloTransform:hello=>({...hello,code:"0000-0000-0000-0000"})});
 await assert.rejects(w.begin(c.message,c.sender),/pairing code/);assert.deepEqual(w.calls.cookies,[]);
});
test("a stale confirmation button cannot approve a newer pending pairing",async t=>{
 const first=await connection(t),second=await connection(t),w=worker();await w.begin(first.message,first.sender);const code=w.session.pairing.code;
 await w.begin(second.message,second.sender);
 const result=await new Promise(resolve=>w.listeners.internal({type:"approve",code},{id:EXTENSION_ID,url:`${EXTENSION_ORIGIN}/confirm.html`},resolve));
 assert.equal(result.ok,false);assert.equal(w.local.trustedAppKey,undefined);assert.deepEqual(w.calls.cookies,[]);
});

test("a changed app identity is never silently trusted",async t=>{
 const c=await connection(t),w=worker({trusted:"different-app"});await assert.rejects(w.begin(c.message,c.sender),/different app identity/);assert.deepEqual(w.calls.cookies,[]);assert.equal(w.local.trustedAppKey,"different-app");
});
test("expiry and sent capture fences prevent replay after uncertain delivery",async t=>{
 const c=await connection(t),w=worker({authenticated:false});await w.begin(c.message,c.sender);w.session.pairing.approved=true;w.session.pairing.sent=true;await w.check();assert.equal(w.calls.captures,0);
 w.session.pairing.sent=false;w.session.pairing.expiresAt=Date.now()-1;await w.check();assert.equal(w.calls.checks,0);
});
