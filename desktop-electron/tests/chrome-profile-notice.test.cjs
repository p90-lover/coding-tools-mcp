"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),ts=require("typescript");
function ui(){const exports={},jsx=(type,props)=>({type,props});vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,"../src/ChromeLoginNotice.tsx"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>name==="react"?{useEffect(){},useRef:value=>({current:value}),useState:value=>[value,()=>{}]}:name==="react/jsx-runtime"?{jsx,jsxs:jsx}:{}});return exports;}
const walk=node=>!node||typeof node!=="object"?[]:Array.isArray(node)?node.flatMap(walk):[node,...walk(node.props?.children)];
const text=node=>node===null||node===undefined?"":typeof node!=="object"?String(node):Array.isArray(node)?node.map(text).join(""):text(node.props?.children);
function fixture(extra={}){const api=ui(),calls=[],errors=[],props={open:true,operation:{name:"chrome-profile-login",status:"running",message:"Approve pairing code ABCD1234 once in the Chrome connector, then sign in. Verification is automatic; keep Chrome open."},language:"en",continueLogin:async()=>{throw Error("No Continue in automatic current-profile mode");},openBrowser(){},setError:error=>errors.push(error),openChrome:async()=>{calls.push("open");return true;},installConnector:async()=>{calls.push("install");return true;},cancelLogin:async()=>{calls.push("cancel");return true;},...extra};return{api,calls,errors,props,tree:api.ChromeLoginNotice(props)};}
test("current-profile banner is pending across every app page and replaces Continue/close instructions",()=>{
 const f=fixture();assert(f.api.chromeLoginPending(f.props.operation,false));assert(!f.api.chromeLoginPending(f.props.operation,true));assert.match(text(f.tree),/ABCD1234/);assert.match(text(f.tree),/Verification is automatic/);
 const buttons=walk(f.tree).filter(node=>node.type==="button");assert.deepEqual(buttons.map(text),["Open Chrome","Install connector","Cancel"]);for(const button of buttons)button.props.onClick();assert.deepEqual(f.calls,["open","install","cancel"]);
});
test("automatic verification cannot be resubmitted while Cancel remains accessible",()=>{
 const f=fixture({operation:{name:"chrome-profile-login",status:"running",message:"Verifying the ChatGPT session from your Chrome profile"}}),buttons=walk(f.tree).filter(node=>node.type==="button");assert(buttons[0].props.disabled);assert(buttons[1].props.disabled);assert.equal(buttons[2].props.disabled,false);assert.match(text(f.tree),/Independently verifying sign-in/);
});
test("Chinese current-profile instructions explain one-time extension setup and no close/Continue",()=>{
 const f=fixture({language:"zh-TW"});assert.match(text(f.tree),/目前的 Chrome 設定檔/);assert.match(text(f.tree),/不用關閉 Chrome 或按繼續/);assert(walk(f.tree).some(node=>node.type==="button"&&text(node)==="安裝連接器"));
});
test("connector actions surface errors rather than silently opening another disposable browser",async()=>{
 const f=fixture({openChrome:async()=>{throw Error("Chrome is unavailable");}});walk(f.tree).find(node=>node.type==="button"&&text(node)==="Open Chrome").props.onClick();await new Promise(setImmediate);assert.match(f.errors.at(-1),/Chrome is unavailable/);
});
test("packaged assets and exact preload/IPC wiring expose setup without modifying Chrome policy",()=>{
 const root=path.resolve(__dirname,".."),main=fs.readFileSync(path.join(root,"electron/main.cjs"),"utf8"),preload=fs.readFileSync(path.join(root,"electron/preload.cjs"),"utf8"),app=fs.readFileSync(path.join(root,"src/App.tsx"),"utf8"),pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
 assert(pkg.build.files.includes("assets/chrome-profile-connector/**"));assert.match(main,/loginWithPasskey: \(\) => runtimeHost\.captureCurrentChromeLogin\(\{ safeStorage \}\)/);
 for(const channel of["browser-chrome-profile-open","browser-chrome-profile-cancel","browser-chrome-connector-folder"]){assert(main.includes(`handle("launcher:${channel}"`));assert(preload.includes(`ipcRenderer.invoke("launcher:${channel}")`));}
 assert.match(app,/operation\?\.name === "chrome-profile-login"\) && chromeLoginPending/);assert.match(app,/installConnector=\{\(\) => api!\.showChromeProfileConnectorFolder\(\)\}/);
 const connector=fs.readFileSync(path.join(root,"electron/chrome-profile-login.cjs"),"utf8");assert(!/ExtensionInstallForcelist|reg(?:\.exe)?["']|chrome\.proxy/.test(connector));
});
