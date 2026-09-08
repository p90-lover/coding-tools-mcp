import { invoke } from '@tauri-apps/api/core';
import { writable } from 'svelte/store';
export type Provider = 'paseo' | 'anneal';
export type Stage = 'BACKLOG'|'TODO'|'DOING'|'REVIEW'|'DONE';
export interface LocalTask {
  id:string; workspace_id:string; title:string; description:string; status:Stage; priority:string;
  review_note:string; verification_note:string; revision:number; created_at:number; updated_at:number; archived:boolean;
}
export interface TaskDraft extends Omit<LocalTask,'id'|'revision'|'created_at'|'updated_at'> { id:string|null; expected_revision:number|null; }
export interface Connection { enabled:boolean; url:string; }
export interface CenterState { data:{paseo:Connection;anneal:Connection;tasks:LocalTask[]};paseo_has_token:boolean;anneal_has_token:boolean;execution:string; }
export interface ExternalItem {
  id:string;title:string;status:string;provider?:string;model?:string;path?:string;created_at?:string;updated_at?:string;
  chain_id?:string;chain_name?:string;chain_status?:string;chain_progress?:{position?:number;total?:number;done?:number};
  assignee?:string;review_gate?:boolean;failure_reason?:string;
}
export interface ExternalSnapshot {source:Provider;items:ExternalItem[];observed_at:number;read_only:boolean;has_more:boolean;next_cursor:string|null;}
export const center = writable<CenterState|null>(null);
export const centerError = writable('');
export const external = writable<Partial<Record<Provider,ExternalSnapshot>>>({});
export const externalErrors = writable<Partial<Record<Provider,string>>>({});
let loading:Promise<CenterState>|null=null;
const generations:Record<Provider,number>={paseo:0,anneal:0};
const refreshing=new Map<Provider,{generation:number;promise:Promise<ExternalSnapshot>}>();
export async function loadCenter(force=false):Promise<CenterState> {
  if(loading){if(!force)return loading;try{await loading;}catch{}}
  loading=invoke<CenterState>('center_load').then(value=>{center.set(value);centerError.set('');return value;})
    .catch(error=>{centerError.set(String(error));throw error;}).finally(()=>{loading=null;});
  return loading;
}
export async function saveConnection(provider:Provider,url:string,enabled:boolean,token:string,clearToken=false) {
  generations[provider]++;
  await invoke('center_save_connection',{provider,url,enabled,token:token || null,clearToken});
  external.update(v=>{const next={...v};delete next[provider];return next;});
  externalErrors.update(v=>{const next={...v};delete next[provider];return next;});
  await loadCenter(true);
}
export async function saveTask(draft:TaskDraft):Promise<LocalTask> {
  const value=await invoke<LocalTask>('center_save_task',{draft});
  await loadCenter(true);return value;
}
export async function syncProvider(provider:Provider,cursor:string|null=null):Promise<ExternalSnapshot> {
  const generation=generations[provider];
  const existing=refreshing.get(provider);if(existing?.generation===generation) return existing.promise;
  const promise=invoke<ExternalSnapshot>('center_sync',{provider,cursor}).then(value=>{
    if(generation!==generations[provider]) throw new Error('Connection changed; stale response discarded.');
    external.update(v=>{
      const previous=cursor?v[provider]?.items??[]:[];
      const unique=new Map([...previous,...value.items].map(item=>[item.id,item]));
      return {...v,[provider]:{...value,items:[...unique.values()].slice(0,1000)}};
    });externalErrors.update(v=>({...v,[provider]:''}));return value;
  }).catch(error=>{if(generation===generations[provider])externalErrors.update(v=>({...v,[provider]:String(error)}));throw error;}).finally(()=>{if(refreshing.get(provider)?.promise===promise)refreshing.delete(provider);});
  refreshing.set(provider,{generation,promise});return promise;
}
