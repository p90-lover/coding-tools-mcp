<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { locale } from '$lib/control-center/state';
  import { translated as t } from '$lib/control-center/model';
  import type {
    FiveStackCatalog,
    FiveStackId,
    FiveStackOpenResult,
    FiveStackSnapshot,
  } from '$lib/control-center/vendor/five-stack-original-ui';

  let {
    toolId,
    catalog,
    busy,
    onBusy,
    onCatalog,
    onError,
    onNotice,
  }: {
    toolId: Exclude<FiveStackId, 'commandcode-proxy'>;
    catalog: FiveStackCatalog | null;
    busy: string | null;
    onBusy: (value: string | null) => void;
    onCatalog: (value: FiveStackCatalog) => void;
    onError: (value: string) => void;
    onNotice: (value: string) => void;
  } = $props();

  let selected = $state('');
  let frameUrl = $state('');

  const tool = $derived(
    catalog?.tools.find((candidate) => candidate.id === toolId) ?? null,
  );

  $effect(() => {
    if (tool && !selected) selected = (tool.long_run?.selected_section || tool.sections[0]) ?? '';
  });

  async function refresh() {
    const next = await invoke<FiveStackCatalog>('five_stack_snapshot');
    onCatalog(next);
    return next.tools.find((candidate) => candidate.id === toolId) ?? null;
  }

  async function run(name: string, action: () => Promise<void>) {
    if (busy) return;
    onBusy(name);
    onError('');
    onNotice('');
    try {
      await action();
      await refresh();
    } catch (error) {
      onError(String(error));
    } finally {
      onBusy(null);
    }
  }

  async function openSection(section = selected) {
    const result = await invoke<FiveStackOpenResult>('five_stack_open', {
      toolId,
      section,
    });
    selected = result.section;
    frameUrl = result.url;
    await refresh();
    if (result.original_window && toolId === 'codex-router') {
      onNotice(
        t(
          $locale,
          'Original Codex Router Control Center is open with its own chrome, layout, and controls.',
          '已開啟原始 Codex Router Control Center，保留原本的視窗外觀、版面與控制項。',
        ),
      );
    }
  }

  const ready = $derived(tool?.status === 'ready');
  const displayStatus = $derived(tool?.long_run?.ui_status || tool?.long_run?.uiStatus || tool?.status || '');
  const mark = $derived(toolId === 'cpa' ? 'M' : toolId === 'paseo' ? 'P' : toolId === 'anneal' ? 'A' : 'R');
</script>

{#if tool}
<section class="cc-panel cc-integration original-ui-panel" data-tool={toolId} data-original-chrome="true" aria-labelledby={`${toolId}-title`}>
  <div class="cc-integration-title">
    <span class="cc-source-mark large">{mark}</span>
    <div>
      <h2 id={`${toolId}-title`}>{tool.name}</h2>
      <p>
        {#if toolId === 'cpa'}
          {t($locale, 'Original CLIProxyAPI management.html, loopback 127.0.0.1:8317.', '原始 CLIProxyAPI management.html，loopback 127.0.0.1:8317。')}
        {:else if toolId === 'codex-router'}
          {t($locale, 'Original Control Center: Usage, Status, Models, Local, Harness, Context, Settings.', '原始 Control Center：用量、狀態、模型、本機、工作臺、上下文、設定。')}
        {:else if toolId === 'paseo'}
          {t($locale, 'Real Expo routes (/sessions, /open-project, /settings) on 127.0.0.1:6768.', '真實 Expo 路由（/sessions、/open-project、/settings）於 127.0.0.1:6768。')}
        {:else}
          {t($locale, 'Original hash routes from app-managed web on 127.0.0.1:5173. Coding Tools manages WSL2/Docker; no user SSH port-forward.', '原版 hash 路由來自受管 web 127.0.0.1:5173。由 Coding Tools 管理 WSL2／Docker，唔使使用者 SSH port-forward。')}
        {/if}
      </p>
    </div>
  </div>
  <div class="cc-integration-features">
    <span class="cc-status {displayStatus === 'ready' ? 'green' : displayStatus === 'blocked' ? 'red' : displayStatus === 'reconnecting' || displayStatus === 'starting' ? 'blue' : 'red'}"><span></span>{displayStatus === 'reconnecting' ? t($locale, 'reconnecting', '正在重連') : displayStatus === 'blocked' ? t($locale, 'reconnect paused', '重連已暫停') : tool.status}</span>
    <span>{tool.endpoint}</span>
    <span>{t($locale, 'Original chrome', '原始介面')}</span>
  </div>
  <div class="cc-button-row">
    <button class="cc-button primary" type="button" disabled={busy !== null} onclick={() => void run(ready ? 'open' : 'start', async () => { if (!ready) await invoke<FiveStackSnapshot>('five_stack_start', { toolId }); await openSection(); })}>
      {busy === 'start' || busy === 'open' ? '…' : ready
        ? t($locale, 'Open original UI', '開啟原始介面')
        : tool.install_state === 'not-installed'
          ? t($locale, 'Install / start original runtime', '安裝／啟動原始執行環境')
          : t($locale, 'Start original UI', '啟動原始介面')}
    </button>
    {#if toolId === 'cpa'}
      <button class="cc-button" type="button" disabled={busy !== null} onclick={() => void run('copy-key', async () => {
        const copied = await invoke<string>('five_stack_copy_cpa_management_key');
        await navigator.clipboard.writeText(copied);
        onNotice(t($locale, `CPA management key copied (${copied.length} chars). Paste it into the original login form.`, `已複製 CPA 管理金鑰（${copied.length} 字）。請貼到原始登入表單。`));
      })}>{t($locale, 'Copy management key', '複製管理金鑰')}</button>
    {/if}
    <button class="cc-button" type="button" disabled={busy !== null || !tool.owned} onclick={() => void run('restart', async () => { await invoke('five_stack_restart', { toolId }); await openSection(); })}>{t($locale, 'Restart', '重新啟動')}</button>
    <button class="cc-button ghost" type="button" disabled={busy !== null || (!ready && !tool.owned)} onclick={() => void run('stop', async () => { await invoke('five_stack_stop', { toolId }); frameUrl = ''; })}>{t($locale, 'Stop', '停止')}</button>
  </div>
  {#if tool.error}<div class="cc-notice red" role="alert">{tool.error}</div>{/if}
  <nav class="original-ui-section-tabs" aria-label={`${tool.name} sections`}>
    {#each tool.sections as section}
      <button class:is-active={section === selected} type="button" onclick={() => { selected = section; if (ready) void openSection(section); }}>{section.replaceAll('-', ' ')}</button>
    {/each}
  </nav>
  <div class="original-ui-frame-shell">
    {#if frameUrl && toolId !== 'codex-router'}
      <iframe allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts" src={frameUrl} title={`${tool.name} original ${selected}`}></iframe>
    {:else}
      <div class="original-ui-frame-empty">
        <strong>{toolId === 'codex-router' ? t($locale, 'Original Control Center window is open from Open original UI.', '按「開啟原始介面」會打開原始 Control Center 視窗。') : t($locale, 'Original interface', '原始介面')}</strong>
        <span>{ready ? t($locale, 'The original visual UI keeps its own layout and controls.', '原始畫面保留自己的版面與控制項。') : t($locale, 'Install and start the managed runtime, then the original UI opens here.', '先安裝並啟動受管理執行環境，原始介面就會在此開啟。')}</span>
      </div>
    {/if}
  </div>
</section>
{/if}
