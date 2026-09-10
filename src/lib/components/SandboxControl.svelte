<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  let { workspaceId }: { workspaceId: string } = $props();
  type SnapshotStatus = { available: boolean; enabled_for_workspace: boolean; helper_sha256?: string; backend?: string };
  let status = $state<SnapshotStatus | null>(null);
  let consent = $state(false);
  let busy = $state(false);
  let message = $state('');
  let generation = 0;
  async function refresh(id: string, ticket: number) {
    try {
      const result = await invoke<SnapshotStatus>('sandbox_local_status', { workspaceId: id });
      if (ticket === generation && id === workspaceId) status = result;
    } catch (error) { if (ticket === generation && id === workspaceId) message = String(error); }
  }
  $effect(() => {
    const id = workspaceId;
    const ticket = ++generation;
    status = null; consent = false; busy = false; message = '';
    void refresh(id, ticket);
    return () => { generation++; };
  });
  async function change(enable: boolean) {
    if (busy || (enable && (!consent || !status?.available))) return;
    const id = workspaceId;
    const ticket = ++generation;
    busy = true; message = '';
    try {
      if (enable) {
        const result = await invoke<SnapshotStatus>('sandbox_local_prepare', { workspaceId: id });
        if (id === workspaceId && ticket === generation) {
          status = result; consent = false;
          message = 'Approval saved for this workspace and helper. Each launch must still pass native isolation. · 已儲存此工作區與 helper 的授權，每次執行仍須通過原生隔離檢查。';
        }
      } else {
        await invoke('sandbox_local_disable', { workspaceId: id });
        if (id === workspaceId && ticket === generation) {
          consent = false;
          message = 'Stop requested; saved approvals revoked. Owned processes are being terminated; files retained. · 已要求停止並撤銷授權，正在終止所屬程序，檔案保留。';
          await refresh(id, ticket);
        }
      }
    } catch (error) { if (id === workspaceId && ticket === generation) message = String(error); }
    finally { if (id === workspaceId && ticket === generation) busy = false; }
  }
</script>
<section class="mt-4 rounded-lg border border-[var(--border)] p-4" aria-label="Offline snapshot sandbox permissions">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h4 class="font-medium">Offline snapshot sandbox · 離線快照沙箱</h4>
    <span class="rounded border border-[var(--border)] px-2 py-1 text-xs" role="status">
      {status?.enabled_for_workspace ? 'Locally approved · 已本機授權' : status?.available ? 'Not approved · 未授權' : status ? 'Helper unavailable · Helper 不可用' : 'Checking · 檢查中'}
    </span>
  </div>
  <p class="mt-2 text-xs opacity-80">Only <code>sandbox_exec</code>: selected input copies are read-only; output stays in separate scratch. No network, host-workspace writes, model requests or host fallback.</p>
  <p class="mt-1 text-xs opacity-80">僅適用於 <code>sandbox_exec</code>：指定輸入的副本唯讀，輸出保留於獨立暫存區；禁止網路，不寫入原工作區、不呼叫模型，隔離失敗不改用宿主執行。</p>
  <p class="mt-2 text-xs opacity-70">This is a limited Windows AppContainer executor, not the complete Codex sandbox. OS/package-readable files may remain readable. Ordinary command tools and GUI controls are separate. Scratch limits are monitored, not a disk quota.</p>
  <p class="mt-1 text-xs opacity-70">這是受限的 Windows AppContainer 執行器，並非完整 Codex 沙箱；作業系統／套件可讀資源可能仍可讀。一般命令及 GUI 控制另行運作，暫存用量監測不等於硬性磁碟配額。</p>
  <p class="mt-2 text-xs opacity-70">Approval is bound to workspace ID/path, authentication/policy and helper hash. Stop, listener shutdown or policy changes suspend approvals. No automatic import or cleanup; at most 32 retained runs.</p>
  <p class="mt-1 text-xs opacity-70">授權綁定工作區 ID／路徑、認證／策略及 helper 雜湊。停止、關閉 listener 或修改權限會暫停授權。不自動匯入或清理，最多保留 32 次執行。</p>
  {#if status?.available && !status.enabled_for_workspace}
    <label class="mt-3 flex items-start gap-2 text-xs">
      <input type="checkbox" bind:checked={consent} disabled={busy} />
      <span>I allow offline snapshot execution for this workspace under these limits. · 我同意在上述限制下為此工作區執行離線快照。</span>
    </label>
  {/if}
  <div class="mt-3 flex flex-wrap gap-2">
    <button class="tx-btn-primary" disabled={busy || !consent || !status?.available || status.enabled_for_workspace} onclick={() => change(true)}>Save local approval · 儲存本機授權</button>
    <button class="tx-btn-secondary" disabled={busy} onclick={() => change(false)}>Stop all snapshots / revoke · 停止全部快照／撤銷</button>
    <button class="tx-btn-secondary" disabled={busy} onclick={() => refresh(workspaceId, ++generation)}>Refresh status · 更新狀態</button>
  </div>
  {#if status?.helper_sha256}<p class="mt-2 break-all font-mono text-[10px] opacity-60">SHA-256: {status.helper_sha256}</p>{/if}
  {#if message}<p class="mt-2 text-xs" role="status">{message}</p>{/if}
</section>
