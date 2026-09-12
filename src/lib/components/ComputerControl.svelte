<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { confirm } from '@tauri-apps/plugin-dialog';
  import { durationLabel, rememberedGrantLabel } from '$lib/computer-view.js';
  import SandboxControl from './SandboxControl.svelte';
  let { workspaceId }: { workspaceId: string } = $props();
  type Target = { window_id: number; pid: number; title: string };
  let targets = $state<Target[]>([]);
  let selection = $state('');
  let alwaysEnabled = $state(false);
  let rememberApp = $state(false);
  let restoreOnStart = $state(false);
  let startAtLogin = $state(false);
  let discoverWindows = $state(false);
  let observeInBackground = $state(true);
  let permission = $state<any>({ remembered: false });
  let message = $state('Choose an app. Background observation does not take focus. · 選擇應用程式；背景觀察不會搶焦點。');
  let busy = $state(false);
  let status = $state<any>({ state: 'stopped' });
  async function refresh() {
    busy = true;
    try {
      targets = await invoke<Target[]>('computer_local_targets', { workspaceId });
      permission = await invoke('computer_local_permissions', { workspaceId });
    } catch (e) { message = String(e); }
    finally { busy = false; }
  }
  async function start() {
    const target = targets.find(t => `${t.window_id}:${t.pid}` === selection);
    if (!target) return;
    const always = alwaysEnabled;
    const remember = rememberApp;
    const restore = remember && always && restoreOnStart;
    const login = restore && startAtLogin;
    const discovery = remember && discoverWindows;
    const details = [
      `Allow authenticated MCP clients in this workspace to view and operate “${target.title}” ${always ? 'until stopped (no timer)' : 'for 10 minutes'}?`,
      remember ? `Remember this exact executable. Previously approved apps can be selected without another prompt. Changed executables need approval again.
記住此程式；可切換先前批准程式的視窗，程式檔變更後須重新批准。` : `This session only; revoke older remembered permissions for this workspace.
只限此會話，並撤銷此工作區先前的已記住授權。`,
      restore ? `Restore this approval and the saved authenticated MCP service/tunnel after app restart. No target application is launched.
重啟本程式後，恢復授權及 MCP 服務／隧道；不會啟動其他程式。` : '',
      login ? `Also start this app at Windows sign-in (current user).
亦在目前使用者登入 Windows 時啟動本程式。` : '',
      discovery ? `Allow discovery of ALL visible desktop window titles/PIDs, including background/minimized windows. Listing does not authorize their contents or input.
允許探索桌面所有可見視窗的標題／PID，包括背景及縮小視窗，但不代表已授權操作或讀取內容。` : '',
      `Screenshots remain in RAM. Windows mouse/keyboard input still uses the foreground. The visible monitor and Stop remain required. Stop/Pause suspend auto-restore. Ctrl+Alt+Escape stops control.
截圖只留在記憶體，Windows 鍵鼠仍使用前台。停止／暫停會暫停自動恢復，Ctrl+Alt+Escape 可緊急停止。`
    ].filter(Boolean).join('\n\n');
    const accepted = await confirm(details, { title: 'Approve computer access / 批准電腦存取', kind: 'warning' });
    if (!accepted) return;
    busy = true;
    try {
      status = await invoke('computer_local_start', { workspaceId, windowId: target.window_id, pid: target.pid,
        durationSeconds: always ? 0 : 600, alwaysEnabled: always, rememberApp: remember, restoreOnStart: restore,
        startAtLogin: login, discoverWindows: discovery, observeInBackground });
      permission = await invoke('computer_local_permissions', { workspaceId });
      message = 'Monitor opened. Observation stays in the background unless activation is explicitly requested. · 監控已開啟；除非明確要求啟用前台，觀察會留在背景。';
    } catch (e) { message = String(e); }
    finally { busy = false; }
  }
  async function stop() {
    try { await invoke('computer_local_stop'); status = { state: 'stopped' }; permission = await invoke('computer_local_permissions', { workspaceId }); }
    catch(e) { message = String(e); }
  }
  async function forget() {
    const accepted = await confirm(`Revoke remembered apps and Windows sign-in startup? Active computer control will stop.
撤銷已記住程式及登入啟動？目前操作會停止。`, { title: 'Revoke access / 撤銷授權', kind: 'warning' });
    if (!accepted) return;
    try { await invoke('computer_local_forget', { workspaceId }); await refresh(); status = { state: 'stopped' }; }
    catch(e) { message = String(e); }
  }
  onMount(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await invoke('computer_local_poll');
        const saved = await invoke('computer_local_permissions', { workspaceId });
        if (alive) { status = value; permission = saved; }
      } catch { /* No fake desktop state in a browser-only preview. */ }
      if (alive) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  });
</script>
<section class="tx-surface mt-4 rounded-xl border border-[var(--border)] p-5" aria-label="Local computer control">
  <div class="flex items-center justify-between gap-4">
    <div><h3 class="text-base font-semibold">Computer control · 電腦操作</h3><p class="mt-1 text-sm opacity-70">Local Windows tools · Background observation · Memory-only vision</p></div>
    <span class="rounded-full border px-3 py-1 text-xs">{status.state === 'active' ? 'Enabled · 已啟用' : status.state === 'paused' ? 'Paused · 暫停' : 'Off · 關閉'}</span>
  </div>
  <div class="mt-4 flex flex-wrap items-center gap-3">
    <button class="tx-btn-secondary" disabled={busy} onclick={refresh}>Refresh windows · 重新整理</button>
    <select class="min-w-48 max-w-full rounded border bg-[var(--surface)] p-2 text-sm" bind:value={selection} aria-label="Target application">
      <option value="">Choose one window · 選擇視窗</option>
      {#each targets as target}<option value={`${target.window_id}:${target.pid}`}>{target.title} (PID {target.pid})</option>{/each}
    </select>
  </div>
  <fieldset class="mt-4 grid gap-2 text-sm" disabled={busy || status.state !== 'stopped'}>
    <legend class="mb-2 font-medium">Local approval · 本機授權</legend>
    <button type="button" class="tx-btn-secondary" onclick={()=>{alwaysEnabled=true;rememberApp=true;restoreOnStart=true;}}>Long-task preset · 長任務設定</button>
    <p class="text-xs opacity-70">Preset selects Always enabled + Remember app + Restore after restart. Access is granted only after you select a window and confirm Enable. Stop/Pause still suspend restoration. · 設定會勾選持續啟用、記住程式及重啟恢復；選擇視窗並確認啟用後才授權。停止／暫停仍會阻止自動恢復。</p>
    <label><input type="checkbox" bind:checked={alwaysEnabled} /> Always enabled · 持續啟用</label>
    <label><input type="checkbox" bind:checked={rememberApp} /> Remember this exact app · 記住此程式</label>
    <label><input type="checkbox" bind:checked={restoreOnStart} disabled={!rememberApp || !alwaysEnabled} /> Restore after app restart · 重啟後恢復</label>
    <label><input type="checkbox" bind:checked={startAtLogin} disabled={!rememberApp || !alwaysEnabled || !restoreOnStart} /> Start at Windows sign-in · 登入 Windows 時啟動</label>
    <label><input type="checkbox" bind:checked={discoverWindows} disabled={!rememberApp} /> Discover all window titles, including background · 探索所有視窗標題（包括背景）</label>
    <label><input type="checkbox" bind:checked={observeInBackground} /> Start observation without taking focus · 不搶焦點開始觀察</label>
  </fieldset>
  <div class="mt-4 flex flex-wrap gap-3">
    <button class="tx-btn-primary" disabled={busy || !selection || status.state !== 'stopped'} onclick={start}>{alwaysEnabled ? 'Enable until stopped · 啟用直到停止' : 'Enable for 10 min · 啟用 10 分鐘'}</button>
    <button class="tx-btn-secondary" onclick={stop}>Stop · 停止</button>
    {#if permission.remembered}<button class="tx-btn-secondary" onclick={forget}>Revoke remembered apps · 撤銷記住的程式</button>{/if}
  </div>
  {#if status.state !== 'stopped'}<p class="mt-3 text-sm">{durationLabel(status)}</p>{/if}
  <p class="mt-2 text-xs opacity-70">{rememberedGrantLabel(permission)}{permission.approved_apps?.length ? ` · ${permission.approved_apps.length} apps` : ''}</p>
  <p class="mt-3 text-sm opacity-80" role="status">{message}</p>
  <p class="mt-2 text-xs opacity-60">Emergency Stop: Ctrl + Alt + Escape. Observation ≠ background input. Minimized windows can be listed, but are not captured or restored automatically. · 可探索縮小視窗，但不會自動還原或擷取。</p>
  <SandboxControl {workspaceId} />
</section>
