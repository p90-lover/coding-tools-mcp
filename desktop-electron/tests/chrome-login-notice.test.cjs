"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),ts=require("typescript");
const source=path.join(__dirname,"../src/ChromeLoginNotice.tsx");
function fixture(){
 const state=[],exports={};let cursor=0;
 const react={useState(initial){const at=cursor++;if(!(at in state))state[at]=initial;return[state[at],value=>{state[at]=value;}];},useRef(initial){const at=cursor++;if(!(at in state))state[at]={current:initial};return state[at];},useEffect:work=>work()};
 const jsx=(type,props)=>({type,props});
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(source,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>name==="react"?react:name==="react/jsx-runtime"?{jsx,jsxs:jsx}:{}});
 const calls=[],errors=[];
 const props={open:true,operation:{name:"passkey-login",status:"running",message:"Sign in in Chrome"},language:"en",continueLogin:async()=>{calls.push("continue");return true;},openBrowser:()=>calls.push("browser"),setError:error=>errors.push(error)};
 return{...exports,calls,errors,props,render:extra=>{cursor=0;return exports.ChromeLoginNotice({...props,...extra});}};
}
const walk=node=>!node||typeof node!=="object"?[]:Array.isArray(node)?node.flatMap(walk):[node,...walk(node.props?.children)];
const text=node=>node===null||node===undefined?"":typeof node!=="object"?String(node):Array.isArray(node)?node.map(text).join(""):text(node.props?.children);
const button=(tree,label)=>walk(tree).find(node=>node.type==="button"&&text(node)===label);

test("only a running Chrome/passkey operation without a verified account is pending",()=>{
 const f=fixture();assert(f.chromeLoginPending(f.props.operation,false));assert(!f.chromeLoginPending(null,false));
 for(const status of["completed","failed"])assert(!f.chromeLoginPending({...f.props.operation,status},false));
 assert(!f.chromeLoginPending({...f.props.operation,name:"setup"},false));assert(!f.chromeLoginPending(f.props.operation,true));
});
test("the global notice explains ordinary Chrome sign-in and makes Continue explicit, never automatic",()=>{
 const f=fixture(),tree=f.render();assert.equal(tree.props.role,"status");assert.match(text(tree),/dedicated Chrome window, close that window, then choose Continue/);
 assert.doesNotMatch(text(tree),/passkey/i);assert.deepEqual(f.calls,[]);assert(button(tree,"Continue"));
 button(tree,"Open Browser").props.onClick();assert.deepEqual(f.calls,["browser"]);
});
test("Continue is single-flight and stays disabled while capture is being verified",async()=>{
 const f=fixture(),first=button(f.render(),"Continue");first.props.onClick();first.props.onClick();assert.deepEqual(f.calls,["continue"]);
 await new Promise(setImmediate);const busy=button(f.render(),"Verifying sign-in…");assert.equal(busy.props.disabled,true);
 f.render({open:false});assert.equal(button(f.render(),"Continue").props.disabled,false);
});
test("a rejected Continue reports its error and permits an explicit retry",async()=>{
 const f=fixture();f.props.continueLogin=async()=>{f.calls.push("continue");throw new Error("Close the dedicated Chrome window first");};
 button(f.render(),"Continue").props.onClick();await new Promise(setImmediate);
 assert.match(f.errors.at(-1),/Close the dedicated Chrome window first/);assert.equal(button(f.render(),"Continue").props.disabled,false);
 button(f.render(),"Continue").props.onClick();assert.equal(f.calls.length,2);await new Promise(setImmediate);
});
test("a continuation already requested on Browser stays disabled when another page shows the notice",()=>{
 const f=fixture(),tree=f.render({operation:{...f.props.operation,message:"Capturing and verifying the passkey session"}});
 assert.equal(button(tree,"Verifying sign-in…").props.disabled,true);button(tree,"Verifying sign-in…").props.onClick();assert.deepEqual(f.calls,[]);
});
test("a continued login waiting on open Chrome does not claim importing or allow another Continue",()=>{
 const f=fixture(),operation={...f.props.operation,message:"Waiting for the dedicated Chrome window to close before importing"};
 const tree=f.render({operation});
 assert.match(text(tree),/Continue (?:was |has been )?received|already accepted/i);
 assert.match(text(tree),/close.*Chrome window/i);
 assert.doesNotMatch(text(tree),/Verifying sign-in/);
 const waiting=button(tree,"Waiting for Chrome to close…");assert(waiting);assert.equal(waiting.props.disabled,true);
 waiting.props.onClick();assert.deepEqual(f.calls,[]);
 assert(f.chromeLoginContinuationPending(operation));
 assert(f.chromeLoginWaitingForClose(operation));
 const capture={...operation,message:"Capturing and verifying the Chrome session"};
 assert(f.chromeLoginContinuationPending(capture));assert(!f.chromeLoginWaitingForClose(capture));
 assert(!f.chromeLoginContinuationPending({...operation,status:"failed"}));
 const app=fs.readFileSync(path.join(__dirname,"../src/App.tsx"),"utf8");
 assert.match(app,/passkeyContinuationRequested \|\| chromeLoginContinuationPending\(operation\)/);
 assert.match(app,/disabled=\{passkeyWaiting && passkeyContinuationPending\}/);
 assert.match(app,/passkeyWaitingForClose \? copy\.passkeyWaitingForCloseBody/);
});

test("closed or completed notices take no space and both locales have readable actions",()=>{
 const f=fixture();assert.equal(f.render({open:false}),null);assert.match(text(f.render({language:"zh-TW"})),/完成 Chrome 登入/);assert(button(f.render({language:"zh-TW"}),"繼續"));
 const app=fs.readFileSync(path.join(__dirname,"../src/App.tsx"),"utf8");
 assert.match(app,/\(surface !== "browser" \|\| operation\?\.name === "chrome-profile-login"\) && chromeLoginPending\(operation, browser\?\.authenticated\)/);
 assert.match(app,/<ChromeLoginNotice[\s\S]*?continueLogin=\{\(\) => api!\.continuePasskeyLogin\(\)\}/);
 const css=fs.readFileSync(path.join(__dirname,"../src/chrome-login-notice.css"),"utf8");
 assert.match(css,/\.workspace\.has-chrome-login-notice > \.surface-transition\s*\{[^}]*min-height:\s*0/);
});
