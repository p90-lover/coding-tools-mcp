import {readFile,writeFile} from 'node:fs/promises';
import {compile} from 'svelte/compiler';
import {render} from 'svelte/server';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const source=await readFile(process.env.PROFILE_SOURCE || 'src/lib/components/RuntimePolicyForm.svelte','utf8');
const compiled=compile(source,{filename:'RuntimePolicyForm.svelte',generate:'server'}).js.code.replaceAll('$lib/',pathToFileURL(path.resolve('src/lib')).href+'/');
const file='aiTemp/tool-exposure/form.server.mjs';
await writeFile(file,compiled);
const Form=(await import(pathToFileURL(path.resolve(file)).href)).default;
for(const [profile,selection] of [['core','core'],['advanced','advanced'],['full','advanced'],['read-only','read-only'],['compat-readonly-all','compat-readonly-all']]){
 const html=render(Form,{props:{toolProfile:profile,permissionMode:'read-only',approvalMode:'ask',allowedCommands:'git',workspaceLocalEntries:false,workspaceScriptExtensions:'.exe',allowScreenCapture:false,onSave(){throw new Error('Rendering must not save');}}}).body;
 const first=html.match(/<select[^>]*>([\s\S]*?)<\/select>/)?.[1]??'';
 assert.match(first,new RegExp(`<option[^>]*value="${selection}"[^>]*selected`),`PROFILE_SELECTION_MISSING: ${profile}`);
}
console.log('PASS: actual Svelte SSR resolves all persisted profile selections');
