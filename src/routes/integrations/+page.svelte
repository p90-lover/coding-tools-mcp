<script lang="ts">
 import { onMount } from 'svelte';
 import { invoke } from '@tauri-apps/api/core';
 import CodexRuntimePanel from "$lib/components/CodexRuntimePanel.svelte";
 import CommandCodeProxyPanel from "$lib/components/control-center/CommandCodeProxyPanel.svelte";
 import OriginalUiPanel from "$lib/components/control-center/OriginalUiPanel.svelte";
 import ProviderConfigPreview from "$lib/components/ProviderConfigPreview.svelte";
 import { Plug, RefreshCw, ShieldCheck } from '@lucide/svelte';
 import { locale } from '$lib/control-center/state';
 import { translated as t } from '$lib/control-center/model';
 import type { FiveStackCatalog } from '$lib/control-center/vendor/five-stack-original-ui';

 let catalog = $state<FiveStackCatalog | null>(null);
 let busy = $state<string | null>(null);
 let error = $state('');
 let notice = $state('');

 async function loadCatalog() {
  catalog = await invoke<FiveStackCatalog>('five_stack_snapshot');
 }

 async function bootstrap() {
  if (busy) return;
  busy = 'bootstrap';
  error = '';
  notice = '';
  try {
   catalog = await invoke<FiveStackCatalog>('five_stack_bootstrap');
   notice = t($locale, 'Install and start all finished. Open each original UI from its panel.', '已完成全部安裝並啟動。請在各面板開啟原始介面。');
  } catch (cause) {
   error = String(cause);
  } finally {
   busy = null;
  }
 }

 onMount(() => {
  void loadCatalog().catch((cause) => { error = String(cause); });
 });
</script>
<section class="cc-page">
 <header class="cc-page-heading"><div><h1>{t($locale,'Integrations','專案整合')}</h1><p>{t($locale,'Original visual UIs and managed start/stop for Codex Router, CPA, CommandCode, Paseo, and Anneal.','Codex Router、CPA、CommandCode、Paseo 同 Anneal 都有原版畫面同受管啟動／停止。')}</p></div><span class="cc-inline-label"><Plug size={16}/>{t($locale,'Managed original UIs','受管原始介面')}</span></header>
 <div class="cc-notice"><ShieldCheck size={18}/><span>{t($locale,'Coding Tools installs and starts the five loopback services. Original functions stay in each original UI. Observation snapshots remain read-only and never send prompts.','Coding Tools 負責安裝並啟動五個 loopback 服務。原版功能留在各原始介面。觀察快照仍然唯讀，唔會傳送提示詞。')}</span></div>
 <div class="cc-button-row" style="margin: 0 0 1rem;">
  <button class="cc-button primary" type="button" disabled={busy !== null} onclick={() => void bootstrap()}><RefreshCw size={15} class={busy === 'bootstrap' ? 'cc-spin' : ''}/>{t($locale, busy === 'bootstrap' ? 'Working…' : 'Install and start all', busy === 'bootstrap' ? '處理中…' : '全部安裝並啟動')}</button>
  <button class="cc-button" type="button" disabled={busy !== null} onclick={() => void bootstrap()}>{t($locale,'Retry all','全部重試')}</button>
 </div>
 {#if error}<div class="cc-notice red" role="alert">{error}</div>{/if}
 {#if notice}<div class="cc-notice" role="status">{notice}</div>{/if}
 <div class="cc-integrations-grid">
  <OriginalUiPanel toolId="codex-router" {catalog} {busy} onBusy={(value) => busy = value} onCatalog={(value) => catalog = value} onError={(value) => error = value} onNotice={(value) => notice = value}/>
  <OriginalUiPanel toolId="cpa" {catalog} {busy} onBusy={(value) => busy = value} onCatalog={(value) => catalog = value} onError={(value) => error = value} onNotice={(value) => notice = value}/>
  <CommandCodeProxyPanel {catalog} {busy} onBusy={(value) => busy = value} onCatalog={(value) => catalog = value} onError={(value) => error = value} onNotice={(value) => notice = value}/>
  <OriginalUiPanel toolId="paseo" {catalog} {busy} onBusy={(value) => busy = value} onCatalog={(value) => catalog = value} onError={(value) => error = value} onNotice={(value) => notice = value}/>
  <OriginalUiPanel toolId="anneal" {catalog} {busy} onBusy={(value) => busy = value} onCatalog={(value) => catalog = value} onError={(value) => error = value} onNotice={(value) => notice = value}/>
 </div>
 <CodexRuntimePanel/>
 <ProviderConfigPreview/>
</section>
