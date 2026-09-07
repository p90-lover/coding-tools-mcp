<script>
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { frameSource, isFrameStale, controlLabel } from '$lib/computer-view.js';
  let status = $state(/** @type {any} */ ({ state: 'stopped' }));
  let agentFrame = $state(/** @type {any} */ (null));
  let liveFrame = $state(/** @type {any} */ (null));
  let mode = $state('live');
  let message = $state('');
  let now = $state(Date.now());
  let frame = $derived(mode === 'agent' ? agentFrame : liveFrame);
  let src = $derived(frameSource(frame));
  let stale = $derived(isFrameStale(frame, now));

  async function pollStatus() {
    try {
      const result = /** @type {any} */ (await invoke('computer_local_poll', { lastSnapshotId: agentFrame?.snapshot_id ?? null }));
      if (result.session_id !== status.session_id) { agentFrame = null; liveFrame = null; }
      status = result;
      now = Date.now();
      if (result.state === 'stopped') { agentFrame = null; liveFrame = null; }
      else if (result.agent_frame) agentFrame = result.agent_frame;
    } catch (e) { status = { state: 'stopped' }; agentFrame = null; liveFrame = null; message = String(e); }
  }
  async function preview() {
    if (status.state !== 'active') return;
    const sessionId = status.session_id;
    try {
      const result = await invoke('computer_local_preview');
      if (status.state === 'active' && status.session_id === sessionId) { liveFrame = result; message = ''; }
    } catch (e) { if (!String(e).includes('COMPUTER_BUSY')) message = String(e); }
  }
  async function stop() {
    try { await invoke('computer_local_stop'); message = ''; }
    catch (e) { message = String(e); }
    finally { agentFrame = null; liveFrame = null; await pollStatus(); }
  }
  async function pause() { try { await invoke('computer_local_pause'); await pollStatus(); } catch (e) { message = String(e); } }
  async function resume() { try { await invoke('computer_local_resume'); await pollStatus(); } catch (e) { message = String(e); } }
  onMount(() => {
    let polling = false, capturing = false, disposed = false;
    const refresh = async () => { if (polling || disposed) return; polling = true; try { await pollStatus(); } finally { polling = false; } };
    const capture = async () => { if (capturing || disposed) return; capturing = true; try { await preview(); } finally { capturing = false; } };
    void refresh();
    const heartbeat = setInterval(refresh, 400);
    const images = setInterval(capture, 1000);
    return () => { disposed = true; clearInterval(heartbeat); clearInterval(images); };
  });
</script>

<svelte:head><title>Computer control · 電腦操作</title></svelte:head>
<main class="monitor">
  <header>
    <span class:active={status.state === 'active'} class:paused={status.state === 'paused'} class="dot"></span>
    <div><strong>{controlLabel(status)}</strong><small>Local executor · 本機執行 · No Codex agent</small></div>
  </header>
  <section class="target">
    <span>{status.target?.title ?? 'No active control session · 沒有啟用的操作會話'}</span>
    {#if status.target}<small>PID {status.target.pid} · HWND {status.target.window_id} · {status.remaining_seconds ?? 0}s</small>{/if}
  </section>
  <nav aria-label="Preview mode">
    <button class:selected={mode === 'live'} onclick={() => mode = 'live'}>Live target · 即時畫面</button>
    <button class:selected={mode === 'agent'} onclick={() => mode = 'agent'}>Exact agent frame · GPT 所見</button>
  </nav>
  <div class="screen">
    {#if src}
      <img src={src} alt="Actual pixels from the selected window" />
      {#if stale}<span class="stale">Last frame — stale · 舊畫面</span>{/if}
    {:else}
      <p>{mode === 'agent' ? 'No frame sent to the agent in this session yet.\n本會話尚未向 GPT 傳送畫面。' : 'Waiting for real pixels from the selected window.\n等待指定視窗的真實畫面。'}</p>
    {/if}
  </div>
  <div class="metadata">
    {#if frame}<span>{new Date(frame.captured_at_unix_ms).toLocaleTimeString()} · {frame.width} × {frame.height}</span>{/if}
    <span>RAM only · 不儲存截圖</span>
  </div>
  <div class="action">{status.action ? `Current action: ${status.action}` : 'No input currently executing · 目前沒有輸入操作'}</div>
  {#if status.sequence}<small>Sequence step {status.sequence.next_step} / {status.sequence.total_steps}{status.sequence.requires_reobserve ? ' · Reobserve required / 須重新確認' : ''}</small>{/if}
  {#if message}<p class="message" role="status">{message}</p>{/if}
  <footer>
    {#if status.state === 'paused'}<button onclick={resume}>Resume · 繼續</button>{:else}<button disabled={status.state !== 'active'} onclick={pause}>Pause · 暫停</button>{/if}
    <button class="stop" onclick={stop}>Stop · 停止</button>
    <small>Ctrl + Alt + Esc</small>
  </footer>
  <small class="notice">Closing/minimizing this monitor blocks control. Images are never saved locally.<br />關閉或縮小此視窗會停止授權；截圖不會儲存到本機。</small>
</main>

<style>
  :global(body) { margin: 0; background: #111827; color: #f3f4f6; font-family: system-ui, sans-serif; }
  .monitor { padding: 14px; display: flex; flex-direction: column; gap: 9px; }
  header { display: flex; align-items: center; gap: 10px; } header div { display: grid; gap: 3px; }
  small { color: #aebaca; font-size: 11px; } strong { font-size: 13px; }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #94a3b8; flex-shrink: 0; }.dot.active { background: #34d399; }.dot.paused { background: #fbbf24; }
  .target { display: grid; gap: 3px; font-size: 12px; }.target span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  nav { display: flex; gap: 6px; }button { border: 1px solid #475569; color: #e2e8f0; background: #1e293b; border-radius: 7px; padding: 7px 10px; cursor: pointer; font-size: 11px; }button:disabled { opacity: .4; cursor: default; }button.selected { border-color: #60a5fa; }.stop { background: #b91c1c; border-color: #f87171; }
  .screen { position: relative; display: grid; place-items: center; min-height: 150px; background: #030712; border: 1px solid #334155; border-radius: 8px; overflow: hidden; }.screen img { display: block; max-width: 100%; max-height: 260px; object-fit: contain; }.screen p { white-space: pre-line; font-size: 12px; color: #94a3b8; padding: 15px; text-align: center; }.stale { position: absolute; bottom: 8px; background: #92400e; padding: 4px 7px; border-radius: 4px; font-size: 11px; }
  .metadata, footer { display: flex; justify-content: space-between; align-items: center; gap: 7px; }.metadata,.action { font-size: 11px; color: #cbd5e1; }.message { font-size: 11px; color: #fca5a5; margin: 0; overflow-wrap: anywhere; }.notice { line-height: 1.5; }
</style>
