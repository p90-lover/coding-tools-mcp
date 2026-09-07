<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { confirm } from '@tauri-apps/plugin-dialog';
  let { workspaceId }: { workspaceId: string } = $props();
  type Target = { window_id: number; pid: number; title: string };
  let targets = $state<Target[]>([]);
  let selection = $state('');
  let message = $state('Select one application. Screenshots remain in memory. · 請選擇一個應用程式；截圖不會儲存。');
  let busy = $state(false);
  let status = $state<any>({ state: 'stopped' });
  async function refresh() {
    busy = true;
    try { targets = await invoke<Target[]>('computer_local_targets', { workspaceId }); }
    catch (e) { message = String(e); }
    finally { busy = false; }
  }
  async function start() {
    const target = targets.find(t => `${t.window_id}:${t.pid}` === selection);
    if (!target) return;
    const accepted = await confirm(`Allow connected MCP clients for this workspace to view and operate ONLY “${target.title}” for 10 minutes?\n\nReal mouse/keyboard input uses your foreground desktop. Stay present for sensitive actions. Screenshots are not saved by this app.\n\n允許此工作區已連接的 MCP 用戶端，在 10 分鐘內查看及操作上述視窗？這會使用前台鍵鼠，請留意敏感操作。\n\nStop anytime with Ctrl+Alt+Escape or the visible Stop button.`, { title: 'Enable local computer control / 啟用電腦操作', kind: 'warning' });
    if (!accepted) return;
    busy = true;
    try {
      status = await invoke('computer_local_start', { workspaceId, windowId: target.window_id, pid: target.pid, durationSeconds: 600 });
      message = 'Control monitor opened. Keep it visible; minimize/close stops authorization. · 控制視窗已開啟，請保持可見。';
    } catch (e) { message = String(e); }
    finally { busy = false; }
  }
  async function stop() { try { await invoke('computer_local_stop'); status = { state: 'stopped' }; } catch(e) { message = String(e); } }
  onMount(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await invoke('computer_local_poll'); if (alive) status = value; } catch { /* Browser preview cannot invoke desktop commands. */ }
      if (alive) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  });
</script>
<section class="tx-surface mt-4 rounded-xl border border-[var(--border)] p-5" aria-label="Local computer control">
  <div class="flex items-center justify-between gap-4">
    <div><h3 class="text-base font-semibold">Computer control · 電腦操作</h3><p class="mt-1 text-sm opacity-70">Windows UI Automation + real input. No Codex agent or API.</p></div>
    <span class="rounded-full border px-3 py-1 text-xs">{status.state === 'active' ? 'Enabled · 已啟用' : status.state === 'paused' ? 'Paused · 暫停' : 'Off · 關閉'}</span>
  </div>
  <div class="mt-4 flex flex-wrap items-center gap-3">
    <button class="tx-btn-secondary" disabled={busy} onclick={refresh}>Refresh windows · 重新整理</button>
    <select class="min-w-48 max-w-full rounded border bg-[var(--surface)] p-2 text-sm" bind:value={selection} aria-label="Target application">
      <option value="">Choose one window · 選擇視窗</option>
      {#each targets as target}<option value={`${target.window_id}:${target.pid}`}>{target.title} (PID {target.pid})</option>{/each}
    </select>
    <button class="tx-btn-primary" disabled={busy || !selection || status.state !== 'stopped'} onclick={start}>Enable for 10 min · 啟用 10 分鐘</button>
    <button class="tx-btn-secondary" onclick={stop}>Stop · 停止</button>
  </div>
  <p class="mt-3 text-sm opacity-80" role="status">{message}</p>
  <p class="mt-2 text-xs opacity-60">Emergency Stop: Ctrl + Alt + Escape. Password, administration, shell and this controller's windows are not input targets. · 可隨時按快捷鍵停止。</p>
</section>
