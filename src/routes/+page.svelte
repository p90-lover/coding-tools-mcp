<script lang="ts">
 import {onMount} from 'svelte';
 import {ArrowUpRight, Plus, Folder, ShieldCheck, Eye, Cable, Columns3, Check, Circle, RefreshCw} from '@lucide/svelte';
 import {workspaces,mcpRuntimeStates,actionsRuntimeStates} from '$lib/stores/app';
 import {center,centerError,loadCenter} from '$lib/control-center/api';
 import {locale,labels} from '$lib/control-center/locale';
 import Notice from '$lib/components/center/Notice.svelte';
 let t=$derived(labels[$locale]);let refreshing=$state(false);
 let tasks=$derived(($center?.data.tasks??[]).filter(t=>!t.archived));
 let running=$derived([...Object.values($mcpRuntimeStates),...Object.values($actionsRuntimeStates)].filter(s=>s==='running').length);
 let attention=$derived([...Object.values($mcpRuntimeStates),...Object.values($actionsRuntimeStates)].filter(s=>s==='error').length);
 let configured=$derived(Number($center?.data.paseo.enabled??false)+Number($center?.data.anneal.enabled??false));
 async function refresh(){refreshing=true;window.dispatchEvent(new Event('center:refresh'));try{await loadCenter();}catch{}finally{refreshing=false;}}
 onMount(()=>{void loadCenter().catch(()=>{});});
</script>
<section class="page-scroll cc-page">
 <header class="cc-page-heading"><div><h1>{t.overview}</h1><p>{t.subtitle}</p></div><div class="cc-actions"><button class="cc-button" disabled={refreshing} onclick={refresh}><RefreshCw size={16}/>{t.refresh}</button><button class="cc-button cc-primary" onclick={()=>window.dispatchEvent(new Event('center:add-workspace'))}><Plus size={16}/>{t.add}</button></div></header>
 {#if $centerError}<Notice error text={$centerError}/>{/if}
 <div class="cc-metrics">
  <div><span>{t.workspaces}</span><strong>{$workspaces.length}</strong><small>{$locale==='en'?'Connected project folders':'已連接的專案資料夾'}</small></div>
  <div><span>{t.running}</span><strong>{running}<i class="cc-metric-dot"></i></strong><small>{$locale==='en'?'MCP and Actions listeners':'MCP 及 Actions 服務'}</small></div>
  <div><span>{$locale==='en'?'Open tasks':'未完成任務'}</span><strong>{tasks.filter(t=>t.status!=='DONE').length}</strong><small>{$locale==='en'?'On your local planning board':'你的本機規劃看板'}</small></div>
  <div><span>{t.attention}</span><strong>{attention}</strong><small>{$locale==='en'?'Services reporting an error':'回報錯誤的服務'}</small></div>
 </div>
 <div class="cc-overview-grid">
  <div>
   <section class="cc-panel"><header class="cc-section-header"><div><h2>{t.workspaces}</h2><p>{$locale==='en'?'Open a project to manage its services and permissions.':'開啟專案以管理服務及權限。'}</p></div><span class="cc-count">{$workspaces.length}</span></header>
    {#if $workspaces.length}<div class="cc-table-wrap"><table class="cc-table"><thead><tr><th>{$locale==='en'?'Project':'專案'}</th><th>MCP</th><th>Actions</th><th><span class="sr-only">Open</span></th></tr></thead><tbody>{#each $workspaces as w}<tr><td><a class="cc-project-link" href={'/workspace/'+w.id}><span class="cc-folder"><Folder size={18}/></span><span><strong>{w.name}</strong><small title={w.path}>{w.path}</small></span></a></td><td><span class="cc-state" data-state={$mcpRuntimeStates[w.id]??'unknown'}>{$mcpRuntimeStates[w.id]??'unknown'}</span></td><td><span class="cc-state" data-state={$actionsRuntimeStates[w.id]??'unknown'}>{$actionsRuntimeStates[w.id]??'unknown'}</span></td><td><a class="cc-icon-link" href={'/workspace/'+w.id} aria-label={t.open+': '+w.name}><ArrowUpRight size={18}/></a></td></tr>{/each}</tbody></table></div>{:else}<div class="cc-empty"><Folder size={28}/><h3>{t.empty}</h3><p>{t.emptyHint}</p><button class="cc-button" onclick={()=>window.dispatchEvent(new Event('center:add-workspace'))}><Plus size={15}/>{t.add}</button></div>{/if}
   </section>
   <section class="cc-panel cc-workflow-intro"><div class="cc-section-header"><div><h2>{$locale==='en'?'From idea to a clear next step':'從構想到清晰的下一步'}</h2><p>{$locale==='en'?'Plan locally. Review evidence. Keep execution intentional.':'本機規劃、檢視紀錄，由你決定何時執行。'}</p></div><Columns3 size={22}/></div><div class="cc-process">{#each ($locale==='en'?['Capture a task','Set its status','Record your review']:['建立任務','設定狀態','記錄審查']) as label,i}<span><b>{i+1}</b>{label}</span>{/each}</div><a class="cc-text-link" href="/tasks">{t.tasks}<ArrowUpRight size={15}/></a></section>
  </div>
  <aside class="cc-overview-aside">
   <section class="cc-panel cc-safety"><ShieldCheck size={23}/><h2>{t.safety}</h2><p>{$locale==='en'?'A local control center, not another autonomous agent.':'這是本機控制中心，不是另一個自主 Agent。'}</p><ul><li><Check size={16}/>{$locale==='en'?'No model calls from integrations':'整合不呼叫模型'}</li><li><Check size={16}/>{$locale==='en'?'Screenshots stay in memory':'截圖只留在記憶體'}</li><li><Check size={16}/>{$locale==='en'?'Visible computer-use supervision':'可見的電腦操作監控'}</li></ul><a class="cc-button" href="/computer"><Eye size={16}/>{t.computer}</a></section>
   <section class="cc-panel"><header class="cc-section-header"><h2>{t.connections}</h2><Cable size={19}/></header><div class="cc-integration-summary">{#each ['paseo','anneal'] as provider}<div><span class="cc-provider-symbol">{provider==='paseo'?'P':'A'}</span><strong>{provider==='paseo'?'Paseo':'Anneal'}</strong><span class="cc-state" data-state={$center?.data[provider==='paseo'?'paseo':'anneal'].enabled?'configured':'stopped'}>{$center?.data[provider==='paseo'?'paseo':'anneal'].enabled?($locale==='en'?'Configured':'已設定'):($locale==='en'?'Not connected':'未連接')}</span></div>{/each}</div><p class="cc-muted">{configured}/2 {$locale==='en'?'observers configured. Refresh to verify availability.':'已設定觀察連線；重新整理以確認可用狀態。'}</p><a class="cc-text-link" href="/integrations">{t.manage}<ArrowUpRight size={15}/></a></section>
  </aside>
 </div>
 <footer class="cc-page-footer"><ShieldCheck size={14}/>{$locale==='en'?'Your projects stay local. External integrations are read-only.':'專案保留在本機，外部整合均為唯讀。'}</footer>
</section>
