"use strict";
const fs=require("node:fs"),path=require("node:path"),http=require("node:http"),assert=require("node:assert/strict");
const {app,BaseWindow,BrowserWindow,WebContentsView}=require("electron");
const source=process.env.CHAT_VERIFY_SOURCE || path.resolve(__dirname,"../../..");
const work=process.env.CHAT_VERIFY_WORK || path.join(source,"aiTemp","chat-preview-native");
fs.mkdirSync(work,{recursive:true});
app.setName("Chat Tool Verification");
app.on("window-all-closed",()=>{}); // The fixture recreates its owner window before exiting explicitly.
app.setPath("userData",path.join(work,"profile"));
let window,parking,previews,tools,page,nativeView,menu;
let panelLeaks=0;
let deadline,holding=false;
const watchdog=()=>{clearTimeout(deadline);deadline=setTimeout(()=>{console.error("NATIVE_STEP_TIMEOUT");app.exit(3)},50000)};
watchdog();
const log=(step,info={})=>{if(!holding)watchdog();console.log(JSON.stringify({step,...info}))};
process.on("uncaughtException",error=>{console.error("UNCAUGHT",error.stack);app.exit(2)});
process.on("unhandledRejection",error=>{console.error("UNHANDLED",error?.stack||error);app.exit(2)});
app.whenReady().then(async()=>{
  const {createNativeChatPreviews}=require(path.join(source,"desktop-electron/electron/chat-preview.cjs"));
  const {createChatAgentTools}=require(path.join(source,"desktop-electron/electron/chat-agent-tools.cjs"));
  window=new BrowserWindow({show:true,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL("data:text/html,<title>Chat tools native verification</title>");
  log("WINDOW_READY",{electron:process.versions.electron});
  const html='<!doctype html><title>Chat Tool Fixture</title><input aria-label="Fixture input"><button onclick="this.textContent=\'Count 1\'">Count 0</button><a href="/next">Next</a><div style="height:3000px">Fixture page</div><script>console.log("fixture-loaded")</script>';
  page=http.createServer((req,res)=>{if(req.url==="/reset"){req.socket.destroy();return}if(req.url.startsWith("/panel-leak"))panelLeaks++;res.setHeader("Content-Type","text/html");res.end(req.url==="/next"?"<title>Next</title><p>Next Page</p>":html)});
  await new Promise(r=>page.listen(0,"127.0.0.1",r));
  const url="http://127.0.0.1:"+page.address().port+"/";
  previews=createNativeChatPreviews({BaseWindow,WebContentsView,Menu:{buildFromTemplate(value){menu=value;return{popup(){}}}},mainWindow:()=>window,logger:{warn:(event,data)=>log(event,data)}});
  let approvals=0;
  tools=createChatAgentTools({previews,minAnswerMs:0,terminalEnabled:()=>true,confirm:async()=>{approvals++;log("APPROVAL_ACCEPTED",{approvals});return true},
    sessionWorkspace:async()=>({root:work}),
    requestHeadless:async endpoint=>{if(endpoint.startsWith("/api/v1/tools/catalog?"))return {tools:[]};throw Error("Unexpected headless call")},
    logger:{info(){},warn:(event,data)=>log(event,data)}
  });
  const lease=await tools.lease({agent:"claude-code",workspaceId:"ws1",approvalMode:"accept-edits"});
  assert.ok(lease.bind("native-session"));
  const [{url:endpoint,headers}]=lease.servers;
  let id=0;
  const call=async(name,args={})=>{
    log("BEGIN",{tool:name});
    const response=await fetch(endpoint,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:++id,method:"tools/call",params:{name,arguments:args}})});
    const reply=await response.json();
    if(reply.error||reply.result?.isError)throw Error(name+": "+JSON.stringify(reply.error||reply.result.content));
    if(name==="preview_wait"&&args.text)assert.equal(reply.result.structuredContent?.found,true,"wait found "+args.text);
    log("PASS",{tool:name});
    return reply.result;
  };
  await call("preview_open",{url});assert.equal(approvals,1);
  parking=BaseWindow.getAllWindows().find(host=>host!==window);
  assert.ok(parking);
  if(process.platform==="win32"||process.platform==="darwin"){
    assert.equal(parking.getOpacity(),0);assert.equal(parking.isFocusable(),false);
  }else assert.equal(parking.isVisible(),false);
  nativeView=parking.contentView.children[0];assert.ok(nativeView.webContents);
  log("INITIAL_HIDDEN_CAPTURE");await call("preview_screenshot",{full_page:true});log("INITIAL_HIDDEN_PASS");
  let read=(await call("preview_read")).structuredContent;
  assert.equal(read.title,"Chat Tool Fixture");
  await call("preview_click",{ref:read.elements.find(x=>x.name==="Count 0").ref});
  await call("preview_wait",{text:"Count 1"});
  await call("preview_type",{ref:read.elements.find(x=>x.name==="Fixture input").ref,text:"native",clear:true});
  await call("preview_press",{key:"!"});
  read=(await call("preview_read")).structuredContent;
  assert.equal(read.elements.find(x=>x.name==="Fixture input").value,"native!");
  const shot=await call("preview_screenshot");
  const image=shot.content.find(x=>x.type==="image");
  assert.ok(image?.data?.length>100);
  fs.writeFileSync(path.join(work,"preview.png"),Buffer.from(image.data,"base64"));
  await call("preview_scroll",{dy:200});
  const beforeCapture=await nativeView.webContents.executeJavaScript("({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight})");assert.ok(beforeCapture.y>0,"wheel scrolls hidden page");assert.equal(beforeCapture.height,800);
  const scrolled=(await call("preview_screenshot")).content.find(x=>x.type==="image");log("SCROLL_STATE",{position:await nativeView.webContents.executeJavaScript("({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,body:document.body.scrollHeight})")});assert.notEqual(scrolled.data,image.data,"capture follows actual page scrolling");
  previews.show("native-session",{x:10,y:10,width:900,height:650});
  await call("preview_screenshot");
  await call("preview_click",{ref:read.elements.find(x=>x.name==="Next").ref});
  await call("preview_wait",{text:"Next Page"});
  await call("preview_navigate",{action:"back"});
  await call("preview_wait",{text:"Fixture page"});
  await call("preview_navigate",{action:"forward"});
  await call("preview_wait",{text:"Next Page"});
  await call("preview_navigate",{action:"reload"});
  await call("preview_console");
  previews.hide();
  const hidden=await call("preview_screenshot");assert.ok(hidden.content.some(x=>x.type==="image"));
  previews.show("native-session",{x:10,y:10,width:900,height:650});
  previews.hide();
  await nativeView.webContents.executeJavaScript("localStorage.setItem('preview-owner','first')");
  assert.equal((await previews.call("other-session","preview_open",{url})).isError,false);
  const other=parking.contentView.children.find(view=>view!==nativeView);
  assert.ok(other);assert.equal(await other.webContents.executeJavaScript("localStorage.getItem('preview-owner')"),null);
  assert.equal((await previews.call("other-session","preview_screenshot")).isError,false);
  assert.equal((await call("preview_screenshot")).isError,false);
  assert.equal(previews.show("other-session",{x:10,y:10,width:900,height:650}),true);
  previews.hide();assert.equal((await previews.call("other-session","preview_screenshot",{full_page:true})).isError,false);
  previews.close("other-session");assert.equal(previews.state("other-session"),null);
  assert.equal(parking.contentView.children.length,1);
  log("NATIVE_PREVIEW_ALL_PASS",{tools:10,approvals,sessions:2});

  for (const [phase, count] of [["First panel", 0], ["Updated panel", 10]]) {
    await call("preview_render",{html:`<h1>${phase}</h1><button onclick="this.textContent=Number(this.textContent)+1">${count}</button><a href="#details">Details</a><p id="details">Panel details</p><script>window.appAccess=typeof window.require;window.blocked=false;fetch(${JSON.stringify(url)}).catch(()=>{window.blocked=true});setTimeout(()=>location.assign(${JSON.stringify(url+"panel-leak?value=test")}),20)</script>`});
    read=(await call("preview_read")).structuredContent;
    assert.ok(read.text.includes(phase));
    assert.equal(parking.contentView.children[0],nativeView,"updates retain the same native panel");
    await call("preview_click",{ref:read.elements.find(x=>x.name===String(count)).ref});
    assert.ok((await call("preview_read")).structuredContent.text.includes(String(count+1)));
    assert.equal(await nativeView.webContents.executeJavaScript("window.appAccess"),"undefined");
    assert.equal(await nativeView.webContents.executeJavaScript("origin"),"null","the panel has its own opaque origin");
    assert.equal(await nativeView.webContents.executeJavaScript("(()=>{try{return localStorage.getItem('preview-owner')}catch{return null}})()"),null);
    assert.equal(await nativeView.webContents.executeJavaScript("window.blocked"),true,"panel CSP blocks even a previously opened origin");
  }
  read=(await call("preview_read")).structuredContent;
  await call("preview_click",{ref:read.elements.find(x=>x.name==="Details").ref});
  await call("preview_navigate",{action:"reload"});
  assert.ok((await call("preview_read")).structuredContent.text.includes("Updated panel"));
  nativeView.webContents.emit("context-menu",{},{});
  await menu.find(item=>item.label==="Reload").click();
  assert.ok((await call("preview_read")).structuredContent.text.includes("Updated panel"));
  const projectReturn=await previews.navigate("native-session",{url});
  assert.equal(projectReturn.ok,true,JSON.stringify(projectReturn));
  const panelReturn=await previews.navigate("native-session",{url:"about:blank#live-panel"});
  assert.equal(panelReturn.ok,true,JSON.stringify(panelReturn));
  assert.ok((await call("preview_read")).structuredContent.text.includes("Updated panel"));
  assert.equal((await previews.navigate("native-session",{url:url+"reset"})).ok,false);
  assert.ok(nativeView.webContents.navigationHistory.getAllEntries().every(entry=>!entry.url.startsWith("data:")),"a failed project load cannot restore a panel with web navigation enabled");
  assert.equal((await previews.navigate("native-session",{url:"about:blank#live-panel"})).ok,true);
  assert.ok((await call("preview_read")).structuredContent.text.includes("Updated panel"));
  assert.equal(panelLeaks,0,"panel navigation never reaches even a previously approved server");
  log("NATIVE_PANEL_HISTORY_AND_OFFLINE_PASS");
  const panelShot=(await call("preview_screenshot")).content.find(x=>x.type==="image");
  fs.writeFileSync(path.join(work,"live-panel.png"),Buffer.from(panelShot.data,"base64"));
  const codexLease=await tools.lease({agent:"codex",workspaceId:"ws1",approvalMode:"accept-edits"});
  assert.ok(codexLease.bind("native-codex-panel"));
  const [{url:codexEndpoint,headers:codexHeaders}]=codexLease.servers;
  for(const phase of ["Codex first panel","Codex updated panel"]){
    const response=await fetch(codexEndpoint,{method:"POST",headers:{...codexHeaders,"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:++id,method:"tools/call",params:{name:"preview_render",arguments:{html:`<h1>${phase}</h1>`}}})});
    const reply=await response.json();assert.equal(reply.result?.isError,false);
    assert.ok((await previews.call("native-codex-panel","preview_read")).structuredContent.text.includes(phase));
  }
  if(process.env.CHAT_VERIFY_MODEL === "1") {
    holding=true;
    clearTimeout(deadline);
    fs.writeFileSync(path.join(work,"model-server.json"),JSON.stringify({url:codexEndpoint,headers:codexHeaders,pid:process.pid}));
    previews.show("native-codex-panel",{x:10,y:10,width:1100,height:750});
    log("MODEL_SERVER_READY");
    setTimeout(()=>app.exit(3),1800000);
    await new Promise(()=>{});
  }
  previews.close("native-codex-panel");
  log("NATIVE_LIVE_PANEL_BOTH_HARNESSES_PASS");

  let permitLate;
  const pendingOpen=previews.call("pending-owner","preview_open",{url},{permit:()=>new Promise(resolve=>{permitLate=resolve})});
  assert.equal(typeof permitLate,"function");
  window.destroy();assert.equal(parking.isDestroyed(),true);assert.equal(previews.state("native-session"),null);
  permitLate(true);assert.equal((await pendingOpen).isError,true);assert.equal(previews.state("pending-owner"),null);
  assert.equal(BaseWindow.getAllWindows().length,0,"a late approval cannot recreate the closed native owner");
  log("NATIVE_CANCELLED_OPEN_PASS");
  window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL("data:text/html,<title>Reopened chat verification</title>");
  await call("preview_open",{url});await call("preview_screenshot");
  const reopened=BaseWindow.getAllWindows().find(host=>host!==window);assert.ok(reopened);assert.notEqual(reopened,parking);
  window.destroy();assert.equal(reopened.isDestroyed(),true);previews.closeAll();
  await tools.close();await new Promise(r=>page.close(r));clearTimeout(deadline);log("NATIVE_SHUTDOWN_PASS");app.exit(0);
}).catch(error=>{console.error("NATIVE_FAILURE",error.stack);app.exit(1)});
