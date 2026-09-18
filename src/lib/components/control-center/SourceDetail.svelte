<script lang="ts">
 import { X, ShieldCheck, Play, Pause, Check, Ban, Archive, Send } from '@lucide/svelte';
 import { locale } from '$lib/control-center/state';
 import { actIntegration } from '$lib/control-center/state';
 import { translated as t, formatTime, type Item, type Snapshot, type Source } from '$lib/control-center/model';
 import Status from './Status.svelte';
 let {item,snapshot,source,onclose}:{item:Item;snapshot:Snapshot;source:Source;onclose:()=>void}=$props();
 let text=$state('');
 let notice=$state('');
 let error=$state('');
 let busy=$state(false);
 async function act(op: string, extra: Record<string,string> = {}) {
  if (busy) return;
  busy = true; error=''; notice='';
  try {
   const result = await actIntegration(source, snapshot.endpoint, {
    op,
    agent_id: item.id,
    task_id: item.id,
    message_id: item.id,
    provider: item.persistence_provider || item.provider,
    session_id: item.persistence_session || '',
    request_id: item.pending_permission_id || '',
    cwd: item.workspace,
    text,
    ...extra,
   });
   notice = result && typeof result === 'object' && 'detail' in result ? String((result as {detail:string}).detail) : t($locale,'Action sent.','已送出動作。');
  } catch (e) { error = String(e); }
  finally { busy = false; }
 }
</script>
<section class="cc-panel source-detail" aria-label={source==='paseo'?'Paseo details':'Anneal details'}>
 <header><div><p class="cc-muted">{t($locale,'Provider-reported details','供應商回報的詳情')} · {source==='paseo'?'Paseo':'Anneal'}</p><h2>{item.title||item.id}</h2></div><button class="cc-icon-btn" aria-label={t($locale,'Close source details','關閉來源詳情')} onclick={onclose}><X size={18}/></button></header>
 <Status state={item.status}/>
 <dl><dt>{t($locale,'Record ID','紀錄 ID')}</dt><dd><code>{item.id}</code></dd><dt>{t($locale,'Provider','供應商')}</dt><dd>{item.provider||'—'}</dd><dt>{t($locale,'Workspace','工作區')}</dt><dd>{item.workspace||'—'}</dd><dt>{t($locale,'Pending permissions','待批准權限')}</dt><dd>{item.pending_permissions}</dd><dt>{t($locale,'Attention reason','需要處理的原因')}</dt><dd>{item.attention_reason||'—'}</dd><dt>{t($locale,'Reported update time','回報的更新時間')}</dt><dd>{item.updated_at||'—'}</dd><dt>{t($locale,'Snapshot received','收到快照')}</dt><dd>{formatTime(snapshot.checked_at)}</dd><dt>{t($locale,'Source endpoint','來源端點')}</dt><dd>{snapshot.endpoint}</dd><dt>{t($locale,'Source version','來源版本')}</dt><dd>{snapshot.server_version||t($locale,'Not reported','未回報')}</dd>
 {#if source==='anneal'}<dt>{t($locale,'Chain / ID','流程／ID')}</dt><dd>{item.chain_name||'—'} · {item.chain_id||'—'}</dd><dt>{t($locale,'Layer / index','層級／索引')}</dt><dd>{item.chain_layer??'—'} / {item.chain_index??'—'}</dd>{/if}</dl>
 {#if source==='paseo'}
  <label>{t($locale,'Message or create prompt','訊息或建立提示詞')}<textarea bind:value={text} rows="3"></textarea></label>
  <div class="cc-button-row">
   <button class="cc-button primary" disabled={busy} onclick={()=>void act('send')}><Send size={14}/>{t($locale,'Send','發送')}</button>
   <button class="cc-button" disabled={busy||!item.persistence_session} onclick={()=>void act('resume')}><Play size={14}/>Resume</button>
   <button class="cc-button" disabled={busy} onclick={()=>void act('cancel')}><Pause size={14}/>Cancel</button>
   <button class="cc-button" disabled={busy||!item.pending_permission_id} onclick={()=>void act('permission',{behavior:'allow'})}><Check size={14}/>Allow</button>
   <button class="cc-button ghost" disabled={busy||!item.pending_permission_id} onclick={()=>void act('permission',{behavior:'deny'})}><Ban size={14}/>Deny</button>
   <button class="cc-button ghost" disabled={busy} onclick={()=>void act('archive')}><Archive size={14}/>Archive</button>
   <button class="cc-button ghost" disabled={busy||!text.trim()||!item.workspace} onclick={()=>void act('create')}>{t($locale,'Create','建立')}</button>
  </div>
 {:else if item.chain_name==='inbox'}
  <label>{t($locale,'Inbox decision or reply','Inbox 決策或回覆')}<textarea bind:value={text} rows="3"></textarea></label>
  <div class="cc-button-row">
   <button class="cc-button primary" disabled={busy} onclick={()=>void act('inbox_decision')}><Check size={14}/>{t($locale,'Decision','決策')}</button>
   <button class="cc-button" disabled={busy} onclick={()=>void act('inbox_reply')}><Send size={14}/>{t($locale,'Reply','回覆')}</button>
   <button class="cc-button ghost" disabled={busy} onclick={()=>void act('inbox_close')}>{t($locale,'Close card','關閉卡片')}</button>
  </div>
 {:else}
  <div class="cc-button-row">
   <button class="cc-button primary" disabled={busy} onclick={()=>void act('start')}><Play size={14}/>Start</button>
   <button class="cc-button" disabled={busy} onclick={()=>void act('retry')}><Play size={14}/>Retry</button>
   <button class="cc-button" disabled={busy} onclick={()=>void act('hold')}><Pause size={14}/>Hold</button>
   <button class="cc-button" disabled={busy} onclick={()=>void act('resume')}><Play size={14}/>Resume</button>
   <button class="cc-button ghost" disabled={busy} onclick={()=>void act('archive')}><Archive size={14}/>Archive</button>
   <button class="cc-button ghost" disabled={busy} onclick={()=>void act('unarchive')}>{t($locale,'Unarchive','取消封存')}</button>
  </div>
 {/if}
 {#if notice}<div class="cc-notice" role="status">{notice}</div>{/if}
 {#if error}<div class="cc-notice red" role="alert">{error}</div>{/if}
 <p class="cc-notice"><ShieldCheck size={15}/>{t($locale,'Actions use the original allowlisted APIs of the running service. They do not start a bundled engine.','這些動作使用已運行服務的原版允許名單 API，不會啟動打包引擎。')}</p>
 {#if snapshot.has_more}<p class="cc-notice amber">{t($locale,'The directory is partial; omitted records are not marked completed.','此目錄並不完整，未載入紀錄不會標示為已完成。')}</p>{/if}
</section>
<style>.source-detail{margin-top:1rem;padding:1.25rem}.source-detail header{display:flex;justify-content:space-between;gap:1rem}.source-detail h2{font-size:1.15rem;margin:.4rem 0}.source-detail dl{display:grid;grid-template-columns:180px minmax(0,1fr);gap:.6rem 1rem;margin:1rem 0;font-size:.85rem}.source-detail dt{color:var(--text-secondary)}.source-detail dd{margin:0;overflow-wrap:anywhere}.source-detail .cc-notice{display:flex;gap:.5rem;align-items:flex-start}.source-detail textarea{width:100%;margin:.5rem 0}@media(max-width:640px){.source-detail dl{grid-template-columns:1fr}.source-detail dt{font-weight:600}.source-detail dd{margin-bottom:.5rem}}</style>
