<script lang="ts">
 import { X, ShieldCheck } from '@lucide/svelte';
 import { locale } from '$lib/control-center/state';
 import { translated as t, formatTime, type Item, type Snapshot, type Source } from '$lib/control-center/model';
 import Status from './Status.svelte';
 let {item,snapshot,source,onclose}:{item:Item;snapshot:Snapshot;source:Source;onclose:()=>void}=$props();
</script>
<section class="cc-panel source-detail" aria-label={source==='paseo'?'Paseo details':'Anneal details'}>
 <header><div><p class="cc-muted">{t($locale,'Provider-reported details','供應商回報的詳情')} · {source==='paseo'?'Paseo':'Anneal'}</p><h2>{item.title||item.id}</h2></div><button class="cc-icon-btn" aria-label={t($locale,'Close source details','關閉來源詳情')} onclick={onclose}><X size={18}/></button></header>
 <Status state={item.status}/>
 <dl><dt>{t($locale,'Record ID','紀錄 ID')}</dt><dd><code>{item.id}</code></dd><dt>{t($locale,'Provider','供應商')}</dt><dd>{item.provider||'—'}</dd><dt>{t($locale,'Workspace','工作區')}</dt><dd>{item.workspace||'—'}</dd><dt>{t($locale,'Pending permissions','待批准權限')}</dt><dd>{item.pending_permissions}</dd><dt>{t($locale,'Attention reason','需要處理的原因')}</dt><dd>{item.attention_reason||'—'}</dd><dt>{t($locale,'Reported update time','回報的更新時間')}</dt><dd>{item.updated_at||'—'}</dd><dt>{t($locale,'Snapshot received','收到快照')}</dt><dd>{formatTime(snapshot.checked_at)}</dd><dt>{t($locale,'Source endpoint','來源端點')}</dt><dd>{snapshot.endpoint}</dd><dt>{t($locale,'Source version','來源版本')}</dt><dd>{snapshot.server_version||t($locale,'Not reported','未回報')}</dd>
 {#if source==='anneal'}<dt>{t($locale,'Chain / ID','流程／ID')}</dt><dd>{item.chain_name||'—'} · {item.chain_id||'—'}</dd><dt>{t($locale,'Layer / index','層級／索引')}</dt><dd>{item.chain_layer??'—'} / {item.chain_index??'—'}</dd>{/if}</dl>
 <p class="cc-notice"><ShieldCheck size={15}/>{t($locale,'Read-only source snapshot. This panel does not assign work, approve permissions, pause workers or certify a review. Use the source application for those actions.','這是來源的唯讀快照。此面板不會指派工作、批准權限、暫停程序或認證審查；這些操作仍需在來源應用程式進行。')}</p>
 {#if snapshot.has_more}<p class="cc-notice amber">{t($locale,'The directory is partial; omitted records are not marked completed.','此目錄並不完整，未載入紀錄不會標示為已完成。')}</p>{/if}
</section>
<style>.source-detail{margin-top:1rem;padding:1.25rem}.source-detail header{display:flex;justify-content:space-between;gap:1rem}.source-detail h2{font-size:1.15rem;margin:.4rem 0}.source-detail dl{display:grid;grid-template-columns:180px minmax(0,1fr);gap:.6rem 1rem;margin:1rem 0;font-size:.85rem}.source-detail dt{color:var(--text-secondary)}.source-detail dd{margin:0;overflow-wrap:anywhere}.source-detail .cc-notice{display:flex;gap:.5rem;align-items:flex-start}@media(max-width:640px){.source-detail dl{grid-template-columns:1fr}.source-detail dt{font-weight:600}.source-detail dd{margin-bottom:.5rem}}</style>
