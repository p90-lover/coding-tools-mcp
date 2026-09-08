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
export async function readIntegration(source:Source,endpoint:string,credential:string) {
 if(get(integrationBusy)[source])return;
 integrationBusy.update(v=>({...v,[source]:true}));
 integrationErrors.update(v=>({...v,[source]:''}));
 try { const result=await invoke<Snapshot>('integration_read',{source,endpoint,credential:credential||null});snapshots.update(v=>({...v,[source]:result})); }
 catch(e) { integrationErrors.update(v=>({...v,[source]:String(e)})); }
 finally {integrationBusy.update(v=>({...v,[source]:false}));}
}
export function clearIntegration(source:Source) { snapshots.update(v=>{const next={...v};delete next[source];return next;});integrationErrors.update(v=>({...v,[source]:''})); }
