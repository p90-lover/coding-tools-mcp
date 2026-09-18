import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),deps=path.resolve('aiTemp/schema-deps');
const require=createRequire(path.join(deps,'package.json'));
const ts=require('typescript');
const paseo=path.resolve(process.env.PASEO_SOURCE_DIR),anneal=path.resolve(process.env.ANNEAL_SOURCE_DIR);
const sha=p=>execFileSync('git',['-C',p,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(sha(paseo),'fa93c4290eaa87ae58452ab6e2012f85ae6e0c6b');
assert.equal(sha(anneal),'2eaea1c7ab5fc4444beab703bf1fbab264ad3f58');
const output=path.join(deps,'schema-source');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'package.json'),JSON.stringify({type:'module'}));
function transpile(input,target){const result=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,result.outputText);}
function copyTree(src,dest){for(const entry of fs.readdirSync(src,{withFileTypes:true})){
 assert(!entry.isSymbolicLink());const from=path.join(src,entry.name),to=path.join(dest,entry.name);
 if(entry.isDirectory()){copyTree(from,to);continue;}
 if(entry.name.endsWith('.ts')&&!entry.name.endsWith('.test.ts')&&!entry.name.endsWith('.d.ts'))transpile(fs.readFileSync(from,'utf8'),to.replace(/\.ts$/,'.js'));
}}
copyTree(path.join(paseo,'packages/protocol/src'),path.join(output,'paseo'));
const p=await import(pathToFileURL(path.join(output,'paseo/messages.js')));
// Extract actual declarations rather than importing API handlers, Prisma, queues
// or any runner. Enum values come from the pinned Prisma datamodel itself.
const prisma=fs.readFileSync(path.join(anneal,'packages/db/prisma/schema.prisma'),'utf8');
let code='import {z} from "zod";\n';
for(const name of ['AssigneeType','ScheduleKind','TaskStatus']){
 const block=prisma.match(new RegExp('enum '+name+' \\{([\\s\\S]*?)\\}'))?.[1];assert(block);
 const keys=block.split('\n').map(s=>s.trim()).filter(s=>s&&!s.startsWith('//')).map(s=>s.split(/\s/)[0]);
 code+='const '+name+'='+JSON.stringify(Object.fromEntries(keys.map(s=>[s,s])))+';\n';
}
function declarations(file,names){const input=fs.readFileSync(file,'utf8'),source=ts.createSourceFile(file,input,ts.ScriptTarget.Latest,true);const found=new Set();let out='';
 for(const statement of source.statements)if(ts.isVariableStatement(statement)){
  for(const d of statement.declarationList.declarations)if(ts.isIdentifier(d.name)&&names.includes(d.name.text)){
   assert(!found.has(d.name.text));found.add(d.name.text);out+='export const '+d.getText(source)+';\n';
  }
 }
 assert.deepEqual([...found].sort(),[...names].sort(),file);return out;
}
code+=declarations(path.join(anneal,'packages/api/src/task-patch.ts'),['id','taskFields','taskCreateStatus','taskInput']);
code+=declarations(path.join(anneal,'packages/api/src/routes/tasks.ts'),['chainHoldInput','chainResumeInput']);
transpile(code,path.join(output,'anneal-input.js'));
const a=await import(pathToFileURL(path.join(output,'anneal-input.js')));
const samples=JSON.parse(fs.readFileSync('aiTemp/evidence/wire-samples.json','utf8'));assert.equal(samples.length,16);
const results=[];
for(const request of samples){let result;
 if(request.engine==='paseo')result=p.SessionInboundMessageSchema.safeParse(request.wire.message);
 else {
  const routes=fs.readFileSync(path.join(anneal,'packages/api/src/routes',request.action==='cancel'?'session.ts':'tasks.ts'),'utf8');
  const route=request.wire.path.replace('/project-one','/:projectId').replace('/record-one','/:taskId').replace('/run-one','/:runId');
  assert(routes.includes('app.'+request.wire.method.toLowerCase()+'("'+route+'"'),route);
  const schema=request.action==='create'?a.taskInput:request.action==='hold'?a.chainHoldInput:request.action==='resume'?a.chainResumeInput:null;
  result=schema?schema.safeParse(request.wire.body):{success:true};
 }
 results.push({engine:request.engine,action:request.action,accepted:result.success,issues:result.success?[]:result.error.issues.map(v=>({path:v.path,message:v.message}))});
}
fs.writeFileSync('aiTemp/evidence/upstream-schema.json',JSON.stringify({paseo:sha(paseo),anneal:sha(anneal),results,model_requests:0},null,2)+'\n');
assert(results.every(r=>r.accepted),'UPSTREAM_EXECUTION_SCHEMA_REJECTED '+JSON.stringify(results.filter(r=>!r.accepted)));
console.log('UPSTREAM_SCHEMA_PASS: all 16 actual builder requests match pinned protocol/route definitions; no daemon or inference executed');
