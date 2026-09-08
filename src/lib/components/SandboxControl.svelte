<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { confirm } from '@tauri-apps/plugin-dialog';
  let { workspaceId }: { workspaceId: string } = $props();
  let status=$state<any>({available:false});let busy=$state(false);let message=$state('');
  async function refresh(){try{status=await invoke('sandbox_local_status',{workspaceId});}catch(e){message=String(e);}}
  async function prepare(){
    if(!await confirm(`Prepare the native OS sandbox for this workspace? Windows may ask for one-time administrator approval to create separate CodingTools sandbox accounts, mandatory kernel network filters, and read-only capability entries on a fixed set of public Windows runtime files/provider registry keys. Existing owners and deny entries are preserved; no broad filesystem read grant is applied. The sandbox has read-only workspace/platform access and restricted networking. It is not a Codex agent and does not use Codex quota.

為此工作區準備原生沙箱？Windows 可能要求一次管理員授權，以建立獨立 CodingTools 沙箱帳戶、強制核心網絡篩選，以及固定範圍的 Windows 公開執行資源檔案／供應元件登錄項目的唯讀授權。既有擁有者及拒絕項目會保留，不會授予整個檔案系統的讀取權限。沙箱僅可讀取工作區／平台檔案並限制網絡，不啟動 Codex Agent。

This enables only sandbox_exec, not an OS sandbox around desktop input or the existing command tools.
僅適用於 sandbox_exec，不會把桌面輸入或既有命令工具自動放入沙箱。`,{title:'Prepare sandbox / 準備沙箱',kind:'warning'}))return;
    busy=true;
    try{const result=await invoke<any>('sandbox_local_prepare',{workspaceId});message=result.ok?'Sandbox prepared and approved. · 沙箱已準備及批准。':String(result.error??'Preparation did not succeed');await refresh();}catch(e){message=String(e);}finally{busy=false;}
  }
  async function disable(){try{await invoke('sandbox_local_disable',{workspaceId});message='Sandbox permission revoked. Existing OS accounts are preserved. · 已撤銷沙箱授權，既有系統帳戶保留。';await refresh();}catch(e){message=String(e);}}
  onMount(()=>{void refresh();});
</script>
<section class="mt-4 rounded-lg border border-[var(--border)] p-4" aria-label="Native sandbox">
  <h4 class="font-medium">Native command sandbox · 原生命令沙箱</h4>
  <p class="mt-1 text-xs opacity-70">Pinned upstream Codex sandbox library, without Codex CLI/agent inference. Read-only execution in a private desktop; separate from computer-use permissions.</p>
  <div class="mt-3 flex flex-wrap items-center gap-3">
    <button class="tx-btn-secondary" disabled={busy||!status.available} onclick={prepare}>{busy?'Preparing · 準備中':'Prepare / approve · 準備／批准'}</button>
    <button class="tx-btn-secondary" disabled={!status.enabled_for_workspace} onclick={disable}>Disable · 停用</button>
    <span class="text-xs">{status.enabled_for_workspace?'Approved · 已批准':status.available?'Local setup required · 須本機設定':'Not included on this platform/build · 此平台／版本未包含'}</span>
  </div>
  {#if message}<p class="mt-2 text-xs" role="status">{message}</p>{/if}
</section>
