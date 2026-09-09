<script lang="ts">
 import CodexRuntimePanel from "$lib/components/CodexRuntimePanel.svelte";
 import { Plug, RefreshCw, ShieldCheck, Unplug, ExternalLink } from '@lucide/svelte';
 import { locale,endpoints,snapshots,integrationErrors,integrationBusy,readIntegration,clearIntegration } from '$lib/control-center/state';
 import { translated as t,formatTime,type Source } from '$lib/control-center/model';
 let tokens=$state<Record<Source,string>>({paseo:'',anneal:''});
 async function refresh(source:Source){const secret=tokens[source];tokens[source]='';await readIntegration(source,$endpoints[source],secret);}
</script>
<section class="cc-page">
 <header class="cc-page-heading"><div><h1>{t($locale,'Integrations','專案整合')}</h1><p>{t($locale,'Connect existing project services. Keep their execution controls separate.','連接現有專案服務，並隔離其執行權限。')}</p></div><span class="cc-inline-label"><ShieldCheck size={16}/>{t($locale,'Read-only adapters','唯讀介接器')}</span></header>
 <div class="cc-notice"><ShieldCheck size={18}/><span>{t($locale,'These connections fetch status only. They never create, resume, approve, or send prompts to a coding agent.','連線只讀取狀態，不會建立、恢復、批准 Agent，或向其傳送提示詞。')}</span></div>
 <div class="cc-integrations-grid">
 {#each ['paseo','anneal'] as key}{@const source=key as Source}
 <section class="cc-panel cc-integration"><div class="cc-integration-title"><span class="cc-source-mark large">{source==='paseo'?'P':'A'}</span><div><h2>{source==='paseo'?'Paseo':'Anneal'}</h2><p>{t($locale,source==='paseo'?'Your agents, in one session directory.':'Your delivery chains, without launching a runner.',source==='paseo'?'集中查看 Agent 會話。':'查看交付流程，而不啟動 Runner。')}</p></div></div>
 <div class="cc-integration-features"><span>{source==='paseo'?'WebSocket · protocol v1':'HTTP · board projection'}</span><span>{t($locale,'Manual refresh','手動重新整理')}</span></div>
 <form onsubmit={(e)=>{e.preventDefault();void refresh(source);}} class="cc-form">
 <label>{t($locale,'Local service endpoint','本機服務端點')}<input aria-label={`${source} endpoint`} value={$endpoints[source]} oninput={(e)=>{const value=e.currentTarget.value;endpoints.update(v=>({...v,[source]:value}));}} spellcheck="false" autocomplete="off" required/></label>
 <label>{t($locale,source==='paseo'?'Daemon password (when configured)':'Operator token (when configured)',source==='paseo'?'Daemon 密碼（如有設定）':'Operator Token（如有設定）')}<input type="password" aria-label={`${source} credential`} bind:value={tokens[source]} autocomplete="off" placeholder={t($locale,'Kept in memory for this request only','僅在本次請求的記憶體中保留')}/></label>
 <p class="cc-help">{t($locale,'Literal loopback only: 127.0.0.1 or [::1]. Remote hosts need a secure local port forward you configure.','僅接受 127.0.0.1 或 [::1]。遠端主機須由你設定安全的本機連接埠轉送。')}</p>
 <div class="cc-button-row"><button class="cc-button primary" disabled={$integrationBusy[source]}><RefreshCw size={15} class={$integrationBusy[source]?'cc-spin':''}/>{t($locale,$integrationBusy[source]?'Reading…':$snapshots[source]?'Refresh snapshot':'Connect & read',$integrationBusy[source]?'讀取中…':$snapshots[source]?'更新狀態':'連接並讀取')}</button>{#if $snapshots[source]}<button type="button" class="cc-button ghost" disabled={$integrationBusy[source]} onclick={()=>clearIntegration(source)}><Unplug size={15}/>{t($locale,'Clear view','清除顯示')}</button>{/if}</div>
 </form>
 {#if $integrationErrors[source]}<div class="cc-notice red" role="alert">{$integrationErrors[source]}</div>{/if}
 {#if $snapshots[source]}<div class="cc-connection-proof"><span class="cc-status green"><span></span>{t($locale,'Snapshot received','已收到狀態')}</span><strong>{$snapshots[source]?.items.length} {t($locale,'records','項記錄')}</strong><small>{formatTime($snapshots[source]?.checked_at)} · {$snapshots[source]?.endpoint}</small><a href={source==='paseo'?'/sessions':'/work'}>{t($locale,'Open '+(source==='paseo'?'sessions':'task board'),'開啟'+(source==='paseo'?'會話':'任務看板'))}<ExternalLink size={14}/></a></div>{/if}
 <div class="cc-integration-scope"><strong>{t($locale,'Included in this integration','本次整合範圍')}</strong><p>{source==='paseo'?t($locale,'Session status, attention and permissions count. Uses Paseo’s status ordering. No relay pairing, voice, chat send, or agent execution.','會話狀態、注意事項及待批准數量，使用 Paseo 狀態排序。不包含 Relay 配對、語音、對話傳送或 Agent 執行。'):t($locale,'Read existing board cards and chain order. A separate local twelve-stage checklist records your work. No scheduler, automatic reviews, runner, or merge engine.','讀取現有任務卡及流程排序，另有本機十二階段清單記錄工作。不包含排程器、自動審查、Runner 或合併引擎。')}</p><small>{source==='paseo'?'Apache-2.0 · da8c1b5':'MIT · 088f0d5'} · {t($locale,'Pinned upstream contract','固定上游協定版本')}</small></div>
 </section>{/each}</div>
 <div class="cc-note-panel"><h3>{t($locale,'Before connecting','連接前須知')}</h3><p>{t($locale,'The external service must already be running. Anneal’s upstream release supports macOS and Linux, not native Windows. This app does not install or start it. Existing external agents can independently consume their provider quota; reading their status does not stop them.','外部服務須已在運行。Anneal 上游版本支援 macOS 與 Linux，不支援原生 Windows。本程式不會安裝或啟動它；外部 Agent 仍可能自行消耗配額，讀取狀態不會停止它們。')}</p></div>
 <CodexRuntimePanel/>
</section>
