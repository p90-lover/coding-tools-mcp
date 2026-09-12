<script lang="ts">
 import { onMount } from 'svelte';
 import { Plus, Search, RefreshCw, Archive, ArrowRight, Check, X, Play, Pause, FileText, GripVertical } from '@lucide/svelte';
 import { workspaces } from '$lib/stores/app';
 import { locale, board, boardReady, boardBusy, boardError, loadBoard, refreshBoard, changeBoard, snapshots, integrationErrors } from '$lib/control-center/state';
 import { translated as t, STEPS, COLUMNS, stepLabel, sortChain, formatTime, isBoardState, boardStateLabel, type BoardState, type Change } from '$lib/control-center/model';
 import Status from '$lib/components/control-center/Status.svelte';
 import SourceDetail from '$lib/components/control-center/SourceDetail.svelte';
 let inspectedSource=$state(''),inspectedEndpoint=$state('');
 let sourceDetail=$derived($snapshots.anneal?.endpoint===inspectedEndpoint?$snapshots.anneal?.items.find(i=>i.id===inspectedSource):undefined);
 let source = $state('local'), query = $state(''), archive = $state(false), creating = $state(false), selected = $state('');
 let title = $state(''), description = $state(''), workspace = $state(''), note = $state('');
 let initialState = $state<BoardState>('backlog');
 let dragged = $state(''), dragRevision = $state(0), dropColumn = $state(''), dropBefore = $state(''), announcement = $state('');
 let canEdit = $derived($boardReady && !$boardBusy && source === 'local');
 let tasks = $derived($board.tasks.filter(v => (archive ? v.state === 'archived' : v.state !== 'archived') && v.title.toLowerCase().includes(query.toLowerCase())));
 let detail = $derived($board.tasks.find(v => v.id === selected));
 let remote = $derived(sortChain($snapshots.anneal?.items ?? []).filter(v => `${v.title} ${v.chain_name}`.toLowerCase().includes(query.toLowerCase())));
 function beginCreate(state: BoardState = 'backlog') {
  if (!canEdit || !$workspaces.length) return;
  workspace = detail?.workspace_id ?? workspace ?? '';
  if (!$workspaces.some(w => w.id === workspace)) workspace = $workspaces[0].id;
  if (!creating) { title = ''; description = ''; }
  initialState = state; creating = true; selected = ''; archive = false;
 }
 async function create() {
  const okay = await changeBoard({ operation: 'create', workspace_id: workspace, title, description, state: initialState });
  if (okay) { creating = false; title = ''; description = ''; query = ''; selected = $board.tasks.at(-1)?.id ?? ''; announcement = t($locale, 'Task created.', '已建立任務。'); }
 }
 async function change(c: Change) { if (await changeBoard(c)) note = ''; }
 function choose(id: string) { selected = id; note = ''; creating = false; }
 function endDrag() { dragged = ''; dropColumn = ''; dropBefore = ''; }
 function dragStart(event: DragEvent, id: string) {
  if (!canEdit || archive || !event.dataTransfer) { event.preventDefault(); return; }
  dragged = id; dragRevision = $board.revision;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-coding-tools-task', id);
  event.dataTransfer.setData('text/plain', id);
 }
 function dragOver(event: DragEvent, state: string, before = '') {
  if (!canEdit || archive || !dragged || !isBoardState(state) || before === dragged) return;
  event.preventDefault(); event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropColumn = state; dropBefore = before;
 }
 async function moveTask(id: string, state: string, before?: string) {
  if (!canEdit || !isBoardState(state)) return;
  const okay = await changeBoard({ operation: 'move', id, state, ...(before ? { before_id: before } : {}) });
  if (okay) { announcement = t($locale, `Task moved to ${boardStateLabel(state, 'en')}.`, `任務已移至${boardStateLabel(state, 'zh-Hant')}。`); }
 }
 async function drop(event: DragEvent, state: string, before = '') {
  if (!dragged || !canEdit || archive || !isBoardState(state)) return;
  event.preventDefault(); event.stopPropagation();
  const id = dragged, revision = dragRevision;
  endDrag();
  if (id === before) return;
  if (revision !== $board.revision) { boardError.set(t($locale, 'The board changed during the drag. Refresh before retrying.', '拖曳期間看板已更新，請刷新後再試。')); return; }
  await moveTask(id, state, before || undefined);
 }
 async function selectState(event: Event, id: string, state: string) {
  const control = event.currentTarget as HTMLSelectElement;
  const requested = control.value;
  // Do not display an unsaved selection after a rejected/stale native save.
  control.value = state;
  await moveTask(id, requested);
 }
 onMount(() => { void loadBoard(); const timer=setInterval(() => { if (source==='local' && !dragged && document.visibilityState==='visible') void refreshBoard(); },2500); return () => clearInterval(timer); });
</script>
<section class="cc-page cc-board-page">
 <header class="cc-page-heading"><a class="cc-button ghost" href="/tasks">{t($locale, 'Task monitor', '任務監察')}</a><div><h1>{t($locale, 'Work board', '任務看板')}</h1><p>{t($locale, 'From specification to delivery. Keep the evidence beside the work.', '從規格到交付，讓工作與依據保持一致。')}</p></div><button class="cc-button primary" disabled={!canEdit || !$workspaces.length} onclick={() => beginCreate()}><Plus size={16}/>{t($locale, 'New task', '新增任務')}</button></header>
 <div class="cc-tabs"><button class:active={source === 'local'} onclick={() => { source = 'local'; endDrag(); }}>{t($locale, 'Local delivery board', '本機交付看板')}<span>{$board.tasks.filter(task => task.state !== 'archived').length}</span></button><button class:active={source === 'anneal'} onclick={() => { source = 'anneal'; selected = ''; creating = false; endDrag(); }}>Anneal<span>{$snapshots.anneal?.items.length ?? '—'}</span></button></div>
 <div class="cc-toolbar"><label class="cc-search-field"><Search size={17}/><input bind:value={query} placeholder={t($locale, 'Filter tasks…', '篩選任務…')} aria-label={t($locale, 'Filter tasks', '篩選任務')}/></label>{#if source === 'local'}<button class="cc-button ghost" class:selected={archive} onclick={() => { archive = !archive; selected = ''; creating = false; endDrag(); }}><Archive size={15}/>{t($locale, 'Archive', '封存')}</button><button class="cc-icon-btn" disabled={$boardBusy} onclick={() => void loadBoard()} aria-label={t($locale, 'Refresh board', '刷新看板')}><RefreshCw size={17}/></button>{:else}<a class="cc-button ghost" href="/integrations">{t($locale, 'Refresh connection', '更新連線')}</a>{/if}</div>
 {#if source === 'local'}
  {#if $boardError}<div class="cc-notice red" role="alert">{$boardError}</div>{/if}
  <p class="cc-board-mode"><FileText size={14}/>{t($locale, 'Drag cards to move or reorder. Use “Move task to” for keyboard control. Checklist evidence stays separate.', '拖曳卡片可移動或排序，也可使用「移動任務至」選單。清單依據會獨立保留。')}</p>
  <div class="cc-sr-only" role="status" aria-live="polite">{announcement}</div>
  <div class:with-detail={!!detail || creating} class="cc-board-layout"><div class="cc-kanban">
   {#each archive ? [['archived', 'Archived', '已封存'] as const] : COLUMNS as column}
    <section class="cc-column" class:drop-active={dropColumn === column[0]} data-board-column={column[0]} aria-label={t($locale, column[1], column[2])}>
     <header><span class="cc-column-dot {column[0]}"></span><h2>{t($locale, column[1], column[2])}</h2><span>{tasks.filter(v => v.state === column[0]).length}</span></header>
     {#if !archive}<button class="cc-column-add" disabled={!canEdit || !$workspaces.length} aria-label={t($locale, `New task in ${column[1]}`, `在${column[2]}新增任務`)} onclick={() => { if (isBoardState(column[0])) beginCreate(column[0]); }}><Plus size={14}/>{t($locale, 'New task', '新增任務')}</button>{/if}
     <div class="cc-column-cards" role="list" aria-label={t($locale, `${column[1]} tasks`, `${column[2]}任務`)} ondragover={e => dragOver(e, column[0])} ondrop={e => void drop(e, column[0])}>
      {#each tasks.filter(v => v.state === column[0]) as task (task.id)}
       <div class="cc-task-card" role="listitem" class:chosen={selected === task.id} class:dragging={dragged === task.id} class:drop-before={dropBefore === task.id} data-task-id={task.id} draggable={canEdit && !archive} ondragstart={e => dragStart(e, task.id)} ondragend={endDrag} ondragover={e => dragOver(e, column[0], task.id)} ondrop={e => void drop(e, column[0], task.id)}>
        <button class="cc-card-open" onclick={() => choose(task.id)} aria-label={t($locale, `Open task ${task.title}`, `開啟任務 ${task.title}`)}>
         <span class="cc-card-top"><span class="cc-task-project">{$workspaces.find(w => w.id === task.workspace_id)?.name ?? t($locale, 'Unlinked workspace', '未連結工作區')}</span>{#if !archive}<GripVertical size={14} aria-hidden="true"/>{/if}</span>
         <strong>{task.title}</strong><span class="cc-task-step">{stepLabel(task.step, $locale)}</span><div class="cc-task-progress"><span style={`width:${Math.min(task.step, 12) / 12 * 100}%`}></span></div><footer><span>{task.step}/12</span><span>{new Date(task.updated_at * 1000).toLocaleDateString()}</span></footer>
        </button>
       </div>
      {/each}
      {#if !tasks.some(v => v.state === column[0])}<div class="cc-column-empty">{t($locale, dragged ? 'Drop task here' : 'No tasks', dragged ? '將任務放在這裡' : '沒有任務')}</div>{/if}
     </div>
    </section>
   {/each}
  </div>
  {#if creating}
   <aside class="cc-task-detail"><header><h2>{t($locale, 'New task', '新增任務')}</h2><button class="cc-icon-btn" onclick={() => creating = false} aria-label={t($locale, 'Close new task', '關閉新增任務')}><X size={18}/></button></header>
    <form class="cc-form" onsubmit={e => { e.preventDefault(); void create(); }}>
     <label>{t($locale, 'Workspace', '工作區')}<select bind:value={workspace} required>{#each $workspaces as w}<option value={w.id}>{w.name}</option>{/each}</select></label>
     <label>{t($locale, 'Initial status', '初始狀態')}<select bind:value={initialState} aria-label={t($locale, 'Initial status', '初始狀態')}>{#each COLUMNS as c}<option value={c[0]}>{t($locale, c[1], c[2])}</option>{/each}</select></label>
     <label>{t($locale, 'Task title', '任務標題')}<input bind:value={title} maxlength="240" required placeholder={t($locale, 'What needs to be delivered?', '需要交付甚麼？')}/></label>
     <label>{t($locale, 'Specification', '規格')}<textarea bind:value={description} rows="5" maxlength="8192" placeholder={t($locale, 'Outcome, constraints and acceptance criteria…', '目標、限制與驗收條件…')}></textarea></label>
     <p class="cc-help">{t($locale, 'Creates a local task only. No coding agent is started and no checklist step is automatically completed.', '只建立本機任務，不啟動編程 Agent，也不會自動完成清單步驟。')}</p>
     <button class="cc-button primary" disabled={!canEdit}>{t($locale, 'Create task', '建立任務')}<ArrowRight size={15}/></button>
    </form>
   </aside>
  {:else if detail}
   <aside class="cc-task-detail"><header><span class="cc-task-project">{t($locale, 'TASK DETAILS', '任務詳情')}</span><button class="cc-icon-btn" onclick={() => selected = ''} aria-label={t($locale, 'Close task', '關閉任務')}><X size={18}/></button></header><h2>{detail.title}</h2><Status state={detail.state} label={boardStateLabel(detail.state, $locale)}/>
    {#if detail.description}<p class="cc-spec-text">{detail.description}</p>{/if}
    {#if detail.state !== 'archived'}<label class="cc-move-field">{t($locale, 'Move task to', '移動任務至')}<select aria-label={t($locale, 'Move task to', '移動任務至')} value={detail.state} disabled={!canEdit} onchange={e => void selectState(e, detail!.id, detail!.state)}>{#each COLUMNS as c}<option value={c[0]}>{t($locale, c[1], c[2])}</option>{/each}</select></label><p class="cc-help">{t($locale, 'Board status only — checklist evidence is unchanged.', '只變更看板狀態，不會修改清單依據。')}</p>{/if}
    <div class="cc-button-row">
     {#if detail.state === 'backlog'}<button class="cc-button primary" disabled={!canEdit} onclick={() => void change({ operation: 'start', id: detail!.id })}><Play size={14}/>{t($locale, 'Start checklist', '開始清單')}</button>{:else if detail.state === 'in_progress'}<button class="cc-button secondary" disabled={!canEdit} onclick={() => void change({ operation: 'block', id: detail!.id })}><Pause size={14}/>{t($locale, 'Mark blocked', '標記受阻')}</button>{:else if detail.state === 'blocked'}<button class="cc-button secondary" disabled={!canEdit} onclick={() => void change({ operation: 'resume', id: detail!.id })}><Play size={14}/>{t($locale, 'Resume checklist', '繼續清單')}</button>{/if}
     <button class="cc-button ghost" disabled={!canEdit} onclick={() => void change({ operation: detail!.state === 'archived' ? 'restore' : 'archive', id: detail!.id })}><Archive size={14}/>{t($locale, detail.state === 'archived' ? 'Restore' : 'Archive', detail.state === 'archived' ? '還原' : '封存')}</button>
    </div>
    <ol class="cc-chain-steps">{#each STEPS as step, i}<li class:complete={i < detail.step} class:current={i === detail.step}><span class="cc-step-number">{#if i < detail.step}<Check size={13}/>{:else}{i + 1}{/if}</span><div><strong>{step[$locale === 'en' ? 0 : 1]}</strong>{#if detail.evidence.find(e => e.step === i)}<details><summary>{t($locale, 'Recorded evidence', '已記錄依據')}</summary>{#each detail.evidence.filter(e => e.step === i) as evidence}<p><small>{evidence.source === 'mcp_observation' ? t($locale, 'AI / MCP observation — not human approval', 'AI／MCP 觀察 — 不代表人類批准') : t($locale, 'Human attestation', '人類確認')}</small><br/>{evidence.note}</p>{/each}</details>{/if}</div></li>{/each}</ol>
    {#if detail.state === 'in_progress' && detail.step < STEPS.length}<form class="cc-form cc-record-step" onsubmit={e => { e.preventDefault(); void change({ operation: 'record_step', id: detail!.id, note }); }}><label>{t($locale, 'Evidence for this step', '此步驟的依據')}<textarea bind:value={note} rows="3" required maxlength="4096" placeholder={t($locale, 'Test result, review reference or your explicit attestation…', '測試結果、審查參考或你的明確確認…')}></textarea></label><button class="cc-button primary" disabled={!canEdit || !note.trim()}><Check size={15}/>{t($locale, 'Record & complete step', '記錄並完成步驟')}</button></form>{/if}
   </aside>
  {/if}</div>
  {#if !$workspaces.length && $boardReady}<div class="cc-notice">{t($locale, 'Add a workspace from the sidebar before creating a task.', '建立任務前，請先從側邊欄新增工作區。')}</div>{/if}
 {:else}
  {#if $integrationErrors.anneal}<div class="cc-notice amber">{t($locale, 'Last refresh failed. This snapshot may be stale.', '上次更新失敗，狀態可能已過期。')}</div>{/if}
  <section class="cc-panel">{#if !$snapshots.anneal}<div class="cc-empty tall"><FileText size={32}/><h2>{t($locale, 'Bring your Anneal board into view', '連接你的 Anneal 看板')}</h2><p>{t($locale, 'Connect its existing API to read task state, chain ordering and approval gates.', '連接現有 API，讀取任務狀態、流程排序及批准關卡。')}</p><a class="cc-button primary" href="/integrations">{t($locale, 'Connect Anneal', '連接 Anneal')}</a></div>{:else}<div class="cc-table-wrap"><table class="cc-table"><thead><tr><th>{t($locale, 'Task', '任務')}</th><th>{t($locale, 'Chain', '流程')}</th><th>{t($locale, 'Layer / index', '層級／索引')}</th><th>{t($locale, 'State', '狀態')}</th><th>{t($locale, 'Gate', '關卡')}</th></tr></thead><tbody>{#each remote as row (row.id)}<tr><td><button class="cc-button ghost" aria-label={t($locale,`Inspect Anneal task ${row.title||row.id}`,`檢視 Anneal 任務 ${row.title||row.id}`)} onclick={()=>{inspectedSource=row.id;inspectedEndpoint=$snapshots.anneal?.endpoint??'';}}>{row.title || row.id}</button></td><td>{row.chain_name || '—'}</td><td>{row.chain_layer ?? '—'} / {row.chain_index ?? '—'}</td><td><Status state={row.status}/></td><td>{row.requires_attention ? t($locale, 'Review in Anneal', '在 Anneal 審查') : '—'}</td></tr>{/each}</tbody></table>{#if !remote.length}<p class="cc-quiet-empty">{t($locale, 'No matching tasks.', '沒有相符任務。')}</p>{/if}</div>{/if}</section>
  {#if $snapshots.anneal?.has_more}<p class="cc-notice amber">{t($locale, 'Partial board: first 200 records only.', '部分看板：僅顯示前 200 項。')}</p>{/if}<p class="cc-page-footnote">{t($locale, 'Read-only snapshot', '唯讀狀態')} · {formatTime($snapshots.anneal?.checked_at)}</p>
 {/if}
{#if sourceDetail && $snapshots.anneal && source==='anneal'}<SourceDetail item={sourceDetail} snapshot={$snapshots.anneal} source="anneal" onclose={()=>inspectedSource=''}/>{/if}
</section>
