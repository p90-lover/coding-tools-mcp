<script lang="ts">
 import { onMount } from 'svelte';
 import { GitBranch, Play, RefreshCw, ShieldCheck } from '@lucide/svelte';
 import { locale } from '$lib/control-center/state';
 import { translated as t } from '$lib/control-center/model';
 import {
  readOrchestrators,
  runAnnealOrchestrator,
  type AnnealOrchestratorRunResult,
  type OrchestratorRegistryView
 } from '$lib/orchestrator-center';

 let registry=$state<OrchestratorRegistryView|null>(null);
 let selected=$state('');
 let endpoint=$state('http://127.0.0.1:3000/');
 let operatorToken=$state('');
 let taskName=$state('');
 let description=$state('');
 let branchName=$state('coding-tools/orchestrated-task');
 let autoStart=$state(false);
 let approved=$state(false);
 let result=$state<AnnealOrchestratorRunResult|null>(null);
 let busy=$state(false);
 let error=$state('');

 let profile=$derived(registry?.profiles.find(row=>row.id===selected));
 let resolved=$derived(registry?.resolved.find(row=>row.id===selected));
 let runnable=$derived(Boolean(profile&&resolved?.runnable&&approved&&operatorToken.trim()&&taskName.trim()&&branchName.trim()));

 async function refresh(){
  busy=true;error='';
  try{
   registry=await readOrchestrators();
   if(!selected){selected=registry.profiles.find(row=>registry?.resolved.find(item=>item.id===row.id)?.runnable)?.id??registry.profiles[0]?.id??'';}
  }catch(e){error=String(e);}finally{busy=false;}
 }

 async function run(){
  if(!profile||!runnable)return;
  busy=true;error='';result=null;
  try{
   result=await runAnnealOrchestrator({
    profile_id:profile.id,
    endpoint,
    operator_token:operatorToken,
    name:taskName,
    description,
    branch_name:branchName,
    auto_start:autoStart
   });
   operatorToken='';approved=false;
  }catch(e){error=String(e);}finally{busy=false;}
 }

 onMount(()=>{void refresh();});
</script>

<section class="cc-page run-page">
 <header class="cc-page-heading">
  <div><h1><GitBranch size={20}/>{t($locale,'Run Anneal orchestrator','執行 Anneal 編排器')}</h1><p>{t($locale,'Instantiate an approved structured profile as a native Anneal template run.','將已批准嘅結構化設定實例化為原生 Anneal 模板執行。')}</p></div>
  <button class="cc-button secondary" disabled={busy} onclick={refresh}><RefreshCw size={15}/>{t($locale,'Refresh profiles','重新整理設定')}</button>
 </header>
 <p class="cc-notice amber"><ShieldCheck size={16}/>{t($locale,'This sends one external Anneal mutation. Uncertain results are not retried automatically. The operator token stays in RAM only.','呢個操作只會發送一次外部 Anneal 變更；結果不確定時唔會自動重試。操作員 Token 只會留喺記憶體。')}</p>
 {#if error}<p class="cc-notice red" role="alert">{error}</p>{/if}

 <div class="run-layout">
  <section class="cc-panel run-form">
   <h2>{t($locale,'Task launch','任務啟動')}</h2>
   <form onsubmit={event=>{event.preventDefault();void run();}}>
    <label>{t($locale,'Orchestrator profile','編排器設定')}<select bind:value={selected} required><option value="">—</option>{#each registry?.profiles??[] as row}<option value={row.id}>{row.name}</option>{/each}</select></label>
    <label>{t($locale,'Anneal endpoint','Anneal 端點')}<input bind:value={endpoint} required maxlength="512"/></label>
    <label>{t($locale,'Anneal operator token (RAM only)','Anneal 操作員 Token（只存記憶體）')}<input type="password" bind:value={operatorToken} autocomplete="off" required maxlength="8192"/></label>
    <label>{t($locale,'Task name','任務名稱')}<input bind:value={taskName} required maxlength="200"/></label>
    <label>{t($locale,'Target branch','目標分支')}<input bind:value={branchName} required maxlength="240"/></label>
    <label>{t($locale,'Description','說明')}<textarea rows="6" bind:value={description} maxlength="32768"></textarea></label>
    <label class="check"><input type="checkbox" bind:checked={autoStart}/>{t($locale,'Start the materialized chain immediately','立即啟動已實例化嘅工作鏈')}</label>
    <label class="check"><input type="checkbox" bind:checked={approved}/>{t($locale,'I approve this external Anneal run and its provider costs.','我批准今次外部 Anneal 執行同相關供應商費用。')}</label>
    <button class="cc-button primary" disabled={busy||!runnable}><Play size={15}/>{t($locale,'Instantiate orchestrator','實例化編排器')}</button>
   </form>
  </section>

  <section class="cc-panel preview">
   <h2>{t($locale,'Resolved plan','已解析計劃')}</h2>
   {#if profile}
    <dl><div><dt>{t($locale,'Project','專案')}</dt><dd>{profile.project_id}</dd></div><div><dt>{t($locale,'Repository','儲存庫')}</dt><dd>{profile.repo_id}</dd></div><div><dt>{t($locale,'Template','模板')}</dt><dd>{profile.template_id??'—'}</dd></div><div><dt>{t($locale,'Staffing','人員配置')}</dt><dd>{profile.staffing_profile_id??'—'}</dd></div></dl>
    <div class="stages">{#each resolved?.stages??[] as stage}<article><strong>{stage.name}</strong><span>{stage.provider_name??stage.provider_profile_id} / {stage.model||'—'}</span><small>{stage.anneal_agent_id??t($locale,'Anneal agent missing','未設定 Anneal Agent')}</small></article>{/each}</div>
    <p class:ready={resolved?.runnable} class="runnable">{resolved?.runnable?t($locale,'Profile is runnable.','設定可以執行。'):t($locale,'The profile needs a template and an Anneal agent for every stage.','設定需要模板，亦要為每個階段指定 Anneal Agent。')}</p>
   {:else}<p>{t($locale,'Select an orchestrator profile.','請選擇編排器設定。')}</p>{/if}
   {#if result}<h3>{t($locale,'Anneal response','Anneal 回應')}</h3><pre>{JSON.stringify(result,null,2)}</pre>{/if}
  </section>
 </div>
</section>

<style>
.run-page{max-width:1450px}.run-page h1{display:flex;align-items:center;gap:.6rem}.run-layout{display:grid;grid-template-columns:minmax(320px,480px) minmax(0,1fr);gap:1rem}.run-form,.preview{padding:1.2rem}.run-form form{display:flex;flex-direction:column;gap:1rem}.run-form label:not(.check){display:flex;flex-direction:column;gap:.4rem}.run-form input,.run-form select,.run-form textarea{padding:.6rem;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);color:inherit}.check{display:flex;align-items:flex-start;gap:.5rem}.preview dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}.preview dt{font-size:.72rem;color:var(--muted)}.preview dd{margin:0;overflow-wrap:anywhere}.stages{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}.stages article{display:flex;flex-direction:column;gap:.25rem;padding:.8rem;border:1px solid var(--border);border-radius:10px}.runnable{padding:.7rem;border-left:3px solid var(--border)}.runnable.ready{border-color:#16a34a}.preview pre{max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.75rem}@media(max-width:900px){.run-layout{grid-template-columns:1fr}.stages,.preview dl{grid-template-columns:1fr}}
</style>
