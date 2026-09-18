<script lang="ts">
 import { onMount } from 'svelte';
 import { Archive, GitBranch, Plus, RefreshCw, ShieldCheck, Trash2 } from '@lucide/svelte';
 import { locale } from '$lib/control-center/state';
 import { translated as t } from '$lib/control-center/model';
 import {
  archiveOrchestrator,
  newOrchestratorProfile,
  orchestratorForEdit,
  readOrchestrators,
  saveOrchestrator,
  type OrchestratorProfile,
  type OrchestratorProfileInput,
  type OrchestratorRegistryView,
  type OrchestratorStage
 } from '$lib/orchestrator-center';
 import { readProviderProfiles, type ProviderProfile, type ProviderRegistryView } from '$lib/provider-center';

 let providers=$state<ProviderRegistryView|null>(null);
 let registry=$state<OrchestratorRegistryView|null>(null);
 let draft=$state<OrchestratorProfileInput|null>(null);
 let selected=$state('');
 let busy=$state(false);
 let error=$state('');
 let notice=$state('');

 let annealProviders=$derived((providers?.profiles??[]).filter(profile=>profile.enabled&&profile.anneal_enabled));
 let selectedProfile=$derived(registry?.profiles.find(profile=>profile.id===selected));
 let resolved=$derived(registry?.resolved.find(profile=>profile.id===selected));

 function provider(profileId:string):ProviderProfile|undefined{return annealProviders.find(row=>row.id===profileId);}
 function modelOptions(stage:OrchestratorStage){return provider(stage.provider_profile_id)?.models??[];}
 function beginNew(){const first=annealProviders[0]?.id??'';draft=newOrchestratorProfile(first);selected='';error='';notice='';}
 function beginEdit(profile:OrchestratorProfile){draft=orchestratorForEdit(profile);selected=profile.id;error='';notice='';}
 function addStage(){
  if(!draft||draft.stages.length>=32)return;
  const index=draft.stages.length+1;
  draft.stages=[...draft.stages,{
   id:`stage-${index}`,name:`Stage ${index}`,role:`stage-${index}`,provider_profile_id:annealProviders[0]?.id??'',model:annealProviders[0]?.models[0]??'',fallback_provider_ids:[],instructions:'',anneal_agent_id:null,parallel_group:draft.execution_mode==='parallel_groups'?index:null,approval_gate:false,optional:false,opens_pull_request:false,requires_commit:true,output_kind:`stage-${index}`
  }];
 }
 function removeStage(index:number){if(!draft||draft.stages.length<=1)return;draft.stages=draft.stages.filter((_,position)=>position!==index);}
 function setStageProvider(stage:OrchestratorStage,id:string){stage.provider_profile_id=id;stage.model=provider(id)?.models[0]??'';stage.fallback_provider_ids=stage.fallback_provider_ids.filter(item=>item!==id);}
 function toggleFallback(stage:OrchestratorStage,id:string){stage.fallback_provider_ids=stage.fallback_provider_ids.includes(id)?stage.fallback_provider_ids.filter(item=>item!==id):[...stage.fallback_provider_ids,id];}
 function setNullable(stage:OrchestratorStage,key:'anneal_agent_id',value:string){stage[key]=value.trim()?value:null;}
 function setParallel(stage:OrchestratorStage,value:string){stage.parallel_group=value.trim()?Number(value):null;}
 async function refresh(){busy=true;error='';try{[providers,registry]=await Promise.all([readProviderProfiles(),readOrchestrators()]);}catch(e){error=String(e);}finally{busy=false;}}
 async function save(){
  if(!registry||!draft)return;
  busy=true;error='';notice='';
  try{
   registry=await saveOrchestrator(registry.revision,draft);
   const saved=registry.profiles.find(profile=>profile.name===draft?.name&&profile.project_id===draft?.project_id);
   selected=saved?.id??selected;draft=null;
   notice=t($locale,'Structured orchestrator saved. No Anneal task was started.','已儲存結構化編排器，未有啟動 Anneal 任務。');
  }catch(e){error=String(e);}finally{busy=false;}
 }
 async function archive(profile:OrchestratorProfile){busy=true;error='';try{registry=await archiveOrchestrator(profile.id);selected='';draft=null;}catch(e){error=String(e);}finally{busy=false;}}
 onMount(()=>{void refresh();});
</script>

<section class="cc-page orchestrator-page">
 <header class="cc-page-heading"><div><h1><GitBranch size={20}/>{t($locale,'Anneal orchestrators','Anneal 編排器')}</h1><p>{t($locale,'Build ordered stages with explicit providers, models, fallback routes and approval gates.','建立有明確供應商、模型、後備路線同審批閘門嘅有序階段。')}</p></div><div class="header-actions"><button class="cc-button secondary" disabled={busy} onclick={refresh}><RefreshCw size={15}/>{t($locale,'Refresh','重新整理')}</button><button class="cc-button primary" disabled={busy||!annealProviders.length} onclick={beginNew}><Plus size={15}/>{t($locale,'New orchestrator','新增編排器')}</button></div></header>
 <p class="cc-notice amber"><ShieldCheck size={16}/>{t($locale,'Orchestrators map to Anneal templates and explicit agent assignments. Saving a profile never starts a task.','編排器會映射到 Anneal 模板同明確 Agent 指派；儲存設定唔會啟動任務。')}</p>
 {#if error}<p class="cc-notice red" role="alert">{error}</p>{/if}{#if notice}<p class="cc-notice" role="status">{notice}</p>{/if}

 <div class="layout">
  <aside class="cc-panel list-panel">
   <h2>{t($locale,'Profiles','設定')}</h2>
   {#each registry?.profiles??[] as profile}
    <button class:active={selected===profile.id} class="profile-choice" onclick={()=>{selected=profile.id;draft=null;}}><strong>{profile.name}</strong><span>{profile.project_id} · {profile.stages.length} {t($locale,'stages','個階段')}</span></button>
   {/each}
   {#if !(registry?.profiles.length)}<p class="empty">{t($locale,'No orchestrator profile yet.','暫時未有編排器設定。')}</p>{/if}
  </aside>

  <main>
   {#if selectedProfile&&!draft}
    <section class="cc-panel summary-panel">
     <div class="section-heading"><div><h2>{selectedProfile.name}</h2><p>{selectedProfile.project_id} · {selectedProfile.repo_id}</p></div><div class="header-actions"><button class="cc-button secondary" onclick={()=>beginEdit(selectedProfile)}>{t($locale,'Edit','編輯')}</button><button class="cc-button ghost" onclick={()=>void archive(selectedProfile)}><Archive size={14}/>{t($locale,'Archive','封存')}</button></div></div>
     <dl><div><dt>{t($locale,'Template','模板')}</dt><dd>{selectedProfile.template_id??'—'}</dd></div><div><dt>{t($locale,'Staffing profile','人員配置')}</dt><dd>{selectedProfile.staffing_profile_id??'—'}</dd></div><div><dt>{t($locale,'Execution','執行')}</dt><dd>{selectedProfile.execution_mode} · {selectedProfile.max_concurrency}</dd></div><div><dt>{t($locale,'Retry / duration','重試／時間')}</dt><dd>{selectedProfile.retry_limit} · {selectedProfile.max_duration_min} min</dd></div></dl>
     <div class="stage-summary">{#each resolved?.stages??[] as stage}<article><strong>{stage.name}</strong><span>{stage.provider_name??stage.provider_profile_id} / {stage.model||'—'}</span><small>{stage.role} · {stage.output_kind} · {stage.anneal_agent_id??t($locale,'agent not assigned','未指派 Agent')}</small></article>{/each}</div>
     <p class:ready={resolved?.runnable} class="runnable">{resolved?.runnable?t($locale,'Ready to attach to an Anneal task.','可以附加到 Anneal 任務。'):t($locale,'Select a template and assign every stage to an Anneal agent before running.','執行前要選擇模板，並為每個階段指派 Anneal Agent。')}</p>
    </section>
   {/if}

   {#if draft}
    <section class="cc-panel editor">
     <div class="section-heading"><div><h2>{draft.id?t($locale,'Edit structured orchestrator','編輯結構化編排器'):t($locale,'New structured orchestrator','新增結構化編排器')}</h2><p>{t($locale,'Plan A stage editor','方案 A 階段編輯器')}</p></div><button class="cc-button ghost" onclick={()=>draft=null}>{t($locale,'Close','關閉')}</button></div>
     <form onsubmit={event=>{event.preventDefault();void save();}}>
      <div class="form-grid">
       <label>{t($locale,'Name','名稱')}<input bind:value={draft.name} required maxlength="200"/></label>
       <label>Anneal project ID<input bind:value={draft.project_id} required maxlength="128"/></label>
       <label>Anneal repository ID<input bind:value={draft.repo_id} required maxlength="128"/></label>
       <label>Anneal template ID<input value={draft.template_id??''} oninput={event=>draft!.template_id=event.currentTarget.value.trim()||null} maxlength="128"/></label>
       <label>Staffing profile ID<input value={draft.staffing_profile_id??''} oninput={event=>draft!.staffing_profile_id=event.currentTarget.value.trim()||null} maxlength="128"/></label>
       <label>Environment ID<input value={draft.environment_id??''} oninput={event=>draft!.environment_id=event.currentTarget.value.trim()||null} maxlength="128"/></label>
       <label>{t($locale,'Execution mode','執行模式')}<select bind:value={draft.execution_mode} onchange={()=>{if(draft?.execution_mode==='sequential')draft.stages.forEach(stage=>stage.parallel_group=null);}}><option value="sequential">Sequential</option><option value="parallel_groups">Parallel groups</option></select></label>
       <label>{t($locale,'Maximum concurrency','最大並行數')}<input type="number" min="1" max="32" bind:value={draft.max_concurrency}/></label>
       <label>{t($locale,'Retry limit','重試上限')}<input type="number" min="0" max="10" bind:value={draft.retry_limit}/></label>
       <label>{t($locale,'Duration budget (minutes)','時間預算（分鐘）')}<input type="number" min="1" max="1440" bind:value={draft.max_duration_min}/></label>
      </div>
      <label class="check"><input type="checkbox" bind:checked={draft.approval_required}/>{t($locale,'Require operator approval for the orchestrated run','編排執行前需要操作員批准')}</label>

      <div class="stage-heading"><h3>{t($locale,'Stages','階段')}</h3><button type="button" class="cc-button secondary" disabled={draft.stages.length>=32} onclick={addStage}><Plus size={14}/>{t($locale,'Add stage','新增階段')}</button></div>
      <div class="stages">
       {#each draft.stages as stage,index}
        <article class="stage-card">
         <div class="stage-title"><strong>{index+1}. {stage.name}</strong><button type="button" class="cc-button ghost" disabled={draft.stages.length<=1} onclick={()=>removeStage(index)}><Trash2 size={14}/>{t($locale,'Remove','移除')}</button></div>
         <div class="form-grid">
          <label>{t($locale,'Stage name','階段名稱')}<input bind:value={stage.name} required maxlength="200"/></label>
          <label>{t($locale,'Role','角色')}<input bind:value={stage.role} required maxlength="128"/></label>
          <label>{t($locale,'Provider','供應商')}<select value={stage.provider_profile_id} onchange={event=>setStageProvider(stage,event.currentTarget.value)} required><option value="">—</option>{#each annealProviders as row}<option value={row.id}>{row.name}</option>{/each}</select></label>
          <label>{t($locale,'Model','模型')}{#if modelOptions(stage).length}<select bind:value={stage.model} required><option value="">—</option>{#each modelOptions(stage) as model}<option value={model}>{model}</option>{/each}</select>{:else}<input bind:value={stage.model} required maxlength="256" placeholder={t($locale,'Enter exact model ID','輸入精確模型 ID')}/>{/if}</label>
          <label>Anneal agent ID<input value={stage.anneal_agent_id??''} oninput={event=>setNullable(stage,'anneal_agent_id',event.currentTarget.value)} maxlength="128"/></label>
          <label>{t($locale,'Output kind','輸出類型')}<input bind:value={stage.output_kind} required maxlength="200"/></label>
          {#if draft.execution_mode==='parallel_groups'}<label>{t($locale,'Parallel group','並行群組')}<input type="number" min="0" max="32" value={stage.parallel_group??''} oninput={event=>setParallel(stage,event.currentTarget.value)}/></label>{/if}
         </div>
         <label>{t($locale,'Instructions','指令')}<textarea rows="3" bind:value={stage.instructions} maxlength="32768"></textarea></label>
         <fieldset><legend>{t($locale,'Fallback providers','後備供應商')}</legend><div class="fallbacks">{#each annealProviders.filter(row=>row.id!==stage.provider_profile_id) as row}<label><input type="checkbox" checked={stage.fallback_provider_ids.includes(row.id)} onchange={()=>toggleFallback(stage,row.id)}/>{row.name}</label>{/each}</div></fieldset>
         <div class="checks"><label><input type="checkbox" bind:checked={stage.approval_gate}/>{t($locale,'Approval gate','審批閘門')}</label><label><input type="checkbox" bind:checked={stage.optional}/>{t($locale,'Optional','可選')}</label><label><input type="checkbox" bind:checked={stage.opens_pull_request}/>{t($locale,'Opens pull request','建立 Pull Request')}</label><label><input type="checkbox" bind:checked={stage.requires_commit}/>{t($locale,'Requires commit','需要 Commit')}</label></div>
        </article>
       {/each}
      </div>
      <div class="header-actions"><button class="cc-button primary" disabled={busy||!draft.stages.length}>{t($locale,'Save orchestrator','儲存編排器')}</button></div>
     </form>
    </section>
   {/if}

   {#if !selectedProfile&&!draft}<section class="cc-panel empty-main"><GitBranch size={32}/><h2>{t($locale,'Select or create an orchestrator','選擇或新增編排器')}</h2><p>{t($locale,'Each stage can use a different provider and explicit fallback chain.','每個階段都可以使用唔同供應商同明確後備鏈。')}</p></section>{/if}
  </main>
 </div>
</section>

<style>
.orchestrator-page{max-width:1750px}.orchestrator-page h1,.header-actions,.section-heading,.stage-heading,.stage-title{display:flex;align-items:center;gap:.6rem}.header-actions{flex-wrap:wrap}.layout{display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:1rem}.list-panel,.summary-panel,.editor,.empty-main{padding:1.2rem}.profile-choice{display:flex;flex-direction:column;gap:.3rem;width:100%;text-align:left;padding:.8rem;border:1px solid transparent;border-radius:10px;background:transparent;color:inherit}.profile-choice:hover,.profile-choice.active{border-color:var(--border);background:var(--card-bg)}.profile-choice span,.empty{font-size:.78rem;color:var(--muted)}.section-heading,.stage-heading,.stage-title{justify-content:space-between;align-items:flex-start}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.form-grid label,.stage-card>label{display:flex;flex-direction:column;gap:.4rem}.editor input,.editor select,.editor textarea{padding:.55rem;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);color:inherit;min-width:0}.check,.checks,.fallbacks{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center}.check{margin:1rem 0}.stages{display:flex;flex-direction:column;gap:1rem}.stage-card{border:1px solid var(--border);border-radius:12px;padding:1rem}.stage-card fieldset{border:0;padding:0;margin:.8rem 0}.stage-card textarea{width:100%;box-sizing:border-box}.stage-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}.stage-summary article{display:flex;flex-direction:column;gap:.25rem;border:1px solid var(--border);border-radius:10px;padding:.8rem}.stage-summary span,.stage-summary small{overflow-wrap:anywhere}.runnable{padding:.7rem;border-left:3px solid var(--border)}.runnable.ready{border-color:#16a34a}.summary-panel dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}.summary-panel dt{font-size:.72rem;color:var(--muted)}.summary-panel dd{margin:0;overflow-wrap:anywhere}.empty-main{text-align:center;padding:4rem 1rem}@media(max-width:950px){.layout{grid-template-columns:1fr}.list-panel{display:flex;gap:.5rem;overflow:auto}.list-panel h2,.list-panel .empty{display:none}.profile-choice{min-width:200px}.form-grid,.stage-summary{grid-template-columns:1fr}}@media(max-width:650px){.section-heading,.stage-heading,.stage-title{flex-direction:column}.header-actions{width:100%}}
</style>
