<script lang="ts">
 import {onMount} from 'svelte';
 import {page} from '$app/stores';
 import {Plus,Search,RefreshCw,Archive,Link,Flag,FileCheck2,Columns3,X} from '@lucide/svelte';
 import {center,centerError,external,externalErrors,loadCenter,syncProvider,type LocalTask,type ExternalItem} from '$lib/control-center/api';
 import {columns,filterTasks,formatTime} from '$lib/control-center/model.js';
 import {locale,labels} from '$lib/control-center/locale';
 import {workspaces} from '$lib/stores/app';
 import TaskEditor from '$lib/components/center/TaskEditor.svelte';
 import Notice from '$lib/components/center/Notice.svelte';
 let source=$state<'local'|'anneal'>('local'),query=$state(''),workspace=$state(''),archived=$state(false),busy=$state(false),editing=$state(false);
 let selected=$state<LocalTask|null>(null),remote=$state<ExternalItem|null>(null),mobileStage=$state('TODO');
 let t=$derived(labels[$locale]);
 let tasks=$derived(source==='local'?filterTasks($center?.data.tasks??[],workspace,query,archived):($external.anneal?.items??[]).filter(t=>t.title.toLowerCase().includes(query.toLowerCase())));
 let unknown=$derived(tasks.filter(t=>!columns.some(c=>c.status===t.status)));
 async function refresh(){busy=true;try{if(source==='anneal')await syncProvider('anneal');else await loadCenter();}catch{}finally{busy=false;}}
 function create(){selected=null;editing=true;}
 function inspect(item:LocalTask|ExternalItem){if(source==='local'){selected=item as LocalTask;editing=true;}else remote=item as ExternalItem;}
 onMount(()=>{void loadCenter().catch(()=>{});if($page.url.searchParams.get('new')==='1'&&$workspaces.length)create();});
</script>
<section class="page-scroll cc-page cc-board-page">
 <header class="cc-page-heading"><div><h1>{t.tasks}</h1><p>{$locale==='en'?'Turn specifications into visible, trackable work.':'把規格整理成清晰、可追蹤的工作。'}</p></div><button class="cc-button cc-primary" disabled={!$workspaces.length||source!=='local'} onclick={create}><Plus size={17}/>{t.newTask}</button></header>
 <div class="cc-source-tabs" role="group" aria-label="Board source"><button class:active={source==='local'} onclick={()=>{source='local';remote=null;}}><Columns3 size={16}/>{t.native}</button><button class:active={source==='anneal'} onclick={()=>{source='anneal';remote=null;}}><Link size={16}/>Anneal <span>{$locale==='en'?'Read-only':'唯讀'}</span></button></div>
 {#if $centerError}<Notice error text={$centerError}/>{/if}
 {#if source==='anneal'}<Notice text={$locale==='en'?'Read-only snapshot of Anneal’s real task board. Run, approve and merge actions are not sent from this app.':'唯讀顯示 Anneal 的實際任務看板。本程式不會傳送執行、批准或合併操作。'}/>{#if $externalErrors.anneal}<Notice error text={$externalErrors.anneal}/>{/if}{/if}
 <div class="cc-toolbar"><div class="cc-search-field"><Search size={16}/><input bind:value={query} placeholder={$locale==='en'?'Search tasks…':'搜尋任務…'} aria-label="Search tasks"/></div>{#if source==='local'}<select class="cc-input cc-workspace-filter" bind:value={workspace} aria-label={t.workspaces}><option value="">{t.all}</option>{#each $workspaces as w}<option value={w.id}>{w.name}</option>{/each}</select><label class="cc-check"><input type="checkbox" bind:checked={archived}/><Archive size={15}/>{$locale==='en'?'Archived':'已封存'}</label>{/if}<button class="cc-button" onclick={refresh} disabled={busy||(source==='anneal'&&!$center?.data.anneal.enabled)}><RefreshCw size={15}/>{busy?($locale==='en'?'Refreshing…':'整理中…'):t.refresh}</button></div>
 {#if source==='anneal'&&!$external.anneal}<div class="cc-panel cc-empty"><Link size={30}/><h3>{$center?.data.anneal.enabled?($locale==='en'?'Ready to read Anneal':'準備讀取 Anneal'):($locale==='en'?'Connect your Anneal board':'連接 Anneal 看板')}</h3><p>{$locale==='en'?'Configure the local API in Connections, then refresh. No runner is launched.':'在連線頁設定本機 API，再重新整理。不會啟動執行器。'}</p><a class="cc-button" href="/integrations">{t.connections}</a></div>
 {:else}
 <select class="cc-input cc-stage-picker" bind:value={mobileStage} aria-label="Board column">{#each columns as c}<option value={c.status}>{$locale==='en'?c.label:c.zh} ({tasks.filter(t=>t.status===c.status).length})</option>{/each}</select>
 <div class="cc-board">{#each columns as column}
  <section class:cc-mobile-column={mobileStage===column.status} class="cc-column" aria-label={$locale==='en'?column.label:column.zh}>
   <header><span class="cc-lane-dot" data-stage={column.status}></span><h2>{$locale==='en'?column.label:column.zh}</h2><span class="cc-count">{tasks.filter(task=>task.status===column.status).length}</span></header>
   <div class="cc-lane">{#each tasks.filter(task=>task.status===column.status) as task (task.id)}<button class="cc-task-card" onclick={()=>inspect(task)}><span class="cc-task-id">{source==='local'?'LOCAL':'ANNEAL'} · {task.id.slice(0,7)}</span><h3>{task.title}</h3>{#if 'description' in task&&task.description}<p>{task.description}</p>{/if}{#if 'chain_name' in task&&task.chain_name}<p>{task.chain_name}</p>{/if}<footer><span>{'workspace_id' in task?($workspaces.find(w=>w.id===task.workspace_id)?.name??'Workspace'):(task.assignee||'Anneal')}</span>{#if 'priority' in task&&task.priority==='high'}<Flag size={13} class="cc-high-priority"/>{/if}{#if task.status==='REVIEW'}<FileCheck2 size={14}/>{/if}{#if 'review_gate' in task&&task.review_gate}<span class="cc-gate">Gate</span>{/if}</footer></button>{/each}
    {#if !tasks.some(task=>task.status===column.status)}<div class="cc-lane-empty">{$locale==='en'?'No tasks here':'尚無任務'}</div>{/if}
   </div>
  </section>
 {/each}</div>
 {#if unknown.length}<Notice text={`${unknown.length} ${$locale==='en'?'upstream tasks have an unknown status; they are not counted as completed.':'項上游任務狀態不明，不會視為已完成。'}`}/>{#each unknown as item}<button class="cc-button" onclick={()=>inspect(item)}>{item.title}</button>{/each}{/if}
 {/if}
 <footer class="cc-page-footer">{#if source==='anneal'}{$locale==='en'?'Last read:':'最近讀取：'} {formatTime($external.anneal?.observed_at)}{#if $externalErrors.anneal} · {$locale==='en'?'Showing the last successful snapshot':'顯示上次成功取得的資料'}{/if}{:else}{$locale==='en'?'Local planning uses Anneal’s board semantics. Completion notes are operator-recorded, not CI evidence.':'本機規劃採用 Anneal 看板狀態；完成紀錄由操作員填寫，不代表 CI 驗證。'}{/if}</footer>
</section>
{#if editing}<TaskEditor task={selected} workspaceId={workspace||$workspaces[0]?.id||''} onclose={()=>editing=false}/>{/if}
{#if remote}<aside class="cc-inspector" aria-label="Anneal task details"><header><h2>{$locale==='en'?'Anneal task':'Anneal 任務'}</h2><button class="cc-icon-button" aria-label="Close details" onclick={()=>remote=null}><X size={19}/></button></header><span class="cc-badge">{t.readOnly}</span><h3>{remote.title}</h3><dl><dt>ID</dt><dd>{remote.id}</dd><dt>{$locale==='en'?'Status':'狀態'}</dt><dd>{remote.status}</dd><dt>{$locale==='en'?'Chain':'流程'}</dt><dd>{remote.chain_name||'—'}</dd><dt>{$locale==='en'?'Chain status':'流程狀態'}</dt><dd>{remote.chain_status||'—'}</dd><dt>{$locale==='en'?'Chain progress':'流程進度'}</dt><dd>{remote.chain_progress?.done??'—'} / {remote.chain_progress?.total??'—'}</dd><dt>{$locale==='en'?'Assignee':'負責 Agent'}</dt><dd>{remote.assignee||'—'}</dd><dt>{$locale==='en'?'Approval gate':'批准關卡'}</dt><dd>{remote.review_gate?($locale==='en'?'Requires attention':'需要處理'):'—'}</dd></dl>{#if remote.failure_reason}<Notice text={remote.failure_reason} error/>{/if}<p class="cc-muted">{$locale==='en'?'Make execution decisions in your existing Anneal installation. This viewer cannot start or approve a chain.':'請在既有 Anneal 安裝中決定執行操作。此檢視器不能啟動或批准流程。'}</p></aside>{/if}
