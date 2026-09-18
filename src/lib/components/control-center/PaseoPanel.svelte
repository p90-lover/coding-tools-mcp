<script lang="ts">
  import { RefreshCw, Unplug } from '@lucide/svelte';
  import OriginalFrame from './OriginalFrame.svelte';
  import { locale, endpoints, integrationErrors, integrationBusy, connectLive, disconnectLive, liveStatus, actIntegration } from '$lib/control-center/state';
  import { translated as t } from '$lib/control-center/model';
  let token = $state('');
  let webUi = $state('http://127.0.0.1:6768/sessions');
  let keepAlive = $state(true);
  let remember = $state(false);
  let createProvider = $state('codex');
  let createCwd = $state('');
  let createPrompt = $state('');
  let createNotice = $state('');
  let live = $derived($liveStatus.find(s => s.source === 'paseo'));
  async function connect() {
    const secret = token; token = '';
    await connectLive('paseo', $endpoints.paseo, webUi, secret, keepAlive, remember);
  }
  function setPath(path: string){ webUi = `http://127.0.0.1:6768${path}`; }
  async function createAgent() {
    createNotice = '';
    try {
      const result = await actIntegration('paseo', $endpoints.paseo, { op: 'create', provider: createProvider, cwd: createCwd, text: createPrompt });
      createNotice = result && typeof result === 'object' && 'detail' in result ? String((result as {detail:string}).detail) : t($locale,'Create request sent.','已送出建立請求。');
    } catch (e) { createNotice = String(e); }
  }
</script>
<section class="cc-panel cc-integration" aria-labelledby="paseo-title">
  <div class="cc-integration-title"><span class="cc-source-mark large">P</span><div>
    <h2 id="paseo-title">Paseo</h2>
    <p>{t($locale,'Original session UI plus daemon controls for send, resume, cancel, archive and permission.','原版會話畫面，並可發送、恢復、取消、封存與批准。')}</p>
  </div></div>
  <div class="cc-integration-features">
    <span>WebSocket · protocol v1</span>
    <span>{t($locale,'Keep-alive + original /sessions','保活與原版 /sessions')}</span>
  </div>
  <form class="cc-form" onsubmit={(e)=>{e.preventDefault();void connect();}}>
    <label>{t($locale,'Daemon WebSocket','Daemon WebSocket')}<input aria-label="paseo endpoint" value={$endpoints.paseo} oninput={(e)=>endpoints.update(v=>({...v,paseo:e.currentTarget.value}))} spellcheck="false" autocomplete="off" required/></label>
    <label>{t($locale,'Original web UI','原版 Web UI')}<input aria-label="paseo web ui" bind:value={webUi} spellcheck="false" autocomplete="off"/></label>
    <div class="cc-button-row">
      <button type="button" class="cc-button ghost" onclick={()=>setPath('/sessions')}>/sessions</button>
      <button type="button" class="cc-button ghost" onclick={()=>setPath('/open-project')}>/open-project</button>
      <button type="button" class="cc-button ghost" onclick={()=>setPath('/settings')}>/settings</button>
    </div>
    <label>{t($locale,'Daemon password (when configured)','Daemon 密碼（如有設定）')}<input type="password" aria-label="paseo credential" bind:value={token} autocomplete="off"/></label>
    <label class="cc-check"><input type="checkbox" bind:checked={keepAlive}/>{t($locale,'Keep-alive for multi-day runs','為多日任務保持連線')}</label>
    <label class="cc-check"><input type="checkbox" bind:checked={remember}/>{t($locale,'Remember credential on this machine','在本機記住憑據')}</label>
    <div class="cc-button-row">
      <button class="cc-button primary" disabled={$integrationBusy.paseo}><RefreshCw size={15} class={$integrationBusy.paseo?'cc-spin':''}/>{t($locale,$integrationBusy.paseo?'Connecting…':'Connect', $integrationBusy.paseo?'連線中…':'連接')}</button>
      {#if live && live.status !== 'disconnected'}<button type="button" class="cc-button ghost" onclick={()=>void disconnectLive('paseo')}><Unplug size={15}/>{t($locale,'Disconnect','中斷')}</button>{/if}
    </div>
  </form>
  {#if $integrationErrors.paseo}<div class="cc-notice red" role="alert">{$integrationErrors.paseo}</div>{/if}
  {#if live}<div class="cc-connection-proof">
    <span class="cc-status {live.stale?'amber':live.status==='connected'?'green':'red'}"><span></span>{live.stale?t($locale,'Stale','已過期'):live.status}</span>
    <small>{live.endpoint} · {t($locale,'attempts','重試')} {live.reconnect_attempts}</small>
    {#if live.last_error}<small>{live.last_error}</small>{/if}
    {#if live.credential_needed}<div class="cc-notice amber">{t($locale,'Re-enter the daemon password to resume keep-alive.','請再輸入 Daemon 密碼以恢復保活。')}</div>{/if}
  </div>{/if}
  {#if live?.web_ui}<OriginalFrame src={live.web_ui} title="Paseo original UI"/>{/if}
  {#if live && live.status !== 'disconnected'}
    <form class="cc-form" onsubmit={(e)=>{e.preventDefault();void createAgent();}}>
      <label>{t($locale,'Create agent provider','建立 Agent 供應商')}<input aria-label="paseo create provider" bind:value={createProvider} spellcheck="false"/></label>
      <label>{t($locale,'Create agent cwd','建立 Agent 工作目錄')}<input aria-label="paseo create cwd" bind:value={createCwd} spellcheck="false"/></label>
      <label>{t($locale,'Initial prompt','初始提示')}<textarea aria-label="paseo create prompt" bind:value={createPrompt} rows="3"></textarea></label>
      <button class="cc-button" type="submit">{t($locale,'Create agent','建立 Agent')}</button>
      {#if createNotice}<div class="cc-notice" role="status">{createNotice}</div>{/if}
    </form>
  {/if}
  <div class="cc-integration-scope"><strong>{t($locale,'Original function in this app','本程式內的原版功能')}</strong>
    <p>{t($locale,'Embeds /sessions, /open-project and /settings when the web UI is up. Native Send/Resume/Cancel/Archive/Allow use protocol v1 allowlisted RPCs. Relay, voice and pairing stay in Paseo.','Web UI 可用時嵌入 /sessions、/open-project、/settings。原生發送／恢復／取消／封存／批准使用 protocol v1 允許名單。Relay、語音與配對仍在 Paseo。')}</p>
    <small>Apache-2.0 · da8c1b5</small>
  </div>
</section>
