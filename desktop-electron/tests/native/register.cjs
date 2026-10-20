"use strict";
// Run with Node + Playwright and ELECTRON_PATH; fixtures and screenshots stay in the supplied work root.
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict"),cp=require("node:child_process"),net=require("node:net");
const desktop=path.resolve(__dirname,"../.."),source=path.dirname(desktop);
const base=process.env.REGISTER_VERIFY_WORK||path.join(source,"aiTemp/register-runtime-20261020/native");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,check,label,timeout=20000){const end=Date.now()+timeout;let value;do{value=await read();if(check(value))return value;await sleep(100);}while(Date.now()<end);throw Error(label+": "+JSON.stringify(value));}
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

if(!process.versions.electron){
  (async()=>{
    fs.mkdirSync(base,{recursive:true});
    const work=fs.mkdtempSync(path.join(base,"run-"));
    const { _electron }=require("playwright");
    let electron,failed=null,result;
    try{
      const env={...process.env,REGISTER_NATIVE_CHILD:"1",REGISTER_VERIFY_WORK:work};
      delete env.ELECTRON_RUN_AS_NODE;
      electron=await _electron.launch({executablePath:process.env.ELECTRON_PATH||require("electron"),args:[__filename],env,timeout:60000});
      const page=await electron.firstWindow(),errors=[];
      page.on("pageerror",error=>errors.push(error.message));
      await page.waitForFunction(()=>Boolean(window.registerQaMount));
      await until(()=>page.evaluate(()=>document.hidden),value=>value===false,"fixture document visible");
      await page.getByRole("button",{name:"Start service",exact:true}).click();
      await page.getByRole("status").filter({hasText:"Connected"}).waitFor({timeout:30000});
      await until(()=>electron.evaluate(()=>globalThis.registerQa.childText()),value=>value.includes("cookie-ok"),"native same-site SSE cookie");
      assert.equal(await electron.evaluate(()=>globalThis.registerQa.childPrivate()),true,"native view has no launcher/Node bridge");
      assert.equal(await electron.evaluate(()=>globalThis.registerQa.attached()),true);
      await page.screenshot({path:path.join(work,"host-desktop.png")});
      await electron.evaluate(()=>globalThis.registerQa.capture("fixture-native.png"));
      await page.evaluate(()=>window.registerQaMount(false));
      await until(()=>electron.evaluate(()=>globalThis.registerQa.attached()),value=>value===false,"inactive native view detaches");
      await page.evaluate(()=>window.registerQaMount(true));
      await until(()=>electron.evaluate(()=>globalThis.registerQa.attached()),value=>value===true,"native view restores");
      await page.getByRole("button",{name:"Reload view",exact:true}).click();
      await until(()=>electron.evaluate(()=>globalThis.registerQa.childText()),value=>value.includes("cookie-ok"),"cookie retained after reload");
      await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,680));
      await until(()=>electron.evaluate(()=>globalThis.registerQa.bounds()),value=>value.width>0&&value.width<820,"compact native bounds");
      await page.screenshot({path:path.join(work,"host-compact.png")});
      for(const[language,label]of[["zh-CN","已连接"],["zh-TW","已連線"],["ja","接続済み"],["en","Connected"]]){
        await page.evaluate(language=>window.registerQaMount(true,language),language);
        await page.getByRole("status").filter({hasText:label}).waitFor();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"compact "+language+" does not overflow");
      }
      await page.getByRole("button",{name:"Stop service",exact:true}).click();
      await page.getByRole("status").filter({hasText:"Offline"}).waitFor();
      if(process.env.REGISTER_VERIFY_PROJECT){
        await electron.evaluate(()=>globalThis.registerQa.useRealProject());
        await page.getByRole("button",{name:"Start service",exact:true}).click();
        await page.getByRole("status").filter({hasText:"Connected"}).waitFor({timeout:30000});
        let text=await until(()=>electron.evaluate(()=>globalThis.registerQa.childText()),value=>value.length>30,"actual upstream UI");
        if(await electron.evaluate(()=>globalThis.registerQa.needsLogin())){
          await electron.evaluate(()=>globalThis.registerQa.loginFixture());
        }
        await until(()=>electron.evaluate(()=>globalThis.registerQa.upstreamReady()),value=>value===true,"actual Register interface");
        await electron.evaluate(()=>globalThis.registerQa.capture("reg-machine-native.png"));
        await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,900));
        await until(()=>electron.evaluate(()=>globalThis.registerQa.bounds()),value=>value.width>1000,"actual desktop bounds");
        await electron.evaluate(()=>globalThis.registerQa.capture("reg-machine-desktop.png"));
        await page.getByRole("button",{name:"Reload view",exact:true}).click();
        await until(()=>electron.evaluate(()=>globalThis.registerQa.upstreamReady()),value=>value===true,"actual upstream reload/session");
        await page.getByRole("button",{name:"Stop service",exact:true}).click();
        await page.getByRole("status").filter({hasText:"Offline"}).waitFor();
      }
      assert.deepEqual(errors,[],"renderer exceptions");
      result=await electron.evaluate(()=>globalThis.registerQa.report());
      assert.equal(result.remainingOwned,false);
      assert.equal(result.attached,false);
      assert.equal(result.registrationPosts,0);
      result.rendererErrors=errors;
      result.browser="Playwright Electron; Browser plugin not available";
      result.screenshots=fs.readdirSync(work).filter(file=>file.endsWith(".png"));
    }catch(error){failed=error;result={ok:false,error:error.stack};}
    finally{
      if(electron){await electron.evaluate(()=>globalThis.registerQa?.shutdown()).catch(()=>{});await electron.close().catch(()=>{});}
      fs.writeFileSync(path.join(work,"result.json"),JSON.stringify(result,null,2)+"\n");
      console.log(JSON.stringify({work,...result}));
    }
    if(failed)process.exitCode=1;
  })().catch(error=>{console.error(error.stack);process.exitCode=1;});
}else if(process.env.REGISTER_NATIVE_CHILD==="1"){
  const {app,BrowserWindow,WebContentsView,ipcMain}=require("electron");
  const {createRequire}=require("node:module"),fromDesktop=createRequire(path.join(desktop,"package.json"));
  const {createRegisterHost}=require(path.join(desktop,"electron/register-host.cjs"));
  const loadedHostSha=require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(desktop,"electron/register-host.cjs"))).digest("hex");
  const work=base;
  fs.mkdirSync(path.join(work,"profile"),{recursive:true});
  app.setName("Register Verification");app.setPath("userData",path.join(work,"profile"));app.disableHardwareAcceleration();
  let window,host,view,realMode=false,closing=false,origin,port,fixturePid=null;
  const views=[],events=[],external=[],consoleErrors=[];
  const project=path.join(work,"project"),ui=path.join(work,"ui"),audit=path.join(work,"requests.jsonl");
  for(const folder of["static",path.join(".venv",process.platform==="win32"?"Scripts":"bin")])fs.mkdirSync(path.join(project,folder),{recursive:true});
  fs.writeFileSync(path.join(project,"main.py"),"# fixture only\n");
  fs.writeFileSync(path.join(project,"static/index.html"),"<title>Fixture</title>");
  fs.writeFileSync(path.join(project,".venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),"fixture");
  function service(){
    const http=require("node:http");
    http.createServer((req,res)=>{
      if(req.url==="/api/health"){res.setHeader("content-type","application/json");return res.end(JSON.stringify({ok:true,service:"account-manager-v2"}));}
      if(req.url==="/events"){
        res.setHeader("content-type","text/event-stream");
        return res.end("data: "+((req.headers.cookie||"").includes("qa_session=local")?"cookie-ok":"cookie-missing")+"\n\n");
      }
      res.setHeader("set-cookie","qa_session=local; HttpOnly; SameSite=Strict; Path=/");
      res.setHeader("content-type","text/html");
      res.end('<title>Register Fixture</title><h1>Register Fixture</h1><p id="stream">Connecting</p><script>new EventSource("/events").onmessage=e=>document.getElementById("stream").textContent=e.data;</script>');
    }).listen(Number(process.env.REGISTER_QA_PORT),"127.0.0.1");
  }
  const bootstrap=[
    "import os,sys,json",
    "from pathlib import Path",
    "sys.path.insert(0,os.environ['REGISTER_QA_SOURCE'])",
    "from main import app",
    "from core.db import init_db,engine",
    "assert Path(engine.url.database).resolve()==Path(os.environ['REGISTER_QA_DB']).resolve()",
    "init_db()",
    "from starlette.responses import FileResponse,JSONResponse",
    "from starlette.staticfiles import StaticFiles",
    "import uvicorn",
    "static=StaticFiles(directory=os.environ['REGISTER_QA_STATIC'])",
    "class Offline:",
    " async def __call__(self,scope,receive,send):",
    "  if scope['type']=='http':",
    "   p=scope['path'];m=scope['method']",
    "   with open(os.environ['REGISTER_QA_AUDIT'],'a',encoding='utf8') as f:f.write(json.dumps({'method':m,'path':p})+'\\n')",
    "   if not p.startswith('/api/'):",
    "    if p.startswith('/assets/') or Path(p).suffix:return await static(scope,receive,send)",
    "    return await FileResponse(os.path.join(os.environ['REGISTER_QA_STATIC'],'index.html'))(scope,receive,send)",
    "   if m not in ('GET','HEAD','OPTIONS') and not p.startswith('/api/auth/'):return await JSONResponse({'detail':'Offline verification'},status_code=409)(scope,receive,send)",
    "  return await app(scope,receive,send)",
    "uvicorn.run(Offline(),host='127.0.0.1',port=int(os.environ['REGISTER_QA_PORT']),lifespan='off',log_level='warning')"
  ].join("\n");
  function spawnFixture(exe,args,options){
    assert.ok(args.includes("uvicorn"));assert.ok(args.includes("127.0.0.1"));
    const env={...options.env,REGISTER_QA_PORT:String(port)};
    if(realMode){
      Object.assign(env,{ACCOUNT_MANAGER_DATABASE_URL:"sqlite:///"+path.join(work,"fixture.db").replace(/\\/g,"/"),REGISTER_QA_DB:path.join(work,"fixture.db"),REGISTER_QA_SOURCE:process.env.REGISTER_VERIFY_PROJECT,REGISTER_QA_STATIC:path.join(work,"static"),REGISTER_QA_AUDIT:audit,ANY_AUTO_DISABLE_SOLVER:"1",APP_PASSWORD:"offline-register-qa",PYTHONDONTWRITEBYTECODE:"1"});
      delete env.ELECTRON_RUN_AS_NODE;
      const child=cp.spawn(exe,["-B","-c",bootstrap],{...options,env});fixturePid=child.pid;return child;
    }
    const child=cp.spawn(process.execPath,["-e","("+service.toString()+")()"],{...options,env:{...env,ELECTRON_RUN_AS_NODE:"1"}});fixturePid=child.pid;return child;
  }
  const makeHost=projectRoot=>createRegisterHost({
    projectRoot,configPath:path.join(work,"register.json"),origin,spawnProcess:spawnFixture,
    createView:partition=>{
      view=new WebContentsView({webPreferences:{partition:partition+"-verification",sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      views.push(view);view.webContents.on("console-message",(_event,level,message)=>{if(level===3)consoleErrors.push(String(message).slice(0,200));});return view;
    },
    prepareSession:session=>session.setProxy({mode:"direct"}),
    attachView:v=>window.contentView.addChildView(v),detachView:v=>{try{window.contentView.removeChildView(v);}catch{}},
    openExternal:url=>external.push(url),
    onChange:status=>{events.push({ready:status.ready,owned:status.owned,starting:status.starting});if(window&&!window.isDestroyed())window.webContents.send("qa:changed",status);}
  });
  app.on("window-all-closed",()=>{});
  app.on("before-quit",event=>{if(closing)return;event.preventDefault();closing=true;Promise.resolve(host?.shutdown()).finally(()=>app.exit());});
  app.whenReady().then(async()=>{
    port=await freePort();origin="http://127.0.0.1:"+port;host=makeHost(project);
    fs.mkdirSync(ui,{recursive:true});
    const {buildSync}=fromDesktop("esbuild");
    buildSync({stdin:{contents:'import React from "react";import{createRoot}from"react-dom/client";import{RegisterSurface}from"./src/features/RegisterSurface.tsx";const root=createRoot(document.getElementById("root"));window.registerQaMount=(active,language="en")=>root.render(<RegisterSurface api={window.codexWebLauncher} active={active} language={language} setError={()=>{}}/>);window.registerQaMount(true);',resolveDir:desktop,loader:"tsx"},bundle:true,write:true,outfile:path.join(ui,"fixture.js"),jsx:"automatic",format:"iife"});
    fs.writeFileSync(path.join(ui,"index.html"),'<title>Register native verification</title><link rel="stylesheet" href="./fixture.css"><style>:root{--titlebar-height:0px}html,body,#root{margin:0;height:100%;font-family:system-ui,sans-serif}</style><div id="root"></div><script src="./fixture.js"></script>');
    const methods={registerStatus:"status",configureRegister:"configure",startRegister:"start",stopRegister:"stop",reloadRegister:"reload",setRegisterSurfaceActive:"setSurfaceActive",setRegisterBounds:"setBounds"};
    const preload='const{contextBridge,ipcRenderer}=require("electron");const api={chooseFolder:()=>Promise.resolve('+JSON.stringify(project)+')};for(const name of '+JSON.stringify(Object.keys(methods))+')api[name]=(...args)=>ipcRenderer.invoke("qa:"+name,...args);api.onRegisterChanged=listener=>{const cb=(_event,value)=>listener(value);ipcRenderer.on("qa:changed",cb);return()=>ipcRenderer.removeListener("qa:changed",cb)};contextBridge.exposeInMainWorld("codexWebLauncher",api);';
    fs.writeFileSync(path.join(work,"preload.cjs"),preload);
    for(const[name,method]of Object.entries(methods))ipcMain.handle("qa:"+name,(_event,...args)=>host[method](...args));
    window=new BrowserWindow({show:true,opacity:0,focusable:false,skipTaskbar:true,width:1280,height:900,webPreferences:{preload:path.join(work,"preload.cjs"),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    window.setIgnoreMouseEvents(true);
    globalThis.registerQa={
      childText:()=>view?.webContents&&!view.webContents.isDestroyed()?view.webContents.executeJavaScript("document.body?.innerText||''"):"",
      childPrivate:()=>view.webContents.executeJavaScript("typeof window.codexWebLauncher==='undefined'&&typeof require==='undefined'"),
      needsLogin:()=>view.webContents.executeJavaScript('Boolean(document.querySelector(\'form input[aria-label="访问密码"]\'))'),
      upstreamReady:()=>view.webContents.executeJavaScript('location.pathname==="/register"&&!document.querySelector(\'form input[aria-label="访问密码"]\')&&Array.from(document.querySelectorAll("fieldset")).some(f=>f.textContent.includes("基本配置")&&f.textContent.includes("Step 1 · 注册身份"))&&Array.from(document.querySelectorAll("button")).some(b=>b.textContent.replace(/\\s+/g,"")==="开始注册")'),
      attached:()=>Boolean(view&&window.contentView.children.includes(view)),
      bounds:()=>view?.getBounds(),
      capture:async file=>fs.writeFileSync(path.join(work,file),(await view.webContents.capturePage()).toPNG()),
      useRealProject:async()=>{
        await host.shutdown();realMode=true;
        const original=path.join(process.env.REGISTER_VERIFY_PROJECT,"static"),snapshot=path.join(work,"static");
        fs.cpSync(original,snapshot,{recursive:true,dereference:false});
        for(const file of fs.readdirSync(snapshot,{recursive:true})){assert.equal(fs.lstatSync(path.join(snapshot,file)).isSymbolicLink(),false);}
        port=await freePort();origin="http://127.0.0.1:"+port;host=makeHost(process.env.REGISTER_VERIFY_PROJECT);
        await window.webContents.executeJavaScript("window.registerQaMount(false);window.registerQaMount(true)");
        window.webContents.send("qa:changed",await host.status());
      },
      loginFixture:()=>view.webContents.executeJavaScript('(async()=>{const input=document.querySelector("input[type=password]");if(!input)throw Error("Fixture password input missing");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"offline-register-qa");input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));await new Promise(r=>setTimeout(r,100));const button=input.closest("form")?.querySelector("button[type=submit]")||Array.from(document.querySelectorAll("button")).find(b=>/登录|登入|Login|Sign in/i.test(b.textContent));if(!button)throw Error("Fixture login button missing");button.click();})()'),
      report:async()=>{
        const status=await host.status(),requests=fs.existsSync(audit)?fs.readFileSync(audit,"utf8").trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):[];
        let alive=false;if(fixturePid)try{process.kill(fixturePid,0);alive=true;}catch{}
        return{ok:true,loadedHostSha,electron:process.versions.electron,actualUpstream:realMode,backgroundWorkers:"lifespan disabled only in isolated actual-source fixture",fixtureDb:path.join(work,"fixture.db"),remainingOwned:status.owned||alive,attached:Boolean(view&&window.contentView.children.includes(view)),registrationPosts:requests.filter(r=>r.method==="POST"&&r.path==="/api/tasks/register").length,requestCount:requests.length,events,external,consoleErrors};
      },
      shutdown:()=>host?.shutdown()
    };
    await window.loadFile(path.join(ui,"index.html"));
  }).catch(error=>{console.error(error.stack);Promise.resolve(host?.shutdown()).finally(()=>app.exit(2));});
}
