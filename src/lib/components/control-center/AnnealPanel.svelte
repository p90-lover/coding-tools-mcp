<script lang="ts">
  import { Copy, RefreshCw, Unplug } from '@lucide/svelte';
  import OriginalFrame from './OriginalFrame.svelte';
  import { locale, endpoints, integrationErrors, integrationBusy, connectLive, disconnectLive, liveStatus } from '$lib/control-center/state';
  import { translated as t } from '$lib/control-center/model';
  const annealForward='ssh -N -L 3000:127.0.0.1:3000 user@host';
  let token = $state('');
  let webUi = $state('http://127.0.0.1:3000/#/tasks');
  let keepAlive = $state(true);
  let remember = $state(false);
  let copied = $state(false);
  let live = $derived($liveStatus.find(s => s.source === 'anneal'));
  async function connect() {
    const secret = token; token = '';
    await connectLive('anneal', $endpoints.anneal, webUi, secret, keepAlive, remember);
  }
  async function copyForward(){ await navigator.clipboard.writeText(annealForward); copied=true; }
  function setHash(hash: string){ webUi = `http://127.0.0.1:3000/${hash}`; }
</script>
<section class="cc-panel cc-integration" aria-labelledby="anneal-title">
  <div class="cc-integration-title"><span class="cc-source-mark large">A</span><div>
    <h2 id="anneal-title">Anneal</h2>
    <p>{t($locale,'Original hash-routed board plus start, hold, resume and inbox decisions.','原版 hash 看板，並可開始、暫停、恢復與 Inbox 決策。')}</p>
  </div></div>
  <div class="cc-integration-features">
    <span>HTTP · #/tasks</span>
    <span>{t($locale,'Keep-alive + original board','保活與原版看板')}</span>
  </div>
  <form class="cc-form" onsubmit={(e)=>{e.preventDefault();void connect();}}>
    <label>{t($locale,'API endpoint','API 端點')}<input aria-label="anneal endpoint" value={$endpoints.anneal} oninput={(e)=>endpoints.update(v=>({...v,anneal:e.currentTarget.value}))} spellcheck="false" autocomplete="off" required/></label>
    <label>{t($locale,'Original web UI','原版 Web UI')}<input aria-label="anneal web ui" bind:value={webUi} spellcheck="false" autocomplete="off"/></label>
    <div class="cc-button-row">
      <button type="button" class="cc-button ghost" onclick={()=>setHash('#/tasks')}>#/tasks</button>
      <button type="button" class="cc-button ghost" onclick={()=>setHash('#/projects')}>#/projects</button>
      <button type="button" class="cc-button ghost" onclick={()=>setHash('#/inbox')}>#/inbox</button>
    </div>
    <label>{t($locale,'Operator token (when configured)','Operator Token（如有設定）')}<input type="password" aria-label="anneal credential" bind:value={token} autocomplete="off"/></label>
    <p class="cc-help">{t($locale,'Anneal’s upstream is macOS/Linux, not native Windows. Copy a local forward if the API already runs on another host:','Anneal 上游支援 macOS／Linux，不是原生 Windows。若 API 已在其他主機運行，可複製本機轉送：')} <code>{annealForward}</code></p>
    <button type="button" class="cc-button ghost" onclick={()=>void copyForward()}><Copy size={15}/>{t($locale,copied?'Copied port-forward command':'Copy port-forward command',copied?'已複製連接埠轉送命令':'複製連接埠轉送命令')}</button>
    <label class="cc-check"><input type="checkbox" bind:checked={keepAlive}/>{t($locale,'Keep-alive for multi-day runs','為多日任務保持連線')}</label>
    <label class="cc-check"><input type="checkbox" bind:checked={remember}/>{t($locale,'Remember token on this machine','在本機記住 Token')}</label>
    <div class="cc-button-row">
      <button class="cc-button primary" disabled={$integrationBusy.anneal}><RefreshCw size={15} class={$integrationBusy.anneal?'cc-spin':''}/>{t($locale,$integrationBusy.anneal?'Connecting…':'Connect', $integrationBusy.anneal?'連線中…':'連接')}</button>
      {#if live && live.status !== 'disconnected'}<button type="button" class="cc-button ghost" onclick={()=>void disconnectLive('anneal')}><Unplug size={15}/>{t($locale,'Disconnect','中斷')}</button>{/if}
    </div>
  </form>
  {#if $integrationErrors.anneal}<div class="cc-notice red" role="alert">{$integrationErrors.anneal}</div>{/if}
  {#if live}<div class="cc-connection-proof">
    <span class="cc-status {live.stale?'amber':live.status==='connected'?'green':'red'}"><span></span>{live.stale?t($locale,'Stale','已過期'):live.status}</span>
    <small>{live.endpoint} · {t($locale,'attempts','重試')} {live.reconnect_attempts}</small>
    {#if live.last_error}<small>{live.last_error}</small>{/if}
  </div>{/if}
  {#if live?.web_ui}<OriginalFrame src={live.web_ui} title="Anneal original UI"/>{/if}
  <div class="cc-integration-scope"><strong>{t($locale,'Original function in this app','本程式內的原版功能')}</strong>
    <p>{t($locale,'Embeds #/tasks, #/projects and #/inbox. Native start/hold/resume/archive and inbox decision hit the running API. Runner, scheduler and merge engine stay in Anneal.','嵌入 #/tasks、#/projects、#/inbox。原生開始／暫停／恢復／封存與 Inbox 決策打到已運行的 API。Runner、排程與合併引擎仍在 Anneal。')}</p>
    <small>MIT · 088f0d5</small>
  </div>
</section>
