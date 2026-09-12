<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { RefreshCw, Activity, Clock, FileText, ShieldCheck } from '@lucide/svelte';
  import { workspaces } from '$lib/stores/app';
  import { locale } from '$lib/control-center/state';
  import { translated as t } from '$lib/control-center/model';
  import { createWorkspaceRefresh } from '$lib/workspace-refresh';
  import Status from '$lib/components/control-center/Status.svelte';
  type Cursor = { workspace_id: string; task_id: string; before: number };
  type Task = { id:string; objective:string; status:string; created_at:string; updated_at:string; completed_count:number; pending_count:number; completed_steps?:string[]; pending_steps?:string[]; steps_truncated?:boolean; latest_change_id?:string|null; latest_verification_id?:string|null };
  type Event = { id:string; operation_id:string; kind:string; tool_name:string|null; created_at:string; ok:boolean|null; code:string|null; exit_code:number|null; command_id:string|null; files:{path:string;status:string}[] };
  type Operation = { operation_id:string; request_id:unknown; tool_name:string; method:string; state:string; completion_kind:string|null; admitted_at_ms:number; finished_at_ms:number|null; result_state:string };
  type Snapshot = { workspace_id:string; requested_task_id:string|null; workspace_path:string; desktop_version:string; checked_at_ms:number; listener_running:boolean; runtime_id:string|null; policy_revision:number|null; permission_mode:string; retention_note:string;
    history:{tasks:Task[];task:Task|null;events:Event[];next_cursor:Cursor|null;partial_tail:boolean;warnings:string[];recent_limit:number};operations:Operation[] };
  let workspace = $state(''), selected = $state(''), lookup = $state(''), filter = $state('');
  let cursor = $state<Cursor|null>(null), snapshot = $state<Snapshot|null>(null);
  let failure = $state(''), loading = $state(false), auto = $state(true), mounted = $state(false);
  let refresh = $state<((invalidate?:boolean)=>Promise<void>)|null>(null);
  let rows = $derived((snapshot?.history.tasks ?? []).filter(task => `${task.id} ${task.objective} ${task.status}`.toLowerCase().includes(filter.toLowerCase())));
  let detail = $derived(snapshot?.history.task);
  function time(value:string|number|null|undefined):string {
    const n = Number(value);return n>0 && Number.isFinite(n) ? new Date(n).toLocaleString() : '—';
  }
  function inspect(id:string) { selected=id;lookup=id;cursor=null; }
  function scopeChanged() { selected='';lookup='';cursor=null; }
  function operationLabel(o:Operation):string {
    if(o.state==='admitted')return t($locale,'Accepted — awaiting dispatch','已接受 — 等待分派');
    if(o.state==='running')return t($locale,'Tool dispatch in progress','工具分派進行中');
    if(o.completion_kind==='returned')return t($locale,'Dispatch returned; command may still run','分派已回傳；命令可能仍在運行');
    if(o.completion_kind==='tool_error'||o.completion_kind==='rpc_error')return t($locale,'Dispatch returned an error','分派回傳錯誤');
    return t($locale,'Outcome unknown — inspect receipt','結果未知 — 請核對操作紀錄');
  }
  onMount(() => {
    const coordinator = createWorkspaceRefresh(async () => {
      const workspaceId=workspace, taskId=selected||null, at=cursor;
      if(!workspaceId)throw Error('Select an approved workspace / 請選擇已批准的工作區');
      loading=true;
      try {
        const value=await invoke<Snapshot>('task_monitor_read',{workspaceId,taskId,cursor:at});
        if(value.workspace_id!==workspaceId || value.requested_task_id!==taskId || !Array.isArray(value.history?.tasks) || !Array.isArray(value.operations))throw Error('Task monitor response does not match the requested scope / 回應與工作範圍不符');
        return value;
      } finally {loading=false;}
    }, value => { snapshot=value;failure=''; }, error => {failure=String(error);});
    refresh=coordinator.run;mounted=true;
    const timer=setInterval(()=> { if(auto&&!document.hidden&&workspace&&!cursor)void coordinator.run(false); },3000);
    const focused=()=> { if(auto&&!document.hidden&&workspace&&!cursor)void coordinator.run(false); };
    window.addEventListener('focus',focused);document.addEventListener('visibilitychange',focused);
    return ()=> { clearInterval(timer);coordinator.stop();window.removeEventListener('focus',focused);document.removeEventListener('visibilitychange',focused); };
  });
  $effect(() => {
    if(mounted && $workspaces.length && !workspace) workspace=$workspaces[0].id;
    if(mounted && workspace && !$workspaces.some(w=>w.id===workspace)) { workspace='';selected='';cursor=null;snapshot=null; }
  });
  $effect(() => {
    const key=[workspace,selected,cursor?.before];
    if(mounted && refresh) { snapshot=null;failure=''; if(key[0])void refresh(true); }
  });
</script>

<section class="cc-page monitor">
  <header class="cc-page-heading"><div><h1>{t($locale,'Task monitor','任務監察')}</h1><p>{t($locale,'Recorded tasks, event evidence and live listener receipts — not simulated agent progress.','任務紀錄、事件依據及即時 listener 操作紀錄，不是假造的 Agent 進度。')}</p></div><a href="/work" class="cc-button secondary">{t($locale,'Delivery board','交付看板')}</a></header>
  <div class="cc-toolbar monitor-toolbar">
    <label>{t($locale,'Workspace','工作區')}<select aria-label={t($locale,'Workspace','工作區')} bind:value={workspace} onchange={scopeChanged}>{#each $workspaces as item}<option value={item.id}>{item.name}</option>{/each}</select></label>
    <label class="cc-check"><input type="checkbox" bind:checked={auto}/>{t($locale,'Auto-refresh','自動刷新')}</label>
    <button class="cc-button secondary" onclick={()=>void refresh?.(true)} disabled={!workspace||loading} aria-label={t($locale,'Refresh monitor','刷新監察')}><RefreshCw size={16}/>{t($locale,'Refresh','刷新')}</button>
    <span class="cc-muted" aria-live="polite">{loading?t($locale,'Reading existing records…','正在讀取既有紀錄…'):t($locale,'Read-only · 3-second refresh','唯讀 · 每三秒刷新')}</span>
  </div>
  {#if failure}<div class="cc-notice amber" role="alert">{failure}</div>{/if}
  {#if failure&&snapshot}<p class="cc-notice amber">{t($locale,'Last verified snapshot — stale','上次核實的快照 — 已過時')}</p>{/if}
  {#if !$workspaces.length}<div class="cc-empty tall"><Activity size={32}/><h2>{t($locale,'Add an approved workspace first','請先加入已批准的工作區')}</h2><p>{t($locale,'Observation does not authorize new folders or start a runtime.','監察不會授權新資料夾或啟動 runtime。')}</p></div>{/if}
  {#if snapshot}
    <div class="metrics">
      <article class="cc-panel"><span>{t($locale,'Desktop / listener','Desktop／listener')}</span><strong>v{snapshot.desktop_version} · {snapshot.listener_running?t($locale,'Running','運行中'):t($locale,'Not running','未運行')}</strong><small>{snapshot.workspace_path}</small></article>
      <article class="cc-panel"><span>{t($locale,'Current permission','目前權限')}</span><strong>{snapshot.permission_mode}</strong><small>{t($locale,'Policy revision','策略版本')} {snapshot.policy_revision??'—'}</small></article>
      <article class="cc-panel"><span>{t($locale,'Last observation','最近觀察')}</span><strong>{time(snapshot.checked_at_ms)}</strong><small>{t($locale,'A timestamp is not a worker heartbeat.','此時間不是工作程序的 heartbeat。')}</small></article>
    </div>
    <div class="task-layout">
      <aside class="cc-panel task-list"><h2><FileText size={18}/>{t($locale,'Recent task records','最近任務紀錄')}</h2>
        <input class="filter" aria-label={t($locale,'Filter task records','篩選任務紀錄')} placeholder={t($locale,'Search title, ID or status','搜尋標題、ID 或狀態')} bind:value={filter}/>
        <p class="cc-muted">{t($locale,'Up to 20 indexed tasks. Use an exact task ID for older records.','最多顯示 20 項已索引任務，較舊紀錄可輸入完整任務 ID。')}</p>
        {#each rows as task (task.id)}<button class="task-choice" class:chosen={selected===task.id} aria-label={t($locale,`Inspect task ${task.objective}`,`檢視任務 ${task.objective}`)} onclick={()=>inspect(task.id)}><strong>{task.objective}</strong><Status state={task.status}/><small>{task.id}</small><span>{task.completed_count} {t($locale,'recorded done','項已記錄完成')} · {task.pending_count} {t($locale,'pending','項待辦')}</span></button>{/each}
        {#if !rows.length}<p class="cc-quiet-empty">{t($locale,'No matching task records. Standalone MCP calls can still appear in receipts below.','沒有符合的任務紀錄，獨立 MCP 呼叫仍可能出現在下方操作紀錄。')}</p>{/if}
        <form class="lookup" onsubmit={e=>{e.preventDefault();if(/^[a-fA-F0-9]{32}$/.test(lookup.trim()))inspect(lookup.trim());}}><label>{t($locale,'Exact task ID','完整任務 ID')}<input bind:value={lookup} pattern="[a-fA-F0-9]{32}" maxlength="32" required/></label><button class="cc-button ghost" type="submit">{t($locale,'Inspect','檢視')}</button></form>
      </aside>
      <section class="cc-panel task-details"><h2>{t($locale,'Task details & event timeline','任務詳情及事件時間線')}</h2>
        {#if detail}
          <h3>{detail.objective}</h3><p class="ids">{detail.id} · <Status state={detail.status}/></p>
          <p class="cc-muted">{t($locale,'Created','建立')} {time(detail.created_at)} · {t($locale,'Updated','更新')} {time(detail.updated_at)}</p>
          <div class="steps"><section><h4>{t($locale,'Recorded completed steps','已記錄完成步驟')}</h4>{#each detail.completed_steps??[] as step}<p>✓ {step}</p>{/each}</section><section><h4>{t($locale,'Recorded pending steps','已記錄待辦步驟')}</h4>{#each detail.pending_steps??[] as step}<p>○ {step}</p>{/each}</section></div>
          {#if detail.steps_truncated}<p class="cc-notice amber">{t($locale,'Displayed steps are shortened; original task remains unchanged.','顯示步驟已截短，原始任務保持不變。')}</p>{/if}
          <p class="ids">{t($locale,'Change receipt','變更紀錄')} {detail.latest_change_id??'—'} · {t($locale,'Verification receipt','驗證紀錄')} {detail.latest_verification_id??'—'}</p>
          <div class="timeline" aria-label={t($locale,'Recorded task events','任務事件紀錄')}>
            {#each snapshot.history.events as event (event.id)}<article><header><Clock size={14}/><time>{time(event.created_at)}</time><strong>{event.tool_name??event.kind}</strong><span>{event.ok===true?t($locale,'Recorded OK','已記錄成功'):event.ok===false?t($locale,'Recorded error','已記錄錯誤'):t($locale,'Observed','已觀察')}</span></header><p>{event.kind}</p><code>{event.operation_id}</code>{#if event.code}<p>{event.code}</p>{/if}{#if event.exit_code!==null}<p>{t($locale,'Exit code','結束代碼')} {event.exit_code}</p>{/if}{#if event.command_id}<p>{t($locale,'Command handle','命令 handle')} <code>{event.command_id}</code></p>{/if}{#each event.files as file}<small>{file.status} · {file.path}</small>{/each}</article>{/each}
            {#if !snapshot.history.events.length}<p class="cc-quiet-empty">{t($locale,'No complete events in this bounded page.','此有界分頁沒有完整事件。')}</p>{/if}
          </div>
          <div class="event-navigation"><button class="cc-button ghost" disabled={!snapshot.history.next_cursor||loading} onclick={()=>cursor=snapshot!.history.next_cursor}>{t($locale,'Earlier events','較早事件')}</button>{#if cursor}<button class="cc-button ghost" onclick={()=>cursor=null}>{t($locale,'Latest events','最新事件')}</button>{/if}<span class="cc-muted">{t($locale,'Up to 50 events · latest-page polling only','最多 50 項事件 · 只在最新分頁自動刷新')}</span></div>
          {#if snapshot.history.partial_tail}<p class="cc-notice amber">{t($locale,'An event is still being written; the incomplete tail is not presented as a result.','有事件仍在寫入，不會把不完整內容當成結果。')}</p>{/if}
        {:else}<div class="cc-empty"><FileText size={30}/><h3>{t($locale,'Choose a task to inspect','選擇要檢視的任務')}</h3><p>{t($locale,'Steps and status are recorded evidence, not proof of a running external agent.','步驟及狀態屬已記錄的依據，不代表外部 Agent 正在運行。')}</p></div>{/if}
        {#each snapshot.history.warnings as warning}<p class="cc-notice amber">{warning}</p>{/each}
      </section>
    </div>
    <section class="cc-panel receipts"><h2><Activity size={18}/>{t($locale,'Recent MCP dispatch receipts','最近 MCP 分派紀錄')}</h2><p class="cc-muted">{t($locale,'Workspace-wide, not automatically assigned to the selected task. A returned command handle may still be running.','涵蓋整個工作區，不會自動歸屬到所選任務。已回傳的命令 handle 可能仍在執行。')}</p>
      <div class="cc-table-wrap"><table class="cc-table"><thead><tr><th>{t($locale,'Tool / operation ID','工具／操作 ID')}</th><th>{t($locale,'Observed state','觀察狀態')}</th><th>{t($locale,'Accepted','接受時間')}</th><th>{t($locale,'Dispatch returned','分派回傳時間')}</th></tr></thead><tbody>{#each snapshot.operations as op (op.operation_id)}<tr><td><strong>{op.tool_name||op.method}</strong><small class="ids">{op.operation_id}</small></td><td>{operationLabel(op)}<small class="ids">{op.result_state}</small></td><td>{time(op.admitted_at_ms)}</td><td>{time(op.finished_at_ms)}</td></tr>{/each}</tbody></table></div>
      {#if !snapshot.operations.length}<p class="cc-quiet-empty">{t($locale,'No retained receipts. Missing records mean unknown, not never executed.','沒有保留的操作紀錄。紀錄缺失代表未知，不代表從未執行。')}</p>{/if}
      <p class="cc-muted">{t($locale,'Receipts are memory-only, bounded and expire. No automatic replay, raw arguments or output bodies are exposed here.','操作紀錄只存在記憶體、有數量及期限限制。此頁不會自動重做，也不顯示原始參數或輸出本文。')}</p><p class="ids">Runtime: {snapshot.runtime_id??'—'}</p>
    </section>
  {/if}
  <footer class="cc-page-footnote"><ShieldCheck size={14}/>{t($locale,'Read-only monitoring. Pausing refresh does not pause workers. Paseo and Anneal directories remain separate; provider assignment and review are not implemented by this view.','唯讀監察。停止刷新不會暫停工作程序。Paseo／Anneal 目錄保持獨立，此畫面未實作供應商任務指派及審查。')} <a href="/sessions">Paseo</a> · <a href="/work">Anneal</a></footer>
</section>
<style>
.monitor{max-width:1700px}.monitor-toolbar{flex-wrap:wrap}.monitor-toolbar label:not(.cc-check){display:flex;align-items:center;gap:.6rem}.monitor select,.filter,.lookup input{border:1px solid var(--border);border-radius:8px;padding:.55rem;background:var(--card-bg);color:inherit}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;margin:1rem 0}.metrics article{padding:1rem;display:flex;flex-direction:column;gap:.45rem}.metrics span,.metrics small{font-size:.8rem;opacity:.7;overflow-wrap:anywhere}.metrics strong{font-size:.95rem}.task-layout{display:grid;grid-template-columns:minmax(230px,340px) minmax(0,1fr);gap:1rem}.task-list,.task-details,.receipts{padding:1rem;min-width:0}.monitor h2{font-size:1rem;display:flex;align-items:center;gap:.4rem;margin:0 0 1rem}.task-choice{display:flex;flex-direction:column;align-items:flex-start;gap:.4rem;width:100%;text-align:left;padding:.85rem;margin:.5rem 0;border:1px solid var(--border);border-radius:10px;background:transparent;color:inherit;overflow-wrap:anywhere}.task-choice.chosen{outline:2px solid var(--cc-blue)}.task-choice small,.task-choice span{font-size:.75rem}.filter{width:100%}.lookup{display:flex;align-items:end;gap:.3rem;margin-top:1rem}.lookup label{font-size:.75rem;min-width:0}.lookup input{display:block;width:100%}.steps{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1rem 0}.steps h4{font-size:.85rem}.steps p{font-size:.85rem;overflow-wrap:anywhere;margin:.5rem 0}.ids{display:block;font-size:.75rem;overflow-wrap:anywhere}.timeline{max-height:520px;overflow:auto}.timeline article{border-left:3px solid var(--border);padding:.6rem 1rem;margin:.7rem 0}.timeline header{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;font-size:.75rem}.timeline p,.timeline code{font-size:.8rem;overflow-wrap:anywhere}.timeline small{display:block}.event-navigation{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin-top:1rem}.receipts{margin-top:1rem}.receipts td{max-width:440px;overflow-wrap:anywhere}.cc-muted{font-size:.8rem}.cc-page-footnote{flex-wrap:wrap}@media(max-width:950px){.metrics{grid-template-columns:1fr}.task-layout{grid-template-columns:1fr}.task-list{max-height:420px;overflow:auto}.steps{grid-template-columns:1fr}.monitor-toolbar label:not(.cc-check){align-items:start;flex-direction:column}}
</style>
