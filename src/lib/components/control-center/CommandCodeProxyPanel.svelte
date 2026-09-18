<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { Copy, Play, RefreshCw, ShieldCheck, Square, RotateCw } from '@lucide/svelte';
  import { locale, connectLive, liveStatus } from '$lib/control-center/state';
  import { translated as t } from '$lib/control-center/model';
  import {
    COMMANDCODE_PROXY_ALTERNATE_LISTEN,
    COMMANDCODE_PROXY_DEFAULT_BASE_URL,
    commandCodeProxyRegistrationPlan,
    renderCommandCodeProxyPlan,
  } from '$lib/control-center/commandcode-proxy-provider';

  type Status = {
    endpoint: string;
    checked_at: number;
    reachable: boolean;
    http_status: number | null;
    model_count: number | null;
    read_only: boolean;
    health: string | null;
    owned_process: boolean;
    banner: { version: string | null; listen: string; cursor_base_url: string; anthropic_base_url: string } | null;
  };
  type ApplyResult = {
    endpoint: string;
    credential_prompt_required: true;
    steps: { name: string; ok: boolean; detail: string }[];
  };

  let baseUrl = $state(COMMANDCODE_PROXY_DEFAULT_BASE_URL);
  let routerCli = $state('model-router');
  let curateCli = $state('curate-models');
  let bin = $state('proxy.mjs');
  let planText = $state('');
  let status = $state<Status | null>(null);
  let applyResult = $state<ApplyResult | null>(null);
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);
  let keepAlive = $state(true);
  let live = $derived($liveStatus.find(s => s.source === 'commandcode'));

  function buildPlan() {
    return commandCodeProxyRegistrationPlan({ baseUrl, routerCli, curateCli });
  }
  function runDryRun() {
    error = ''; notice = ''; applyResult = null;
    try { planText = renderCommandCodeProxyPlan(buildPlan()); notice = t($locale, 'Dry run only. No CLI was executed.', '僅預演，未執行 CLI。'); }
    catch (e) { error = String(e); }
  }
  async function copyPlan() {
    error = ''; notice = '';
    try {
      const text = planText || renderCommandCodeProxyPlan(buildPlan());
      planText = text;
      await navigator.clipboard.writeText(text);
      notice = t($locale, 'Registration plan copied.', '已複製註冊計劃。');
    } catch (e) { error = String(e); }
  }
  async function checkStatus() {
    if (busy) return;
    busy = true; error = ''; notice = ''; status = null;
    try {
      status = await invoke<Status>('commandcode_proxy_status', { endpoint: baseUrl });
      await connectLive('commandcode', baseUrl, '', '', keepAlive, false);
    } catch (e) { error = String(e); }
    finally { busy = false; }
  }
  async function applyNonSecret() {
    if (busy) return;
    busy = true; error = ''; notice = ''; applyResult = null;
    try {
      planText = renderCommandCodeProxyPlan(buildPlan());
      applyResult = await invoke<ApplyResult>('commandcode_proxy_apply', { baseUrl, routerCli, curateCli });
      notice = t($locale, 'Credential set was not executed. Paste the user_* key only in Codex Router’s hidden prompt.', '未執行 credential set。user_* 金鑰只能在 Codex Router 隱藏提示中輸入。');
    } catch (e) { error = String(e); }
    finally { busy = false; }
  }
  async function control(action: string) {
    if (busy) return;
    busy = true; error = ''; notice = '';
    try {
      const result = await invoke<{ ok: boolean; detail: string }>('commandcode_proxy_control', { action, endpoint: baseUrl, bin });
      notice = result.detail;
      await checkStatus();
    } catch (e) { error = String(e); busy = false; }
  }
  const banner = $derived(status?.banner ?? live?.banner);
</script>

<section class="cc-panel cc-integration cc-commandcode" aria-labelledby="commandcode-proxy-title">
  <div class="cc-integration-title">
    <span class="cc-source-mark large">C</span>
    <div>
      <h2 id="commandcode-proxy-title">CommandCode Proxy</h2>
      <p>{t($locale, 'Original CLI banner, loopback health, owned Start/Stop, and Codex Router registration.', '原版 CLI banner、loopback 健康檢查、owned 啟動／停止，以及 Codex Router 註冊。')}</p>
    </div>
  </div>
  <div class="cc-integration-features">
    <span>HTTP · /health · /v1/models</span>
    <span>{t($locale, 'Keep-alive + owned process', '保活與 owned 行程')}</span>
  </div>
  <pre class="cc-commandcode-banner" aria-label="CommandCode Proxy banner">{`CommandCode Proxy
listen        ${banner?.listen ?? baseUrl}
Cursor /v1    ${banner?.cursor_base_url ?? 'http://127.0.0.1:3050/v1'}
ANTHROPIC_BASE_URL=${banner?.anthropic_base_url ?? 'http://127.0.0.1:3050'}
health        ${status?.health ?? live?.health ?? '—'}
models        ${status?.model_count ?? live?.model_count ?? '—'}`}</pre>
  <div class="cc-notice"><ShieldCheck size={18}/><span>{t($locale, 'Coding Tools never accepts the CommandCode user_* key. Start forces HOST=127.0.0.1. Stop only kills an owned child.', '本程式永不接收 CommandCode user_* 金鑰。Start 強制 HOST=127.0.0.1。Stop 只結束 owned 子行程。')}</span></div>
  <form class="cc-form" onsubmit={(e) => { e.preventDefault(); void checkStatus(); }}>
    <label>{t($locale, 'Proxy base URL', '代理 Base URL')}
      <input aria-label="commandcode-proxy endpoint" bind:value={baseUrl} spellcheck="false" autocomplete="off" required />
    </label>
    <label>{t($locale, 'Owned binary (proxy.mjs or commandcode-proxy)', 'Owned 二進位（proxy.mjs 或 commandcode-proxy）')}
      <input aria-label="commandcode-proxy binary" bind:value={bin} spellcheck="false" autocomplete="off" />
    </label>
    <label>{t($locale, 'Codex Router CLI', 'Codex Router CLI')}
      <input aria-label="model-router CLI" bind:value={routerCli} spellcheck="false" autocomplete="off" required />
    </label>
    <label>{t($locale, 'curate-models CLI', 'curate-models CLI')}
      <input aria-label="curate-models CLI" bind:value={curateCli} spellcheck="false" autocomplete="off" required />
    </label>
    <p class="cc-help">{t($locale, `Literal loopback only. Default ${COMMANDCODE_PROXY_DEFAULT_BASE_URL}. Alternate listen ${COMMANDCODE_PROXY_ALTERNATE_LISTEN}.`, `僅接受字面 loopback。預設 ${COMMANDCODE_PROXY_DEFAULT_BASE_URL}。另一常見監聽 ${COMMANDCODE_PROXY_ALTERNATE_LISTEN}`)}</p>
    <label class="cc-check"><input type="checkbox" bind:checked={keepAlive}/>{t($locale,'Keep-alive poll for multi-day runs','為多日任務保持探測')}</label>
    <div class="cc-button-row">
      <button class="cc-button primary" disabled={busy} type="submit"><RefreshCw size={15} class={busy ? 'cc-spin' : ''} />{t($locale, busy ? 'Working…' : 'Check status', busy ? '處理中…' : '檢查狀態')}</button>
      <button class="cc-button" type="button" disabled={busy} onclick={() => void control('start')}><Play size={15}/>{t($locale, 'Start', '啟動')}</button>
      <button class="cc-button" type="button" disabled={busy} onclick={() => void control('restart')}><RotateCw size={15}/>{t($locale, 'Restart', '重啟')}</button>
      <button class="cc-button ghost" type="button" disabled={busy} onclick={() => void control('stop')}><Square size={15}/>{t($locale, 'Stop owned', '停止 owned')}</button>
      <button class="cc-button" type="button" disabled={busy} onclick={runDryRun}>{t($locale, 'Run dry-run', '預演註冊計劃')}</button>
      <button class="cc-button" type="button" disabled={busy} onclick={() => void copyPlan()}><Copy size={15}/>{t($locale, 'Copy plan', '複製計劃')}</button>
      <button class="cc-button ghost" type="button" disabled={busy} onclick={() => void applyNonSecret()}>{t($locale, 'Apply non-secret steps', '套用非密鑰步驟')}</button>
    </div>
  </form>
  {#if error}<div class="cc-notice red" role="alert">{error}</div>{/if}
  {#if notice}<div class="cc-notice" role="status">{notice}</div>{/if}
  {#if live}<div class="cc-connection-proof"><span class="cc-status {live.stale?'amber':live.status==='connected'?'green':'red'}"><span></span>{live.stale?t($locale,'Stale','已過期'):live.status}</span><small>{t($locale,'attempts','重試')} {live.reconnect_attempts}</small></div>{/if}
  {#if status}
    <div class="cc-connection-proof">
      <span class="cc-status {status.reachable ? 'green' : 'red'}"><span></span>{status.reachable ? t($locale, 'Proxy reachable', '代理可達') : t($locale, 'Proxy not reachable', '代理不可達')}</span>
      <strong>{status.http_status ?? '—'}{status.model_count != null ? ` · ${status.model_count} models` : ''}{status.owned_process ? ' · owned' : ''}</strong>
      <small>{new Date(status.checked_at * 1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · {status.endpoint}</small>
    </div>
  {/if}
  {#if applyResult}
    <div class="cc-connection-proof">
      {#each applyResult.steps as step}
        <span class="cc-status {step.ok ? 'green' : 'red'}"><span></span>{step.name}: {step.detail}</span>
      {/each}
      <small>{t($locale, 'Still run credential set in a terminal. Coding Tools did not collect a key.', '請在終端機執行 credential set。本程式未收集金鑰。')}</small>
    </div>
  {/if}
  {#if planText}<pre class="cc-commandcode-plan">{planText}</pre>{/if}
  <div class="cc-integration-scope">
    <strong>{t($locale, 'Included in this integration', '本次整合範圍')}</strong>
    <p>{t($locale, 'Original banner, GET /health and /v1/models, owned loopback Start/Stop, and the Codex Router generic-provider plan. Chat completions stay on the proxy; this app never takes a user_* key.', '原版 banner、GET /health 與 /v1/models、owned loopback 啟動／停止，以及 Codex Router generic-provider 註冊計劃。聊天請求仍走代理；本程式永不接收 user_*。')}</p>
    <small>MIT · MAXeaglet/commandcode-proxy</small>
  </div>
</section>

<style>
  .cc-commandcode { margin-top: 0; }
  .cc-commandcode-banner, .cc-commandcode-plan {
    margin: 18px 0 0;
    padding: 12px;
    background: #0b1220;
    color: #d7e3ff;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 11px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: ui-monospace, monospace;
  }
  .cc-commandcode-plan { max-height: 16rem; overflow: auto; background: var(--page-bg); color: inherit; }
</style>
