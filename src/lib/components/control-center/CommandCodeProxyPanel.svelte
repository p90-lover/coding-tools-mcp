<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { Copy, Play, RefreshCw, ShieldCheck } from '@lucide/svelte';
  import { locale } from '$lib/control-center/state';
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
    read_only: true;
  };
  type ApplyResult = {
    endpoint: string;
    credential_prompt_required: true;
    steps: { name: string; ok: boolean; detail: string }[];
  };

  let baseUrl = $state(COMMANDCODE_PROXY_DEFAULT_BASE_URL);
  let routerCli = $state('model-router');
  let curateCli = $state('curate-models');
  let planText = $state('');
  let status = $state<Status | null>(null);
  let applyResult = $state<ApplyResult | null>(null);
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);

  function buildPlan() {
    return commandCodeProxyRegistrationPlan({
      baseUrl,
      routerCli,
      curateCli,
    });
  }

  function runDryRun() {
    error = '';
    notice = '';
    applyResult = null;
    try {
      planText = renderCommandCodeProxyPlan(buildPlan());
      notice = t($locale, 'Dry run only. No CLI was executed.', '僅預演，未執行 CLI。');
    } catch (e) {
      error = String(e);
    }
  }

  async function copyPlan() {
    error = '';
    notice = '';
    try {
      const text = planText || renderCommandCodeProxyPlan(buildPlan());
      planText = text;
      await navigator.clipboard.writeText(text);
      notice = t($locale, 'Registration plan copied.', '已複製註冊計劃。');
    } catch (e) {
      error = String(e);
    }
  }

  async function checkStatus() {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    status = null;
    try {
      status = await invoke<Status>('commandcode_proxy_status', { endpoint: baseUrl });
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function applyNonSecret() {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    applyResult = null;
    try {
      planText = renderCommandCodeProxyPlan(buildPlan());
      applyResult = await invoke<ApplyResult>('commandcode_proxy_apply', {
        baseUrl,
        routerCli,
        curateCli,
      });
      notice = t(
        $locale,
        'Credential set was not executed. Paste the user_* key only in Codex Router’s hidden prompt.',
        '未執行 credential set。user_* 金鑰只能在 Codex Router 隱藏提示中輸入。',
      );
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="cc-panel cc-integration cc-commandcode" aria-labelledby="commandcode-proxy-title">
  <div class="cc-integration-title">
    <span class="cc-source-mark large">C</span>
    <div>
      <h2 id="commandcode-proxy-title">CommandCode Proxy</h2>
      <p>{t($locale, 'Register the local OpenAI-compatible proxy as a Codex Router generic provider.', '把本機 OpenAI 相容代理註冊為 Codex Router generic provider。')}</p>
    </div>
  </div>
  <div class="cc-integration-features">
    <span>HTTP · /v1/models</span>
    <span>{t($locale, 'Loopback status + registration plan', 'Loopback 狀態與註冊計劃')}</span>
  </div>
  <div class="cc-notice"><ShieldCheck size={18}/><span>{t($locale, 'Coding Tools never accepts the CommandCode user_* key. Status is GET-only. Apply runs add, enable and curate only.', '本程式永不接收 CommandCode user_* 金鑰。狀態探測只做 GET。套用僅執行 add、enable 與 curate。')}</span></div>
  <form class="cc-form" onsubmit={(e) => { e.preventDefault(); void checkStatus(); }}>
    <label>{t($locale, 'Proxy base URL', '代理 Base URL')}
      <input aria-label="commandcode-proxy endpoint" bind:value={baseUrl} spellcheck="false" autocomplete="off" required />
    </label>
    <label>{t($locale, 'Codex Router CLI', 'Codex Router CLI')}
      <input aria-label="model-router CLI" bind:value={routerCli} spellcheck="false" autocomplete="off" required />
    </label>
    <label>{t($locale, 'curate-models CLI', 'curate-models CLI')}
      <input aria-label="curate-models CLI" bind:value={curateCli} spellcheck="false" autocomplete="off" required />
    </label>
    <p class="cc-help">{t($locale, `Literal loopback only. Default registration URL is ${COMMANDCODE_PROXY_DEFAULT_BASE_URL}. Some installs listen on ${COMMANDCODE_PROXY_ALTERNATE_LISTEN}`, `僅接受字面 loopback。預設註冊 URL 為 ${COMMANDCODE_PROXY_DEFAULT_BASE_URL}。部分安裝監聽 ${COMMANDCODE_PROXY_ALTERNATE_LISTEN}`)}</p>
    <div class="cc-button-row">
      <button class="cc-button primary" disabled={busy} type="submit"><RefreshCw size={15} class={busy ? 'cc-spin' : ''} />{t($locale, busy ? 'Working…' : 'Check status', busy ? '處理中…' : '檢查狀態')}</button>
      <button class="cc-button" type="button" disabled={busy} onclick={runDryRun}><Play size={15}/>{t($locale, 'Run dry-run', '預演註冊計劃')}</button>
      <button class="cc-button" type="button" disabled={busy} onclick={() => void copyPlan()}><Copy size={15}/>{t($locale, 'Copy plan', '複製計劃')}</button>
      <button class="cc-button ghost" type="button" disabled={busy} onclick={() => void applyNonSecret()}>{t($locale, 'Apply non-secret steps', '套用非密鑰步驟')}</button>
    </div>
  </form>
  {#if error}<div class="cc-notice red" role="alert">{error}</div>{/if}
  {#if notice}<div class="cc-notice" role="status">{notice}</div>{/if}
  {#if status}
    <div class="cc-connection-proof">
      <span class="cc-status {status.reachable ? 'green' : 'red'}"><span></span>{status.reachable ? t($locale, 'Proxy reachable', '代理可達') : t($locale, 'Proxy not reachable', '代理不可達')}</span>
      <strong>{status.http_status ?? '—'}{status.model_count != null ? ` · ${status.model_count} models` : ''}</strong>
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
    <p>{t($locale, 'Loopback health of MAXeaglet/commandcode-proxy and the Codex Router generic-provider registration plan. This app does not install the proxy, start it, or open a chat client.', '探測 MAXeaglet/commandcode-proxy 的 loopback 健康狀態，並產生 Codex Router generic-provider 註冊計劃。本程式不安裝、不啟動代理，也不提供聊天客戶端。')}</p>
    <small>MIT · MAXeaglet/commandcode-proxy · {t($locale, 'Provider registration only', '僅供應商註冊')}</small>
  </div>
</section>

<style>
  .cc-commandcode { margin-top: 0; }
  .cc-commandcode-plan {
    margin: 18px 0 0;
    padding: 12px;
    background: var(--page-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 11px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 16rem;
    overflow: auto;
    font-family: ui-monospace, monospace;
  }
</style>
