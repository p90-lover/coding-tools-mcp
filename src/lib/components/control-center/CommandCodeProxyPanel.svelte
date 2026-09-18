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
  import type { FiveStackCatalog, FiveStackSnapshot } from '$lib/control-center/vendor/five-stack-original-ui';
  import { COMMANDCODE_MANAGED_ORIGIN } from '$lib/control-center/vendor/five-stack-original-ui';

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

  let {
    catalog,
    busy,
    onBusy,
    onCatalog,
    onError,
    onNotice,
  }: {
    catalog: FiveStackCatalog | null;
    busy: string | null;
    onBusy: (value: string | null) => void;
    onCatalog: (value: FiveStackCatalog) => void;
    onError: (value: string) => void;
    onNotice: (value: string) => void;
  } = $props();

  let baseUrl = $state(COMMANDCODE_PROXY_DEFAULT_BASE_URL);
  let routerCli = $state('model-router');
  let curateCli = $state('curate-models');
  let planText = $state('');
  let status = $state<Status | null>(null);
  let applyResult = $state<ApplyResult | null>(null);

  const service = $derived(catalog?.tools.find((candidate) => candidate.id === 'commandcode-proxy') ?? null);
  const origin = $derived(COMMANDCODE_MANAGED_ORIGIN);
  const openaiBase = $derived(`${origin}/v1`);
  const anthropicBase = $derived(`${origin}/v1`);
  const health = $derived(service?.health ?? null);
  const version = $derived(typeof health?.version === 'string' ? health.version : '1.0.0');
  const displayStatus = $derived(service?.long_run?.ui_status || service?.long_run?.uiStatus || service?.status || 'offline');

  function buildPlan() {
    return commandCodeProxyRegistrationPlan({ baseUrl, routerCli, curateCli });
  }

  function runDryRun() {
    onError('');
    onNotice('');
    applyResult = null;
    try {
      planText = renderCommandCodeProxyPlan(buildPlan());
      onNotice(t($locale, 'Dry run only. No CLI was executed.', '僅預演，未執行 CLI。'));
    } catch (e) {
      onError(String(e));
    }
  }

  async function copyPlan() {
    onError('');
    onNotice('');
    try {
      const text = planText || renderCommandCodeProxyPlan(buildPlan());
      planText = text;
      await navigator.clipboard.writeText(text);
      onNotice(t($locale, 'Registration plan copied.', '已複製註冊計劃。'));
    } catch (e) {
      onError(String(e));
    }
  }

  async function run(name: string, action: () => Promise<void>) {
    if (busy) return;
    onBusy(name);
    onError('');
    onNotice('');
    try {
      await action();
    } catch (e) {
      onError(String(e));
    } finally {
      onBusy(null);
    }
  }

  async function checkStatus() {
    await run('inspect', async () => {
      status = await invoke<Status>('commandcode_proxy_status', { endpoint: baseUrl });
      const next = await invoke<FiveStackSnapshot>('five_stack_inspect', { toolId: 'commandcode-proxy' });
      if (catalog) {
        onCatalog({
          ...catalog,
          tools: catalog.tools.map((candidate) => candidate.id === next.id ? next : candidate),
        });
      }
    });
  }

  async function applyNonSecret() {
    await run('apply', async () => {
      planText = renderCommandCodeProxyPlan(buildPlan());
      applyResult = await invoke<ApplyResult>('commandcode_proxy_apply', { baseUrl, routerCli, curateCli });
      onNotice(t(
        $locale,
        'Credential set was not executed. Paste the user_* key only in Codex Router’s hidden prompt.',
        '未執行 credential set。user_* 金鑰只能在 Codex Router 隱藏提示中輸入。',
      ));
    });
  }
</script>

<section class="cc-panel cc-integration cc-commandcode" aria-labelledby="commandcode-proxy-title" aria-label="CommandCode AI Proxy">
  <div class="cc-integration-title">
    <span class="cc-source-mark large">C</span>
    <div>
      <h2 id="commandcode-proxy-title">CommandCode Proxy</h2>
      <p>{t($locale, 'Original CLI banner plus managed Check/Start/Stop/Restart on 127.0.0.1:9090.', '原版 CLI banner，並在 127.0.0.1:9090 提供受管 Check／Start／Stop／Restart。')}</p>
    </div>
  </div>
  <div class="cc-integration-features">
    <span class="cc-status {displayStatus === 'ready' ? 'green' : displayStatus === 'blocked' ? 'red' : displayStatus === 'reconnecting' || displayStatus === 'starting' ? 'blue' : 'red'}"><span></span>{displayStatus === 'reconnecting' ? t($locale, 'reconnecting', '正在重連') : displayStatus === 'blocked' ? t($locale, 'reconnect paused', '重連已暫停') : displayStatus}</span>
    <span>{origin}</span>
  </div>
  <pre class="commandcode-banner">
{` CommandCode AI Proxy v${version}
 ===========================
 Listening on 127.0.0.1:9090
 Auth: ENABLED (API key required)

 Cursor settings:
 Base URL : ${openaiBase}
 API Key  : app-managed (not shown)

 Claude Code:
 ANTHROPIC_BASE_URL=${anthropicBase}
 ANTHROPIC_API_KEY=<proxy key>`}
  </pre>
  <p class="cc-help">{t($locale, 'This panel is the pinned zahidhussaina2l/commandcode-proxy banner. Coding Tools can start, stop and inspect it; chat completions still come from clients pointed at these URLs.', '此面板對應 pinned zahidhussaina2l/commandcode-proxy 啟動 banner。Coding Tools 可啟動、停止與檢查；實際對話仍由指向這些 URL 的客戶端發送。')}</p>
  <div class="cc-button-row">
    <button class="cc-button" type="button" disabled={busy !== null} onclick={() => void navigator.clipboard.writeText(openaiBase)}>{t($locale, 'Copy OpenAI base URL', '複製 OpenAI Base URL')}</button>
    <button class="cc-button" type="button" disabled={busy !== null} onclick={() => void navigator.clipboard.writeText(anthropicBase)}>{t($locale, 'Copy Anthropic base URL', '複製 Anthropic Base URL')}</button>
    <button class="cc-button" type="button" disabled={busy !== null} onclick={() => void checkStatus()}><RefreshCw size={15} class={busy === 'inspect' ? 'cc-spin' : ''} />{t($locale, 'Check', '檢查')}</button>
    <button class="cc-button primary" type="button" disabled={busy !== null || service?.status === 'ready'} onclick={() => void run('start', async () => { onCatalog({ version: catalog?.version ?? 1, tools: (catalog?.tools ?? []).map((candidate) => candidate.id === 'commandcode-proxy' ? await invoke<FiveStackSnapshot>('five_stack_start', { toolId: 'commandcode-proxy' }) : candidate) }); })}>{t($locale, 'Start', '啟動')}</button>
    <button class="cc-button" type="button" disabled={busy !== null || !service?.owned} onclick={() => void run('restart', async () => { await invoke('five_stack_restart', { toolId: 'commandcode-proxy' }); await checkStatus(); })}>{t($locale, 'Restart', '重新啟動')}</button>
    <button class="cc-button ghost" type="button" disabled={busy !== null || !service?.owned} onclick={() => void run('stop', async () => { await invoke('five_stack_stop', { toolId: 'commandcode-proxy' }); })}>{t($locale, 'Stop', '停止')}</button>
  </div>

  <div class="cc-notice"><ShieldCheck size={18}/><span>{t($locale, 'Coding Tools never accepts the CommandCode user_* key. Status is GET / and GET /v1/models. Apply runs add, enable and curate only.', '本程式永不接收 CommandCode user_* 金鑰。狀態探測為 GET / 與 GET /v1/models。套用僅執行 add、enable 與 curate。')}</span></div>
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
    <p class="cc-help">{t($locale, `Managed listen is ${COMMANDCODE_MANAGED_ORIGIN}. Registration default remains ${COMMANDCODE_PROXY_DEFAULT_BASE_URL}; some installs also use ${COMMANDCODE_PROXY_ALTERNATE_LISTEN}`, `受管監聽為 ${COMMANDCODE_MANAGED_ORIGIN}。註冊預設仍為 ${COMMANDCODE_PROXY_DEFAULT_BASE_URL}；部分安裝使用 ${COMMANDCODE_PROXY_ALTERNATE_LISTEN}`)}</p>
    <div class="cc-button-row">
      <button class="cc-button" disabled={busy !== null} type="submit"><RefreshCw size={15} class={busy ? 'cc-spin' : ''} />{t($locale, busy ? 'Working…' : 'Check status', busy ? '處理中…' : '檢查狀態')}</button>
      <button class="cc-button" type="button" disabled={busy !== null} onclick={runDryRun}><Play size={15}/>{t($locale, 'Run dry-run', '預演註冊計劃')}</button>
      <button class="cc-button" type="button" disabled={busy !== null} onclick={() => void copyPlan()}><Copy size={15}/>{t($locale, 'Copy plan', '複製計劃')}</button>
      <button class="cc-button ghost" type="button" disabled={busy !== null} onclick={() => void applyNonSecret()}>{t($locale, 'Apply non-secret steps', '套用非密鑰步驟')}</button>
    </div>
  </form>
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
  .commandcode-banner {
    margin: 16px 0 0;
    padding: 16px 18px;
    border: 1px solid rgb(86 255 160 / 22%);
    border-radius: 8px;
    background: #020805;
    color: #9dffc3;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
  }
</style>
