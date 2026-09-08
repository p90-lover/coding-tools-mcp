<script lang="ts">
 import {onMount} from 'svelte';
 import {X,Archive,Check,FileCheck2} from '@lucide/svelte';
 import {saveTask,type LocalTask,type TaskDraft,type Stage} from '$lib/control-center/api';
 import {locale} from '$lib/control-center/locale';
 import {workspaces} from '$lib/stores/app';
 import {columns,completionProblem} from '$lib/control-center/model.js';
 import Notice from './Notice.svelte';
 let {task=null,workspaceId='',onclose}:{task?:LocalTask|null;workspaceId?:string;onclose:()=>void}=$props();
 // A new editor is mounted for each selection; edits are intentionally isolated
 // from background store refreshes until revision-checked Save.
 function initialDraft():TaskDraft {
  return {id:task?.id??null,expected_revision:task?.revision??null,workspace_id:task?.workspace_id||workspaceId,
 title:task?.title??'',description:task?.description??'',status:task?.status??'BACKLOG',priority:task?.priority??'normal',
 review_note:task?.review_note??'',verification_note:task?.verification_note??'',archived:task?.archived??false};
 }
 let draft=$state<TaskDraft>(initialDraft());
 let dialog:HTMLDialogElement;let titleInput:HTMLInputElement;let busy=$state(false),error=$state('');
 async function save(archive?:boolean){
  const update={...draft,archived:archive??draft.archived};
  const problem=completionProblem(update);if(problem){error=problem;return;}
  busy=true;error='';try{await saveTask(update);dialog.close();onclose();}catch(e){error=String(e);}finally{busy=false;}
 }
 onMount(()=>{dialog.showModal();titleInput.focus();});
</script>
<dialog bind:this={dialog} class="cc-task-dialog" oncancel={(event)=>{event.preventDefault();if(!busy)onclose();}} aria-labelledby="task-editor-title">
 <form onsubmit={(e)=>{e.preventDefault();void save();}}>
  <header class="cc-dialog-heading"><div><small>{$locale==='en'?'LOCAL PLANNING':'本機規劃'}</small><h2 id="task-editor-title">{task?($locale==='en'?'Task details':'任務詳情'):($locale==='en'?'Create a task':'建立任務')}</h2></div><button type="button" class="cc-icon-button" disabled={busy} aria-label="Close task" onclick={onclose}><X size={20}/></button></header>
  <div class="cc-dialog-content">
   {#if error}<Notice text={error} error/>{/if}
   <label class="cc-field">{$locale==='en'?'Title':'標題'}<input class="cc-input" bind:this={titleInput} bind:value={draft.title} required maxlength="240" placeholder={$locale==='en'?'What needs to happen?':'需要完成甚麼？'}/></label>
   <div class="cc-form-row"><label class="cc-field">{$locale==='en'?'Workspace':'工作區'}<select class="cc-input" bind:value={draft.workspace_id} disabled={Boolean(task)} required><option value="" disabled>{$locale==='en'?'Choose a workspace':'選擇工作區'}</option>{#each $workspaces as w}<option value={w.id}>{w.name}</option>{/each}</select></label><label class="cc-field">{$locale==='en'?'Priority':'優先次序'}<select class="cc-input" bind:value={draft.priority}><option value="low">{$locale==='en'?'Low':'低'}</option><option value="normal">{$locale==='en'?'Normal':'一般'}</option><option value="high">{$locale==='en'?'High':'高'}</option></select></label></div>
   <label class="cc-field">{$locale==='en'?'Specification':'規格'}<textarea class="cc-input" rows="5" maxlength="16384" bind:value={draft.description} placeholder={$locale==='en'?'Describe the outcome, constraints, and acceptance criteria.':'描述成果、限制及驗收條件。'}></textarea></label>
   <label class="cc-field">{$locale==='en'?'Status':'狀態'}<select class="cc-input" bind:value={draft.status}>{#each columns as c}<option value={c.status}>{$locale==='en'?c.label:c.zh}</option>{/each}</select></label>
   <details class="cc-evidence" open={draft.status==='DONE'||draft.status==='REVIEW'}><summary><FileCheck2 size={17}/>{$locale==='en'?'Review & verification notes':'審查及驗證紀錄'}</summary><p class="cc-muted">{$locale==='en'?'Required for Done. These are your notes, not an automated test result or merge approval.':'標記完成前必填。這是你的紀錄，不代表自動測試結果或合併批准。'}</p><label class="cc-field">{$locale==='en'?'Review note':'審查紀錄'}<textarea class="cc-input" rows="2" maxlength="4096" bind:value={draft.review_note}></textarea></label><label class="cc-field">{$locale==='en'?'Verification note':'驗證紀錄'}<textarea class="cc-input" rows="2" maxlength="4096" bind:value={draft.verification_note}></textarea></label></details>
  </div>
  <footer class="cc-dialog-footer">{#if task}<button type="button" class="cc-button" disabled={busy} onclick={()=>save(!draft.archived)}><Archive size={16}/>{draft.archived?($locale==='en'?'Restore':'還原'):($locale==='en'?'Archive':'封存')}</button>{:else}<small>{$locale==='en'?'Creates a local task only. No agent starts.':'只建立本機任務，不會啟動 Agent。'}</small>{/if}<button type="submit" class="cc-button cc-primary" disabled={busy}><Check size={16}/>{busy?($locale==='en'?'Saving…':'儲存中…'):($locale==='en'?'Save task':'儲存任務')}</button></footer>
 </form>
</dialog>
