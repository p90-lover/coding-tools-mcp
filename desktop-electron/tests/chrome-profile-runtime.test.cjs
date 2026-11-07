"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{EventEmitter}=require("node:events");
const {RuntimeHost}=require("../electron/runtime.cjs");
const {BrowserHost}=require("../electron/browser-host.cjs");
const {EXTENSION_ORIGIN}=require("../electron/chrome-profile-login.cjs");
async function fixture(t){
 const parent=path.join(__dirname,"../../aiTemp/current-chrome-runtime-tests");fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,"case-"));
 const operations=[],launches=[];let mode="automatic",unref=0;
 const host=Object.assign(Object.create(RuntimeHost.prototype),{app:{getPath:()=>root},active:null,activeChild:null,lifecycleOperation:null,chromeProfileCapture:null,chromeProfileOwner:null,getBrowserInteractionMode:()=>mode,
  publishOperation:value=>operations.push(value),passkeyChromeExecutable:()=>"fixture-chrome.exe",startProgram:async(file,args,options)=>{launches.push({file,args,options});return{unref(){unref++;},kill(){throw Error("The person's Chrome must not be killed");}};}});
 const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from("fixture:"+value),decryptString:value=>value.toString().slice(8)};
 t.after(()=>{host.cancelChromeProfileLogin();fs.rmSync(root,{recursive:true,force:true});});
 return{host,root,safeStorage,operations,launches,mode:value=>{mode=value;},unref:()=>unref};
}
async function started(f){const pending=f.host.captureCurrentChromeLogin({safeStorage:f.safeStorage});pending.catch(()=>{});const deadline=Date.now()+10000;while(!f.launches.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.launches.length,1);return{pending,url:new URL(f.launches[0].args[1])};}
async function send(url){
 const token=url.hash.slice(1),headers={Origin:EXTENSION_ORIGIN,Authorization:`Bearer ${token}`};
 const hello=await(await fetch(url.origin+"/hello",{headers})).json(),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv);
 cipher.setAAD(Buffer.from(`1\n${token}\n${hello.port}\n${hello.expiresAt}\n`));
 const plain={version:1,origin:"https://chatgpt.com",sessionAuthenticated:true,cookies:[{name:"session",value:"runtime-fixture",domain:".chatgpt.com",path:"/",secure:true,httpOnly:true,sameSite:"Lax",expires:-1}]};
 const data=Buffer.concat([cipher.update(JSON.stringify(plain)),cipher.final(),cipher.getAuthTag()]);
 const body={version:1,key:crypto.publicEncrypt({key:crypto.createPublicKey({key:Buffer.from(hello.publicKey,"base64"),type:"spki",format:"der"}),padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},key).toString("base64"),iv:iv.toString("base64"),data:data.toString("base64")};
 return fetch(url.origin+"/capture",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(body)}).then(response=>response.json());
}
test("current-profile launch opens a normal Chrome tab without a new profile, proxy overrides or owned helper",async t=>{
 const f=await fixture(t),{pending,url}=await started(f);const {args,options}=f.launches[0];assert.equal(args[0],"--new-tab");assert.equal(args.length,2);assert.equal(url.hostname,"127.0.0.1");assert(!args.some(arg=>/user-data-dir|profile-directory|debugging|automation|proxy/.test(arg)));assert.equal(options.stdio,"ignore");assert.equal(options.detached,true);assert.equal(f.host.activeChild,null);assert.equal(f.unref(),1);
 const message=f.operations.at(-1).message;assert.match(message,/pairing code (?:[A-F0-9]{4}-){3}[A-F0-9]{4}/);assert(!message.includes(url.hash.slice(1)));f.host.cancelChromeProfileLogin();await assert.rejects(pending,/cancelled/);
});
test("capture is automatically handed to existing app verification and clears the operation only after completion",async t=>{
 const f=await fixture(t),{pending,url}=await started(f),response=send(url),transfer=await pending;
 assert.equal(f.host.currentOperation(),"chrome-profile-login");assert.match(f.operations.at(-1).message,/Verifying the ChatGPT session/);assert.equal(f.launches.length,1);transfer.assertCurrent();await transfer.cleanup();transfer.complete(true);
 assert.deepEqual(await response,{accepted:true});assert.equal(f.host.currentOperation(),null);assert.equal(f.operations.at(-1).status,"completed");assert.equal(f.operations.at(-1).message,"Chrome profile sign-in verified");
});
test("manual mode, another runtime operation and an unavailable OS key store cannot capture",async t=>{
 const f=await fixture(t);f.mode("manual");await assert.rejects(f.host.captureCurrentChromeLogin({safeStorage:f.safeStorage}),/Automatic mode/);f.mode("automatic");f.host.active="other";await assert.rejects(f.host.captureCurrentChromeLogin({safeStorage:f.safeStorage}),/already in progress/);f.host.active=null;
 await assert.rejects(f.host.captureCurrentChromeLogin({safeStorage:{isEncryptionAvailable:()=>false}}),/OS-protected/);assert.equal(f.host.currentOperation(),null);assert.equal(f.launches.length,0);
});
test("cancellation does not close Chrome and invalidates even an already-consumed transfer",async t=>{
 const f=await fixture(t),{pending,url}=await started(f),response=send(url),transfer=await pending;assert(f.host.cancelChromeProfileLogin());assert.throws(()=>transfer.assertCurrent(),/no longer current/);assert.equal(transfer.complete(true),false);assert.deepEqual(await response,{accepted:true});assert.equal(f.operations.at(-1).message,"Chrome profile sign-in cancelled");assert.equal(f.launches.length,1);assert.equal(f.host.currentOperation(),null);
});
test("a failed Chrome launch is handled without an unhandled child error or a stuck operation",async t=>{
 const f=await fixture(t);f.host.startProgram=async()=>{const child=Object.assign(new EventEmitter(),{unref(){}});setTimeout(()=>child.emit("error",Error("fixture launch failure")),5);return child;};
 await assert.rejects(f.host.captureCurrentChromeLogin({safeStorage:f.safeStorage}),/Could not open Chrome/);assert.equal(f.host.currentOperation(),null);assert.equal(f.operations.at(-1).status,"failed");
});

test("reopening the pending connector never starts another owned capture",async t=>{
 const f=await fixture(t),{pending}=await started(f);await f.host.openChromeProfileConnector();assert.equal(f.launches.length,2);assert.equal(f.launches[0].args[1],f.launches[1].args[1]);await assert.rejects(f.host.captureCurrentChromeLogin({safeStorage:f.safeStorage}),/already in progress/);f.host.cancelChromeProfileLogin();await assert.rejects(pending,/cancelled/);
});
test("BrowserHost reports connector success only after fresh authentication and session inspection",async()=>{
 const order=[],result={authenticated:true},host=Object.assign(Object.create(BrowserHost.prototype),{state:{},getBrowserInteractionMode:()=>"automatic",clearOwnedSessionForPasskey:async()=>order.push("clear"),waitForAuthenticated:async()=>{order.push("auth");return result;},runSessionInspection:async()=>order.push("inspection"),activateHomeSurface:()=>order.push("activate"),show:()=>order.push("show"),logger:{info(){}},snapshot:()=>result});
 const contents={isDestroyed:()=>false,loadURL:async()=>order.push("load"),session:{cookies:{set:async()=>order.push("cookie"),flushStore:async()=>{}},flushStorageData(){}}};host.view={webContents:contents};
 const transfer={storageState:{cookies:[{name:"session",value:"fixture",domain:".chatgpt.com",path:"/",secure:true,httpOnly:true,sameSite:"Lax",expires:-1}],origins:[]},assertCurrent:()=>order.push("current"),cleanup:async()=>order.push("cleanup"),complete:verified=>order.push(`complete:${verified}`)};
 assert.equal((await host.installPasskeyLogin(transfer)).authenticated,true);assert(order.indexOf("complete:true")>order.indexOf("inspection"));assert(order.indexOf("complete:true")>order.indexOf("cleanup"));
 host.waitForAuthenticated=async()=>{throw Error("fresh verification failed");};host.resetFailedPasskeyLogin=async()=>order.push("reset");order.length=0;await assert.rejects(host.installPasskeyLogin(transfer),/fresh verification failed/);assert(order.includes("complete:false"));assert(!order.includes("complete:true"));
 const approved={...transfer,source:"approved-chrome-profile-connector"};host.waitForAuthenticated=async()=>{throw Error("private-cookie-value-must-not-appear");};
 await assert.rejects(host.installPasskeyLogin(approved),error=>/session verification failed/.test(error.message)&&!error.message.includes("private-cookie-value"));
 let current=true;order.length=0;host.clearOwnedSessionForPasskey=async()=>{current=false;order.push("clear");};
 await assert.rejects(host.installPasskeyLogin({...transfer,assertCurrent:()=>{if(!current)throw Error("cancelled during clear");}}),/cancelled during clear/);assert(!order.includes("cookie"),"cancelled capture cannot install a cookie after its first async boundary");
});
