<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  let { workspaceId }: { workspaceId: string } = $props();
  let message = $state('');
  async function revoke() {
    try {
      await invoke('sandbox_local_disable', { workspaceId });
      message = 'Stored sandbox approval revoked; files and OS accounts are preserved. · 已撤銷儲存的沙箱批准，檔案及系統帳戶保留。';
    } catch (e) { message = String(e); }
  }
  onMount(() => {
    void invoke('sandbox_local_status', { workspaceId }).catch((e) => { message = String(e); });
  });
</script>
<section class="mt-4 rounded-lg border border-[var(--border)] p-4" aria-label="Native sandbox release status">
  <h4 class="font-medium">Native command sandbox · 原生命令沙箱</h4>
  <p class="mt-2 text-xs opacity-80">Not included in this release: Windows runtime/isolation verification has not passed. No sandbox helper or administrator setup can run.</p>
  <p class="mt-1 text-xs opacity-80">此版本未包含：Windows 執行環境／隔離驗證尚未通過，不會執行沙箱輔助程式或管理員設定。</p>
  <p class="mt-2 text-xs opacity-70">Remembered computer control, background observation and RAM-only vision work independently. They are not an OS sandbox around applications.</p>
  <p class="mt-1 text-xs opacity-70">記住電腦操作授權、背景觀察及記憶體視覺功能獨立運作，不代表應用程式已受作業系統沙箱限制。</p>
  <button class="tx-btn-secondary mt-3" onclick={revoke}>Revoke old sandbox approval · 撤銷舊沙箱批准</button>
  {#if message}<p class="mt-2 text-xs" role="status">{message}</p>{/if}
</section>
