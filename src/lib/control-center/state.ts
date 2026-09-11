import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import type { Board, Change, Locale, Snapshot, Source } from './model';
export const locale = writable<Locale>('en');
export const workspaceLoadError = writable('');
export const workspaceLoaded = writable(false);
export const board = writable<Board>({ revision:0, tasks:[] });
export const boardReady = writable(false);
export const boardError = writable('');
export const boardBusy = writable(false);
export const snapshots = writable<Partial<Record<Source, Snapshot>>>({});
export const integrationErrors = writable<Partial<Record<Source, string>>>({});
export const integrationBusy = writable<Partial<Record<Source, boolean>>>({});
// Only non-secret preferences persist in the browser. Tokens and snapshots stay in RAM.
export const endpoints = writable<Record<Source, string>>({paseo:'ws://127.0.0.1:6767/ws',anneal:'http://127.0.0.1:3000/'});
export function initializePreferences() {
 try { const v=localStorage.getItem('control-center-locale');if(v==='en'||v==='zh-Hant')locale.set(v); } catch { /* Storage is optional. */ }
}
export function changeLanguage() { locale.update(v => { const next=v==='en'?'zh-Hant':'en';try{localStorage.setItem('control-center-locale',next);}catch{}return next; }); }
export async function loadBoard() {
 if(get(boardBusy))return;
 boardBusy.set(true);
 try { board.set(await invoke<Board>('control_board_read'));boardReady.set(true);boardError.set(''); }
 catch { boardReady.set(false);boardError.set('The local board could not be loaded. Open the desktop app and retry. / 無法載入本機看板，請在桌面程式重試。'); }
 finally {boardBusy.set(false);}
}
export async function changeBoard(change:Change) {
 if(get(boardBusy)||!get(boardReady))return false;
 boardBusy.set(true);
 try { board.set(await invoke<Board>('control_board_change',{revision:get(board).revision,change}));boardError.set('');return true; }
 catch(e) { boardError.set(String(e));return false; }
 finally {boardBusy.set(false);}
}
// Each source owns a generation; discarded reads may finish but cannot publish.
const integrationGeneration:Record<Source,number>={paseo:0,anneal:0};
function snapshotEndpoint(source:Source,value:string):string {
 const u=new URL(value);
 if(source==='paseo'&&(u.pathname===''||u.pathname==='/'))u.pathname='/ws';
 return u.href;
}
export function clearIntegration(source:Source) {
 integrationGeneration[source]++;
 snapshots.update(v=>{const {[source]:_discarded,...next}=v;return next;});
 integrationErrors.update(v=>({...v,[source]:''}));
 integrationBusy.update(v=>({...v,[source]:false}));
}
let observedEndpoints=get(endpoints);
endpoints.subscribe(next=>{
 for(const source of ['paseo','anneal'] as const) {
  if(next[source]!==observedEndpoints[source])clearIntegration(source);
 }
 observedEndpoints={...next};
});
export async function readIntegration(source:Source,endpoint:string,credential:string) {
 if(get(integrationBusy)[source]||get(endpoints)[source]!==endpoint)return;
 const ticket=++integrationGeneration[source];
 const current=()=>ticket===integrationGeneration[source]&&get(endpoints)[source]===endpoint;
 snapshots.update(v=>{const {[source]:_discarded,...next}=v;return next;});
 integrationBusy.update(v=>({...v,[source]:true}));
 integrationErrors.update(v=>({...v,[source]:''}));
 try {
  const result=await invoke<Snapshot>('integration_read',{source,endpoint,credential:credential||null});
  if(!current())return;
  if(result.source!==source||result.read_only!==true||snapshotEndpoint(source,result.endpoint)!==snapshotEndpoint(source,endpoint)) {
   throw new Error('Integration response does not match this source/endpoint. / 整合回應與目前來源／端點不相符。');
  }
  snapshots.update(v=>({...v,[source]:result}));
 } catch(e) { if(current())integrationErrors.update(v=>({...v,[source]:String(e)})); }
 finally {if(current())integrationBusy.update(v=>({...v,[source]:false}));}
}

let boardRefreshing=false;
/** Quiet refresh never resets a form or replaces an in-flight mutation with older data. */
export async function refreshBoard() {
 if(boardRefreshing||get(boardBusy)||!get(boardReady))return;
 boardRefreshing=true;const revision=get(board).revision;
 try {
  const next=await invoke<Board>('control_board_read');
  if(!get(boardBusy)&&get(board).revision===revision&&next.revision>revision)board.set(next);
 } catch { /* Retain verified data and drafts; manual refresh displays actionable errors. */ }
 finally {boardRefreshing=false;}
}
