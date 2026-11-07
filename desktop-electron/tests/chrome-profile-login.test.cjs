"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const {createChromeProfileCapture,validCapture,chromeConnectorIdentity,prepareChromeConnector,EXTENSION_ID,EXTENSION_ORIGIN,CONNECTOR_FILES}=require("../electron/chrome-profile-login.cjs");
const key=crypto.generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{format:"der",type:"spki"},privateKeyEncoding:{format:"pem",type:"pkcs8"}});
const identity={publicKey:key.publicKey.toString("base64"),privateKey:key.privateKey};
const cookie=(domain=".chatgpt.com")=>({name:"session",value:"fixture-only",domain,path:"/",secure:true,httpOnly:true,sameSite:"Lax",expires:-1});
const capture=()=>({version:1,origin:"https://chatgpt.com",sessionAuthenticated:true,cookies:[cookie()]});
async function call(session,route,{method="GET",origin=EXTENSION_ORIGIN,token=new URL(session.url).hash.slice(1),body,headers={},encrypt=true}={}){
 if(method==="POST"&&route==="/capture"&&body&&encrypt){
  const hello=await call(session,"/hello",{origin,token,headers});
  if(hello.status===200){const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),aes=crypto.createCipheriv("aes-256-gcm",key,iv);aes.setAAD(Buffer.from(`1\n${token}\n${hello.body.port}\n${hello.body.expiresAt}\n`));const data=Buffer.concat([aes.update(JSON.stringify(body)),aes.final(),aes.getAuthTag()]);body={version:1,key:crypto.publicEncrypt({key:crypto.createPublicKey({key:Buffer.from(hello.body.publicKey,"base64"),type:"spki",format:"der"}),padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},key).toString("base64"),iv:iv.toString("base64"),data:data.toString("base64")};}
 }
 const url=new URL(route,session.url);return new Promise((resolve,reject)=>{const request=http.request(url,{method,agent:false,headers:{Origin:origin,Authorization:`Bearer ${token}`,...(body?{"Content-Type":"application/json"}:{}),...headers}},response=>{let data="";response.setEncoding("utf8");response.on("data",chunk=>data+=chunk);response.on("end",()=>resolve({status:response.statusCode,headers:response.headers,body:data?JSON.parse(data):null}));});request.on("error",reject);request.end(body?JSON.stringify(body):undefined);});
}
async function session(t,options={}){const result=await createChromeProfileCapture({identity,timeoutMs:5000,...options});t.after(()=>result.cancel());return result;}

test("one-use capture acknowledges receipt promptly but only app verification can report success",async t=>{
 const phases=[],s=await session(t,{onPhase:value=>phases.push(value)});let answered=false;
 const pending=call(s,"/result",{origin:new URL(s.url).origin}).then(value=>{answered=true;return value;});
 const receipt=await call(s,"/capture",{method:"POST",body:capture()});
 assert.equal(receipt.status,202);assert.deepEqual(receipt.body,{accepted:true});assert.equal(answered,false);
 const transfer=await s.result;assert.equal(transfer.source,"approved-chrome-profile-connector");assert.deepEqual(transfer.storageState.origins,[]);assert.equal(transfer.storageState.cookies[0].domain,".chatgpt.com");assert.deepEqual(phases,["verifying"]);
 await transfer.cleanup();transfer.complete(true);
 const reply=await pending;assert.equal(reply.body.verified,true);assert.deepEqual(phases,["verifying","verified"]);
});
test("failed or abandoned app import never reports verified",async t=>{
 const s=await session(t),pending=call(s,"/result");await call(s,"/capture",{method:"POST",body:capture()});const transfer=await s.result;
 await transfer.cleanup();const reply=await pending;assert.equal(reply.body.verified,false);
});
test("malicious web origin, changed extension id, missing token and rebinding host cannot capture",async t=>{
 const s=await session(t);
 for(const origin of["https://attacker.example","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]){assert.equal((await call(s,"/capture",{method:"POST",origin,body:capture()})).status,403);}
 assert.equal((await call(s,"/capture",{method:"POST",token:"0".repeat(64),body:capture()})).status,403);
 assert.equal((await call(s,"/hello",{headers:{Host:"localhost"}})).status,403);
 assert.equal((await call(s,"/capture",{method:"POST",origin:new URL(s.url).origin,body:capture()})).status,404);
});
test("CORS permits only the approved connector, including private-network preflight",async t=>{
 const s=await session(t),reply=await call(s,"/capture",{method:"OPTIONS"});assert.equal(reply.status,204);assert.equal(reply.headers["access-control-allow-origin"],EXTENSION_ORIGIN);assert.equal(reply.headers["access-control-allow-private-network"],"true");assert(!reply.headers["access-control-allow-credentials"]);
 assert.equal((await call(s,"/capture",{method:"OPTIONS",origin:"null"})).status,403);
});
test("the app identity signs the nonce, port and expiry; no private key appears in replies",async t=>{
 const s=await session(t),reply=await call(s,"/hello"),hello=reply.body,url=new URL(s.url);
 const challenge=`1\n${url.hash.slice(1)}\n${url.port}\n${hello.expiresAt}\n`;
 assert.equal(crypto.verify("sha256",Buffer.from(challenge),{key:crypto.createPublicKey({key:Buffer.from(hello.publicKey,"base64"),type:"spki",format:"der"}),padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(hello.signature,"base64")),true);
 assert.equal(hello.code,s.code);assert(!JSON.stringify(hello).includes("PRIVATE KEY"));assert(!JSON.stringify(hello).includes(url.hash.slice(1)));
});
test("duplicate capture cannot apply cookies to the account twice",async t=>{
 const s=await session(t),first=call(s,"/capture",{method:"POST",body:capture()}),transfer=await s.result;
 assert.equal((await call(s,"/capture",{method:"POST",body:capture()})).status,409);assert.deepEqual((await first).body,{accepted:true});transfer.complete(true);
});
test("plaintext or invalid ciphertext cannot be imported or consume a valid request",async t=>{
 const s=await session(t);
 assert.equal((await call(s,"/capture",{method:"POST",body:capture(),encrypt:false})).status,400);
 assert.equal((await call(s,"/capture",{method:"POST",body:{version:1,key:Buffer.alloc(256).toString("base64"),iv:Buffer.alloc(12).toString("base64"),data:Buffer.alloc(32).toString("base64")},encrypt:false})).status,400);
 const pending=call(s,"/capture",{method:"POST",body:capture()}),transfer=await s.result;assert.deepEqual((await pending).body,{accepted:true});transfer.complete(true);
});

test("unrelated, partitioned, malformed and unverified browser state is refused",()=>{
 for(const body of[{...capture(),cookies:[cookie(".google.com")]},{...capture(),cookies:[cookie(".chatgpt.com.attacker.example")]},{...capture(),sessionAuthenticated:false},{...capture(),cookies:[{...cookie(),partitionKey:"https://chatgpt.com"}]},{...capture(),cookies:[{...cookie(),value:"bad\r\nvalue"}]},{...capture(),cookies:[]}])assert.throws(()=>validCapture(body));
 assert.deepEqual(validCapture(capture()).origins,[]);
});
test("cancel and deadline close only the app connection, never any Chrome process",async t=>{
 const s=await session(t);s.cancel();await assert.rejects(s.result,error=>error.code==="CHROME_LOGIN_CANCELLED");
 const expiring=await session(t,{timeoutMs:10});await assert.rejects(expiring.result,/expired/);
});
test("matching extension id is derived from the bundled public key and host grants stay narrow",()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,"../assets/chrome-profile-connector/manifest.json"),"utf8"));
 const actual=crypto.createHash("sha256").update(Buffer.from(manifest.key,"base64")).digest("hex").slice(0,32).split("").map(char=>String.fromCharCode(97+parseInt(char,16))).join("");
 assert.equal(actual,EXTENSION_ID);assert.deepEqual(manifest.permissions,["cookies","scripting","storage"]);assert(manifest.host_permissions.every(value=>/^https:\/\/(?:\*\.)?(?:chatgpt\.com|openai\.com)\/\*$/.test(value)));assert.equal(manifest.incognito,"not_allowed");
});
test("connector preparation copies only packaged code under the explicit app data root",async t=>{
 const parent=path.join(__dirname,"../../aiTemp/chrome-connector-tests");fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,"data-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const folder=await prepareChromeConnector(path.resolve(__dirname,"../assets/chrome-profile-connector"),root);assert.equal(path.dirname(folder),root);assert.deepEqual(fs.readdirSync(folder).sort(),[...CONNECTOR_FILES].sort());
 const secret="test-encrypted:";const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(secret+value),decryptString:value=>{const text=value.toString();assert(text.startsWith(secret));return text.slice(secret.length);}};
 const first=await chromeConnectorIdentity(root,safeStorage),second=await chromeConnectorIdentity(root,safeStorage);assert.equal(first.publicKey,second.publicKey);assert.equal(first.privateKey,second.privateKey);
 await assert.rejects(chromeConnectorIdentity(root,{isEncryptionAvailable:()=>false}),/OS-protected storage/);
});
