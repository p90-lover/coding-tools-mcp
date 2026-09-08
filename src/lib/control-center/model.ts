import { deriveAgentStateBucket, getAgentStatusPriority } from './vendor/paseo-agent-state';
import { compare } from './vendor/anneal-chain-order';

export type Source = 'paseo' | 'anneal';
export type Locale = 'en' | 'zh-Hant';
export interface Item {
  id: string; title: string; status: string; provider: string; workspace: string;
  updated_at: string; pending_permissions: number; requires_attention: boolean;
  attention_reason?: string | null;
  chain_id: string | null; chain_index: number | null; chain_layer: number | null; chain_name: string | null;
}
export interface Snapshot { source: Source; endpoint: string; checked_at: number; read_only: true; items: Item[]; has_more: boolean; server_version: string | null }
export interface Evidence { step: number; note: string; recorded_at: number; source: 'operator_attestation' }
export interface Task { id: string; workspace_id: string; title: string; description: string; state: string; step: number; created_at: number; updated_at: number; evidence: Evidence[] }
export interface Board { revision: number; tasks: Task[] }
export type Change = { operation: 'create'; workspace_id: string; title: string; description: string } | { operation: 'start' | 'block' | 'resume' | 'archive' | 'restore'; id: string } | { operation: 'record_step'; id: string; note: string };
export const STEPS = [
 ['Specification','規格'],['Plan','計劃'],['Plan review','計劃審查'],['Revise plan','修訂計劃'],['Implementation','實作'],['Code review','程式碼審查'],['Independent review','獨立審查'],['Apply fixes','套用修正'],['Documentation','文件'],['Verification','驗證'],['Merge readiness','合併準備'],['Delivery','交付'],
] as const;
export const COLUMNS = [['backlog','Backlog','待辦'],['in_progress','In progress','進行中'],['blocked','Needs attention','需要處理'],['done','Done','已完成']] as const;
const lifecycle = new Set(['initializing','idle','running','error','closed']);
function agentInput(item: Item) {
 return { status: item.status as 'idle' | 'running' | 'error' | 'closed' | 'initializing', pendingPermissionCount: item.pending_permissions, requiresAttention: item.requires_attention,
 attentionReason: ['finished','error','permission'].includes(item.attention_reason ?? '') ? item.attention_reason as 'finished' | 'error' | 'permission' : null };
}
export function attention(item: Item) { return item.requires_attention || item.pending_permissions > 0 || ['error','permission'].includes(item.attention_reason ?? '') || ['error','failed','blocked','review'].includes(item.status.toLowerCase()); }
export function agentBucket(item: Item) { return lifecycle.has(item.status) ? deriveAgentStateBucket(agentInput(item)) : 'unknown'; }
export function sortAgents(items: Item[]) { return [...items].sort((a,b) => (lifecycle.has(a.status) ? getAgentStatusPriority(agentInput(a)) : -1) - (lifecycle.has(b.status) ? getAgentStatusPriority(agentInput(b)) : -1) || a.id.localeCompare(b.id)); }
export function sortChain(items: Item[]) { return [...items].sort((a,b) => (a.chain_id ?? '').localeCompare(b.chain_id ?? '') || compare({id:a.id,layer:a.chain_layer,index:a.chain_index},{id:b.id,layer:b.chain_layer,index:b.chain_index})); }
export function stateTone(state: string) { state=state.toLowerCase(); if (['running','doing','in_progress','starting','initializing'].includes(state)) return 'blue'; if(['done','completed','succeeded'].includes(state))return 'green'; if(['blocked','review','needs_input','attention'].includes(state))return 'amber';if(['error','failed'].includes(state))return 'red';return 'neutral'; }
export function stepLabel(step: number, locale: Locale) { return STEPS[step]?.[locale === 'en' ? 0 : 1] ?? (locale === 'en' ? 'Complete' : '已完成'); }
export function formatTime(seconds?: number) { return seconds ? new Date(seconds*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—'; }
export function translated(locale: Locale, english: string, chinese: string) { return locale === 'en' ? english : chinese; }
