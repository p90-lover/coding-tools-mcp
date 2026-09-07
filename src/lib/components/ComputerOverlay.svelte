<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { frameSource, isFrameStale, controlLabel } from '$lib/computer-view.js';
  let status = $state<any>({ state: 'stopped' });
  let agentFrame = $state<any>(null);
  let liveFrame = $state<any>(null);
  let mode = $state<'agent' | 'live'>('live');
  let message = $state('');
  let now = $state(Date.now());
  const frame = $derived(mode === 'agent' ? agentFrame : liveFrame);
  const src = $derived(frameSource(frame));
  async function action(command: string) {
    try {
      await invoke(command);
      if (command === 'computer_local_stop') { status = { state: 'stopped' }; agentFrame = null; liveFrame = null; }
    } catch (e) { message = String(e); }
  }
  onMount(() => {
    let alive = true;
    let statusTimer: ReturnType<typeof setTimeout>;
    let frameTimer: ReturnType<typeof setTimeout>;
    async function pollStatus() {
      try {
        const result: any = await invoke('computer_local_poll', { lastSnapshotId: agentFrame?.snapshot_id ?? null });
        if (!alive) return;
        status = result;
        if (result.state === 'stopped') { agentFrame = null; liveFrame = null; }
        else if (result.agent_frame) agentFrame = result.agent_frame;
        now = Date.now();
      } catch (e) { status = { state: 'stopped' }; agentFrame = null; liveFrame = null; message = String(e); }
      if (alive) statusTimer = setTimeout(pollStatus, 400);
    }
    async function pollFrame() {
      if (alive && status.state === 'active' && mode === 'live') {
        try {
          const session = status.session_id;
          const result: any = await invoke('computer_local_preview');
          if (alive && status.state === 'active' && status.session_id === session) { liveFrame = result; message = ''; now = Date.now(); }
        } catch (e) { message = String(e); }
      }
      if (alive) frameTimer = setTimeout(pollFrame, 1000);
    }
    void pollStatus(); void pollFrame();
    return () => { alive = false; clearTimeout(statusTimer); clearTimeout(frameTimer); agentFrame = null; liveFrame = null; };
  });
</script>
<div class="monitor" class:paused={status.state === 'paused'} class:stopped={status.state === 'stopped'}>
  <header><span class="indicator"></span><strong aria-live="polite">{controlLabel(status)}</strong></header>
  <p class="target">{status.target?.title ?? 'No desktop session · 沒有操作會話'}</p>
  <div class="toolbar">
    <button class:chosen={mode === 'live'} onclick={() => mode = 'live'}>Live target · 即時畫面</button>
    <button class:chosen={mode === 'agent'} onclick={() => mode = 'agent'}>Exact agent frame · 模型所見</button>
    <span>{status.remaining_seconds ?? 0}s</span>
  </div>
  <div class="screen">
    {#if src && status.state !== 'stopped'}
      <img {src} alt="Actual selected-window pixels; never a generated image" />
      {#if isFrameStale(frame, now)}<span class="stale">Last captured frame · 畫面未更新</span>{/if}
    {:else}<p>{mode === 'agent' ? 'No image has been sent to the agent yet. · 尚未傳送圖片給模型。' : 'No capture available. · 尚未取得畫面。'}</p>{/if}
  </div>
  <div class="metadata">{status.action ? `Action: ${status.action}` : 'Waiting · 等待操作'}<span>RAM only · 不儲存</span></div>
  {#if frame}<p class="stamp">{new Date(frame.captured_at_unix_ms).toLocaleTimeString()} · {frame.width} × {frame.height} · {String(frame.snapshot_id).slice(0, 8)}</p>{/if}
  <footer>
    {#if status.state === 'paused'}<button onclick={() => action('computer_local_resume')}>Resume · 繼續</button>
    {:else}<button disabled={status.state !== 'active'} onclick={() => action('computer_local_pause')}>Pause · 暫停</button>{/if}
    <button class="stop" onclick={() => action('computer_local_stop')}>STOP · 停止</button>
  </footer>
  <p class="hint">Ctrl + Alt + Escape stops input. Closing this window revokes control.</p>
  {#if message}<p class="message" role="status">{message}</p>{/if}
</div>
<style>
  .monitor{min-height:100vh;padding:14px;background:#111820;color:#e9f1f7;font:13px system-ui,sans-serif;border:3px solid #35c69b;box-sizing:border-box;}
  .monitor.paused{border-color:#e7b559}.monitor.stopped{border-color:#697989}
  header{display:flex;gap:8px;align-items:center;font-size:13px}.indicator{width:9px;height:9px;border-radius:50%;background:#35c69b;flex-shrink:0}.paused .indicator{background:#e7b559}.stopped .indicator{background:#697989}
  .target{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:8px 0;color:#b9c9d7;font-size:12px}
  .toolbar,.metadata,footer{display:flex;align-items:center;gap:8px}.toolbar span,.metadata span{margin-left:auto;white-space:nowrap;color:#9aacbb;font-size:11px}
  button{padding:7px 10px;border:1px solid #455565;border-radius:7px;background:#202e3c;color:inherit;cursor:pointer;font:inherit}button:disabled{opacity:.4;cursor:default}button.chosen{border-color:#35c69b;background:#21433e}button:focus-visible{outline:2px solid #e9f1f7;outline-offset:2px}
  .screen{position:relative;height:220px;background:#070c11;display:flex;align-items:center;justify-content:center;border-radius:8px;margin:10px 0;overflow:hidden}.screen img{width:100%;height:100%;object-fit:contain}.screen p{text-align:center;padding:20px;color:#9aacbb}
  .stale{position:absolute;bottom:6px;right:6px;background:#1a202bdd;padding:3px 7px;border-radius:4px;font-size:11px;color:#f1c768}.metadata{font-size:12px}.stamp{font-size:10px;color:#9aacbb;margin:5px 0}
  footer{margin-top:10px}footer button{flex:1}.stop{background:#b83446;border-color:#ed7181;font-weight:700}.hint{color:#a8bac9;font-size:10px;margin:8px 0 0}.message{font-size:10px;overflow-wrap:anywhere;color:#e7b559;max-height:36px;overflow:auto}
</style>
