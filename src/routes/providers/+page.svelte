<script lang="ts">
 import { onMount } from 'svelte';
 import { Cpu, KeyRound, Plug, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from '@lucide/svelte';
 import { locale } from '$lib/control-center/state';
 import { translated as t } from '$lib/control-center/model';
 import {
  PROVIDER_CAPABILITIES,
  archiveProviderProfile,
  connectProviderProfile,
  disableProviderProfile,
  profileForEdit,
  profileFromTemplate,
  probeProviderProfile,
  readProviderProfiles,
  saveProviderProfile,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderProfile,
  type ProviderProfileInput,
  type ProviderRegistryView
 } from '$lib/provider-center';

 let registry=$state<ProviderRegistryView|null>(null);
 let draft=$state<ProviderProfileInput|null>(null);
 let credential=$state('');
 let filter=$state('');
 let busy=$state(false);
 let error=$state('');
 let notice=$state('');

 let visibleProfiles=$derived((registry?.profiles??[]).filter(profile=>
  `${profile.name} ${profile.category} ${profile.auth} ${profile.protocol}`.toLowerCase().includes(filter.toLowerCase())
 ));

 function health(profileId:string):ProviderHealth|undefined{return registry?.health.find(row=>row.provider_id===profileId);}
 function when(value:number|null|undefined){return value?new Date(value).toLocaleString():'—';}
 function label(value:string){return value.replaceAll('_',' ');}
 function beginTemplate(template:ProviderProfile){draft=profileFromTemplate(template);credential='';error='';notice='';}
 function beginEdit(profile:ProviderProfile){draft=profileForEdit(profile);credential='';error='';notice='';}
 function has(capability:ProviderCapability){return draft?.capabilities.includes(capability)??false;}
 function toggle(capability:ProviderCapability){
  if(!draft)return;
  draft.capabilities=has(capability)?draft.capabilities.filter(item=>item!==capability):[...draft.capabilities,capability];
  if(capability==='image_generation'&&!draft.capabilities.includes(capability))draft.image_enabled=false;
 }
 async function refresh(){busy=true;error='';try{registry=await readProviderProfiles();}catch(e){error=String(e);}finally{busy=false;}}
 async function save(){
  if(!registry||!draft)return;
  busy=true;error='';notice='';
  try{
   registry=await saveProviderProfile(registry.revision,draft,credential);
   credential='';draft=null;
   notice=t($locale,'Provider profile saved. Credentials remain in memory only.','已儲存供應商設定；憑證只保留喺記憶體。');
  }catch(e){error=String(e);}finally{busy=false;}
 }
 async function connect(profile:ProviderProfile){
  busy=true;error='';notice='';
  try{
   registry=await connectProviderProfile(profile.id,credential);
   credential='';
   notice=t($locale,'Provider authentication attached for this app session.','已為今次應用程式工作階段附加供應商認證。');
  }catch(e){error=String(e);}finally{busy=false;}
 }
 async function probe(profile:ProviderProfile,discoverModels:boolean){
  busy=true;error='';notice='';
  try{
   registry=await probeProviderProfile(profile.id,discoverModels);
   notice=discoverModels?t($locale,'Model catalogue refreshed.','模型目錄已更新。'):t($locale,'Provider health checked.','供應商健康狀態已檢查。');
  }catch(e){error=String(e);}finally{busy=false;}
 }
 async function disable(profile:ProviderProfile){busy=true;error='';try{registry=await disableProviderProfile(profile.id);}catch(e){error=String(e);}finally{busy=false;}}
 async function archive(profile:ProviderProfile){busy=true;error='';try{registry=await archiveProviderProfile(profile.id);}catch(e){error=String(e);}finally{busy=false;}}
 onMount(()=>{void refresh();});
</script>

<section class="cc-page providers-page">
 <header class="cc-page-heading">
  <div><h1><Cpu size={20}/>{t($locale,'Providers','供應商')}</h1><p>{t($locale,'Manage API keys, OAuth accounts, browser sessions and reverse proxies in one place.','集中管理 API Key、OAuth 帳戶、瀏覽器工作階段同反向代理。')}</p></div>
  <button class="cc-button secondary" disabled={busy} onclick={refresh}><RefreshCw size={15}/>{t($locale,'Refresh','重新整理')}</button>
 </header>
 <p class="cc-notice amber"><ShieldCheck size={16}/>{t($locale,'Secrets are never written into provider profiles. API keys and session credentials stay in RAM for the current app session.','秘密資料唔會寫入供應商設定；API Key 同工作階段憑證只會喺今次應用程式工作階段記憶體內保留。')}</p>
 {#if error}<p class="cc-notice red" role="alert">{error}</p>{/if}
 {#if notice}<p class="cc-notice" role="status">{notice}</p>{/if}

 {#if registry}
 <section class="cc-panel preset-panel">
  <div class="section-heading"><div><h2>{t($locale,'Add provider','新增供應商')}</h2><p>{t($locale,'Create more than one instance from any preset.','每個預設都可以建立多個獨立實例。')}</p></div></div>
  <div class="preset-grid">
   {#each registry.templates as template}
    <button class="preset" onclick={()=>beginTemplate(template)}>
     <strong>{template.name}</strong><span>{label(template.category)} · {label(template.auth)}</span>
     <small>{template.capabilities.map(label).join(' · ')}</small>
    </button>
   {/each}
  </div>
 </section>

 <section class="cc-panel profile-panel">
  <div class="section-heading"><div><h2>{t($locale,'Configured providers','已設定供應商')}</h2><p>{registry.profiles.length} {t($locale,'profiles retained','個設定已保留')}</p></div><label class="search"><Search size={15}/><input bind:value={filter} placeholder={t($locale,'Filter providers','篩選供應商')}/></label></div>
  <div class="provider-grid">
   {#each visibleProfiles as profile}
    {@const state=health(profile.id)}
    <article class="provider-card">
     <div class="card-top"><div><h3>{profile.name}</h3><p>{label(profile.category)} · {label(profile.auth)} · {label(profile.protocol)}</p></div><span class:ready={state?.status==='ready'} class:error={state?.status==='error'} class="status">{label(state?.status??'unknown')}</span></div>
     <div class="capabilities">{#each profile.capabilities as capability}<span>{label(capability)}</span>{/each}</div>
     <dl><div><dt>{t($locale,'Endpoint','端點')}</dt><dd>{profile.base_url??t($locale,'Managed externally','由外部管理')}</dd></div><div><dt>{t($locale,'Models','模型')}</dt><dd>{state?.models.length??profile.models.length}</dd></div><div><dt>{t($locale,'Latency','延遲')}</dt><dd>{state?.latency_ms==null?'—':`${state.latency_ms} ms`}</dd></div><div><dt>{t($locale,'Last check','上次檢查')}</dt><dd>{when(state?.checked_at)}</dd></div></dl>
     <p class="engines">{profile.paseo_enabled?'Paseo ':''}{profile.anneal_enabled?'Anneal ':''}{profile.direct_enabled?'Direct ':''}{profile.image_enabled?'Image':''}</p>
     {#if state?.error}<p class="card-error">{state.error}</p>{/if}
     <div class="actions">
      <button class="cc-button secondary" disabled={busy} onclick={()=>beginEdit(profile)}>{t($locale,'Edit','編輯')}</button>
      <button class="cc-button secondary" disabled={busy} onclick={()=>void probe(profile,false)}><Plug size={14}/>{t($locale,'Test','測試')}</button>
      <button class="cc-button ghost" disabled={busy||!profile.base_url} onclick={()=>void probe(profile,true)}><RefreshCw size={14}/>{t($locale,'Models','模型')}</button>
      <button class="cc-button ghost" disabled={busy} onclick={()=>void connect(profile)}><KeyRound size={14}/>{t($locale,'Attach auth','附加認證')}</button>
      <button class="cc-button ghost" disabled={busy||!profile.enabled} onclick={()=>void disable(profile)}>{t($locale,'Disable','停用')}</button>
      <button class="cc-button ghost" disabled={busy} onclick={()=>void archive(profile)}><Trash2 size={14}/>{t($locale,'Archive','封存')}</button>
     </div>
    </article>
   {/each}
   {#if !visibleProfiles.length}<p class="empty">{t($locale,'No configured provider matches this filter.','冇已設定供應商符合篩選條件。')}</p>{/if}
  </div>
 </section>
 {/if}

 {#if draft}
 <section class="cc-panel editor">
  <div class="section-heading"><div><h2>{draft.id?t($locale,'Edit provider profile','編輯供應商設定'):t($locale,'New provider profile','新增供應商設定')}</h2><p>{draft.template_id}</p></div><button class="cc-button ghost" onclick={()=>{draft=null;credential='';}}>{t($locale,'Close','關閉')}</button></div>
  <form onsubmit={event=>{event.preventDefault();void save();}}>
   <div class="form-grid">
    <label>{t($locale,'Display name','顯示名稱')}<input bind:value={draft.name} maxlength="120" required/></label>
    <label>{t($locale,'Base URL','Base URL')}<input bind:value={draft.base_url} placeholder="https://… or http://127.0.0.1:…" maxlength="2048"/></label>
    <label>{t($locale,'Models endpoint','模型端點')}<input bind:value={draft.models_endpoint} placeholder="/models" maxlength="256"/></label>
    <label>{t($locale,'Priority','優先次序')}<input type="number" min="0" max="10000" bind:value={draft.priority}/></label>
    <label>{t($locale,'Authentication','認證方式')}<select bind:value={draft.auth}><option value="api_key">API key</option><option value="oauth">OAuth</option><option value="browser_session">Browser session</option><option value="local_proxy">Local proxy</option><option value="none">None</option></select></label>
    <label>{t($locale,'Protocol','協定')}<select bind:value={draft.protocol}><option value="open_ai_chat">OpenAI Chat</option><option value="open_ai_responses">OpenAI Responses</option><option value="anthropic_messages">Anthropic Messages</option><option value="gemini_native">Gemini Native</option><option value="image_api">Image API</option></select></label>
   </div>
   <fieldset><legend>{t($locale,'Capabilities','能力')}</legend><div class="checks">{#each PROVIDER_CAPABILITIES as capability}<label><input type="checkbox" checked={has(capability)} onchange={()=>toggle(capability)}/>{label(capability)}</label>{/each}</div></fieldset>
   <fieldset><legend>{t($locale,'Allowed uses','允許用途')}</legend><div class="checks"><label><input type="checkbox" bind:checked={draft.paseo_enabled}/>Paseo</label><label><input type="checkbox" bind:checked={draft.anneal_enabled}/>Anneal</label><label><input type="checkbox" bind:checked={draft.direct_enabled}/>{t($locale,'Direct model routing','直接模型選路')}</label><label><input type="checkbox" bind:checked={draft.image_enabled} disabled={!has('image_generation')}/>{t($locale,'Image generation','生成圖片')}</label><label><input type="checkbox" bind:checked={draft.enabled}/>{t($locale,'Enabled','啟用')}</label></div></fieldset>
   <label>{t($locale,'Credential or session token (RAM only)','憑證或工作階段 Token（只存記憶體）')}<input type="password" bind:value={credential} autocomplete="off" maxlength="8192"/></label>
   <div class="actions"><button class="cc-button primary" disabled={busy||!draft.capabilities.length}><Plus size={14}/>{t($locale,'Save provider','儲存供應商')}</button></div>
  </form>
 </section>
 {/if}
</section>

<style>
.providers-page{max-width:1700px}.providers-page h1,.section-heading,.card-top{display:flex;align-items:center;gap:.6rem}.section-heading,.card-top{justify-content:space-between;align-items:flex-start}.preset-panel,.profile-panel,.editor{padding:1.2rem;margin-top:1rem}.preset-grid,.provider-grid{display:grid;grid-template-columns:repeat(3,minmax(250px,1fr));gap:1rem}.preset{display:flex;flex-direction:column;gap:.35rem;text-align:left;padding:1rem;border:1px solid var(--border);border-radius:12px;background:transparent;color:inherit}.preset:hover{border-color:var(--accent)}.provider-card{border:1px solid var(--border);border-radius:12px;padding:1rem;background:var(--card-bg)}.provider-card h3{margin:0}.provider-card p{margin:.25rem 0;color:var(--muted)}.status{padding:.25rem .55rem;border:1px solid var(--border);border-radius:999px;font-size:.72rem}.status.ready{border-color:#16a34a}.status.error,.card-error{color:#dc2626}.capabilities,.checks,.actions{display:flex;gap:.5rem;flex-wrap:wrap}.capabilities{margin:.8rem 0}.capabilities span{font-size:.72rem;padding:.2rem .45rem;border-radius:999px;border:1px solid var(--border)}dl{display:grid;grid-template-columns:1fr 1fr;gap:.55rem;margin:.8rem 0}dl div{min-width:0}dt{font-size:.7rem;color:var(--muted)}dd{font-size:.78rem;margin:0;overflow-wrap:anywhere}.engines{font-size:.75rem}.actions{margin-top:1rem}.search{display:flex;align-items:center;gap:.4rem}.search input,.editor input,.editor select{padding:.55rem;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);color:inherit;min-width:0}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.form-grid label,.editor>form>label{display:flex;flex-direction:column;gap:.4rem}.editor fieldset{border:0;padding:0;margin:1rem 0}.checks label{display:flex;gap:.35rem;align-items:center}.empty{grid-column:1/-1}@media(max-width:1000px){.preset-grid,.provider-grid{grid-template-columns:repeat(2,minmax(220px,1fr))}}@media(max-width:700px){.preset-grid,.provider-grid,.form-grid{grid-template-columns:1fr}.section-heading{flex-direction:column}.search{width:100%}.search input{width:100%}}
</style>
