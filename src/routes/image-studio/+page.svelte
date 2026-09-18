<script lang="ts">
 import { onMount } from 'svelte';
 import { convertFileSrc } from '@tauri-apps/api/core';
 import { Image, RefreshCw, ShieldCheck, Sparkles } from '@lucide/svelte';
 import { locale } from '$lib/control-center/state';
 import { translated as t } from '$lib/control-center/model';
 import { workspaces } from '$lib/stores/app';
 import { readProviderProfiles, type ProviderProfile, type ProviderRegistryView } from '$lib/provider-center';
 import {
  generateProviderImage,
  type ImageGenerationResult,
  type ImageGenerationTarget
 } from '$lib/provider-media';

 let registry=$state<ProviderRegistryView|null>(null);
 let workspaceId=$state('');
 let providerId=$state('');
 let target=$state<ImageGenerationTarget>('paseo');
 let model=$state('');
 let prompt=$state('');
 let negativePrompt=$state('');
 let size=$state('1024x1024');
 let aspectRatio=$state('1:1');
 let count=$state(1);
 let credential=$state('');
 let approved=$state(false);
 let result=$state<ImageGenerationResult|null>(null);
 let busy=$state(false);
 let error=$state('');

 let imageProviders=$derived((registry?.profiles??[]).filter(profile=>
  profile.enabled&&profile.image_enabled&&profile.capabilities.includes('image_generation')&&allowedForTarget(profile,target)
 ));
 let selectedProvider=$derived(imageProviders.find(profile=>profile.id===providerId));
 let models=$derived(selectedProvider?.models??[]);
 let canGenerate=$derived(Boolean(workspaceId&&selectedProvider&&model.trim()&&prompt.trim()&&approved&&!busy));

 function allowedForTarget(profile:ProviderProfile,value:ImageGenerationTarget){
  if(value==='paseo')return profile.paseo_enabled;
  if(value==='anneal')return profile.anneal_enabled;
  return profile.direct_enabled;
 }
 function selectProvider(id:string){providerId=id;model=imageProviders.find(profile=>profile.id===id)?.models[0]??'';}
 async function refresh(){
  busy=true;error='';
  try{
   registry=await readProviderProfiles();
   if(!workspaceId&&$workspaces.length)workspaceId=$workspaces[0].id;
   if(!providerId||!imageProviders.some(profile=>profile.id===providerId))selectProvider(imageProviders[0]?.id??'');
  }catch(e){error=String(e);}finally{busy=false;}
 }
 async function generate(){
  if(!canGenerate)return;
  busy=true;error='';result=null;
  try{
   result=await generateProviderImage({
    workspace_id:workspaceId,
    provider_profile_id:providerId,
    credential,
    target,
    model,
    prompt,
    negative_prompt:negativePrompt.trim()||null,
    size:size.trim()||null,
    aspect_ratio:aspectRatio.trim()||null,
    count
   });
   credential='';approved=false;
  }catch(e){error=String(e);}finally{busy=false;}
 }
 onMount(()=>{void refresh();});
 $effect(()=>{if(registry){void target;if(!imageProviders.some(profile=>profile.id===providerId))selectProvider(imageProviders[0]?.id??'');}});
</script>

<section class="cc-page image-page">
 <header class="cc-page-heading"><div><h1><Image size={20}/>{t($locale,'Image Studio','圖片工作室')}</h1><p>{t($locale,'Generate durable workspace artifacts through approved Paseo, Anneal or direct image providers.','透過已批准嘅 Paseo、Anneal 或直接圖片供應商建立耐久工作區產物。')}</p></div><button class="cc-button secondary" disabled={busy} onclick={refresh}><RefreshCw size={15}/>{t($locale,'Refresh providers','重新整理供應商')}</button></header>
 <p class="cc-notice amber"><ShieldCheck size={16}/>{t($locale,'Each click sends one provider request. Uncertain requests are not repeated automatically. Credentials stay in RAM and generated files are never overwritten.','每次點擊只會發送一次供應商請求；結果不確定時唔會自動重試。憑證只留喺記憶體，生成檔案亦唔會被覆寫。')}</p>
 {#if error}<p class="cc-notice red" role="alert">{error}</p>{/if}

 <div class="image-layout">
  <section class="cc-panel generator">
   <h2>{t($locale,'Generation request','生成請求')}</h2>
   <form onsubmit={event=>{event.preventDefault();void generate();}}>
    <label>{t($locale,'Workspace','工作區')}<select bind:value={workspaceId} required><option value="">—</option>{#each $workspaces as workspace}<option value={workspace.id}>{workspace.name}</option>{/each}</select></label>
    <label>{t($locale,'Use in','使用位置')}<select bind:value={target}><option value="paseo">Paseo</option><option value="anneal">Anneal</option><option value="direct">{t($locale,'Direct','直接')}</option></select></label>
    <label>{t($locale,'Image provider','圖片供應商')}<select value={providerId} onchange={event=>selectProvider(event.currentTarget.value)} required><option value="">—</option>{#each imageProviders as provider}<option value={provider.id}>{provider.name}</option>{/each}</select></label>
    <label>{t($locale,'Model','模型')}{#if models.length}<select bind:value={model} required><option value="">—</option>{#each models as item}<option value={item}>{item}</option>{/each}</select>{:else}<input bind:value={model} required maxlength="256" placeholder={t($locale,'Exact image model ID','精確圖片模型 ID')}/>{/if}</label>
    <label>{t($locale,'Prompt','提示詞')}<textarea rows="7" bind:value={prompt} required maxlength="32768"></textarea></label>
    <label>{t($locale,'Negative prompt','負面提示詞')}<textarea rows="3" bind:value={negativePrompt} maxlength="8192"></textarea></label>
    <div class="form-grid"><label>{t($locale,'Size','尺寸')}<input bind:value={size} maxlength="64"/></label><label>{t($locale,'Aspect ratio','長寬比')}<input bind:value={aspectRatio} maxlength="32"/></label><label>{t($locale,'Count','數量')}<input type="number" min="1" max="4" bind:value={count}/></label></div>
    <label>{t($locale,'Provider credential (RAM only)','供應商憑證（只存記憶體）')}<input type="password" bind:value={credential} autocomplete="off" maxlength="8192"/></label>
    <label class="check"><input type="checkbox" bind:checked={approved}/>{t($locale,'I approve this image request and any provider cost.','我批准今次圖片請求同相關供應商費用。')}</label>
    <button class="cc-button primary" disabled={!canGenerate}><Sparkles size={15}/>{busy?t($locale,'Generating…','生成中…'):t($locale,'Generate image','生成圖片')}</button>
   </form>
  </section>

  <section class="cc-panel output">
   <h2>{t($locale,'Artifacts','產物')}</h2>
   {#if result}
    <p><strong>{result.provider_name}</strong> · {result.model} · {result.target}</p>
    <div class="gallery">{#each result.artifacts as artifact}<figure><img src={convertFileSrc(artifact.absolute_path)} alt={artifact.revised_prompt??prompt}/><figcaption><code>{artifact.relative_path}</code><span>{artifact.media_type} · {artifact.byte_length} bytes</span>{#if artifact.revised_prompt}<p>{artifact.revised_prompt}</p>{/if}</figcaption></figure>{/each}</div>
    <p class="manifest">{t($locale,'Manifest','清單')}: <code>{result.manifest_path}</code></p>
   {:else}<div class="empty"><Image size={40}/><p>{t($locale,'Generated images and their durable workspace paths appear here.','生成圖片同耐久工作區路徑會喺呢度顯示。')}</p></div>{/if}
  </section>
 </div>
</section>

<style>
.image-page{max-width:1550px}.image-page h1{display:flex;align-items:center;gap:.6rem}.image-layout{display:grid;grid-template-columns:minmax(320px,480px) minmax(0,1fr);gap:1rem}.generator,.output{padding:1.2rem}.generator form{display:flex;flex-direction:column;gap:1rem}.generator label:not(.check){display:flex;flex-direction:column;gap:.4rem}.generator input,.generator select,.generator textarea{padding:.6rem;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);color:inherit;min-width:0}.form-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.7rem}.check{display:flex;align-items:flex-start;gap:.5rem}.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.gallery figure{margin:0;border:1px solid var(--border);border-radius:12px;overflow:hidden}.gallery img{display:block;width:100%;height:auto;background:#111}.gallery figcaption{display:flex;flex-direction:column;gap:.3rem;padding:.7rem;font-size:.78rem}.gallery code,.manifest code{overflow-wrap:anywhere}.empty{min-height:360px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--muted)}@media(max-width:900px){.image-layout{grid-template-columns:1fr}.gallery{grid-template-columns:1fr}}@media(max-width:560px){.form-grid{grid-template-columns:1fr}}
</style>
