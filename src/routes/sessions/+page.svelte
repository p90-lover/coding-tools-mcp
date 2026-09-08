<script lang="ts">
 import {onMount} from 'svelte';
 import {Radio,RefreshCw,Search,ShieldCheck,Link,ChevronDown} from '@lucide/svelte';
 import {center,external,externalErrors,loadCenter,syncProvider} from '$lib/control-center/api';
 import {locale,labels} from '$lib/control-center/locale';
 import {formatTime} from '$lib/control-center/model.js';
 import Notice from '$lib/components/center/Notice.svelte';
 let query=$state(''),busy=$state(false);let t=$derived(labels[$locale]);
 let snapshot=$derived($external.paseo);
 let items=$derived((snapshot?.items??[]).filter(t=>`${t.title} ${t.provider} ${t.path}`.toLowerCase().includes(query.toLowerCase())));
 async function refresh(more=false){busy=true;try{await syncProvider('paseo',more?snapshot?.next_cursor??null:null);}catch{}finally{busy=false;}}
 onMount(()=>{void loadCenter().catch(()=>{});});
</script>
<section class="page-scroll cc-page">
 <header class="cc-page-heading"><div><h1>{t.sessions}</h1><p>{$locale==='en'?'One read-only view of your existing Paseo agents.':'在同一唯讀介面查看既有 Paseo Agent。'}</p></div><button class="cc-button" disabled={busy||!$center?.data.paseo.enabled} onclick={()=>refresh()}><RefreshCw size={16}/>{busy?($locale==='en'?'Refreshing…':'整理中…'):t.refresh}</button></header>
 <Notice text={$locale==='en'?'This integration never starts, resumes, messages or approves agents. Existing agents started elsewhere may continue to use their provider quotas.':'此整合不會啟動、恢復、傳送訊息或批准 Agent。在其他介面啟動的 Agent 仍可能消耗供應商配額。'}/>
 {#if $externalErrors.paseo}<Notice error text={$externalErrors.paseo}/>{/if}
 <div class="cc-toolbar"><div class="cc-search-field"><Search size={16}/><input bind:value={query} placeholder={$locale==='en'?'Search sessions or projects…':'搜尋會話或專案…'} aria-label="Search sessions"/></div><span class="cc-badge"><ShieldCheck size={14}/>Paseo · {t.readOnly}</span></div>
 <section class="cc-panel">
  {#if !snapshot}<div class="cc-empty"><Radio size={31}/><h3>{$center?.data.paseo.enabled?($locale==='en'?'Read your session directory':'讀取會話目錄'):($locale==='en'?'Connect to Paseo':'連接 Paseo')}</h3><p>{$locale==='en'?'Use an existing local Paseo daemon. Connect it, then refresh to retrieve real session metadata.':'使用已運行的本機 Paseo 服務。連接後重新整理，即可取得實際會話資料。'}</p><a class="cc-button" href="/integrations"><Link size={16}/>{t.connections}</a></div>
  {:else if !items.length}<div class="cc-empty"><Radio size={28}/><h3>{$locale==='en'?'No matching sessions':'沒有相符會話'}</h3><p>{$locale==='en'?'The directory was read successfully. Try a different search or load another page.':'目錄已成功讀取。請更改搜尋條件或載入下一頁。'}</p></div>
  {:else}<div class="cc-table-wrap"><table class="cc-table cc-session-table"><thead><tr><th>{$locale==='en'?'Session / project':'會話／專案'}</th><th>{$locale==='en'?'Provider':'供應商'}</th><th>{$locale==='en'?'Model':'模型'}</th><th>{$locale==='en'?'Status':'狀態'}</th></tr></thead><tbody>{#each items as item (item.id)}<tr><td><div class="cc-session-title"><span class="cc-session-icon"><Radio size={16}/></span><div><strong>{item.title||item.id}</strong><small title={item.path}>{item.path||'—'}</small><code>{item.id}</code></div></div></td><td>{item.provider||'—'}</td><td><span class="cc-model-label">{item.model||'—'}</span></td><td><span class="cc-state" data-state={item.status}>{item.status||'unknown'}</span></td></tr>{/each}</tbody></table></div>{/if}
 </section>
 <footer class="cc-page-footer cc-between"><span>{$locale==='en'?'Last read:':'最近讀取：'} {formatTime(snapshot?.observed_at)} · {snapshot?.items.length??0} {$locale==='en'?'loaded':'已載入'}{#if $externalErrors.paseo} · {$locale==='en'?'Last successful snapshot':'上次成功的資料'}{/if}</span>{#if snapshot?.has_more}<button class="cc-button" disabled={busy||(snapshot?.items.length??0)>=1000} onclick={()=>refresh(true)}><ChevronDown size={15}/>{$locale==='en'?'Load next page':'載入下一頁'}</button>{/if}</footer>
 {#if (snapshot?.items.length??0)>=1000}<Notice text={$locale==='en'?'The local view is capped at 1,000 rows. Refresh to start a new directory snapshot.':'本機檢視最多顯示 1,000 列。重新整理可開始新的目錄快照。'}/>{/if}
</section>
