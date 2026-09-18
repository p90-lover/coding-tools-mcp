<script lang="ts">
 import { onMount } from 'svelte';
 import CodexRuntimePanel from "$lib/components/CodexRuntimePanel.svelte";
 import CommandCodeProxyPanel from "$lib/components/control-center/CommandCodeProxyPanel.svelte";
 import PaseoPanel from "$lib/components/control-center/PaseoPanel.svelte";
 import AnnealPanel from "$lib/components/control-center/AnnealPanel.svelte";
 import ProviderConfigPreview from "$lib/components/ProviderConfigPreview.svelte";
 import { Plug, ShieldCheck } from '@lucide/svelte';
 import { locale, refreshLive } from '$lib/control-center/state';
 import { translated as t } from '$lib/control-center/model';
 onMount(() => {
  void refreshLive();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshLive(); }, 5000);
  return () => clearInterval(timer);
 });
</script>
<section class="cc-page">
 <header class="cc-page-heading"><div><h1>{t($locale,'Integrations','專案整合')}</h1><p>{t($locale,'Original Paseo, Anneal and CommandCode Proxy surfaces, with keep-alive for multi-day runs.','原版 Paseo、Anneal 與 CommandCode Proxy 表面，並為多日任務保活。')}</p></div><span class="cc-inline-label"><Plug size={16}/>{t($locale,'Original function','原版功能')}</span></header>
 <div class="cc-notice"><ShieldCheck size={18}/><span>{t($locale,'These adapters talk to services you already run. They do not bundle Paseo/Anneal engines or collect CommandCode user_* keys.','這些介接連到你已運行的服務，不會打包 Paseo／Anneal 引擎，也不收集 CommandCode user_* 金鑰。')}</span></div>
 <div class="cc-integrations-grid">
  <PaseoPanel/>
  <AnnealPanel/>
  <CommandCodeProxyPanel/>
 </div>
 <div class="cc-note-panel"><h3>{t($locale,'Before connecting','連接前須知')}</h3><p>{t($locale,'The external service must already be running unless you Start an owned CommandCode Proxy binary. Anneal’s upstream release supports macOS and Linux, not native Windows. Keep-alive survives leaving this page; stale means the last successful round-trip is too old.','除非你啟動 owned CommandCode Proxy 二進位，否則外部服務須已在運行。Anneal 上游支援 macOS 與 Linux，不是原生 Windows。保活在離開此頁後仍會繼續；Stale 表示上次成功 round-trip 已過期。')}</p></div>
 <CodexRuntimePanel/>
 <ProviderConfigPreview/>
</section>
