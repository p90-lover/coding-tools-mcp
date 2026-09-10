<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  type Report = {
    profile: string; configured_profile: string; server_version: string;
    evidence_source: string; registered_count: number; advertised_count: number;
    advertised_names: string[]; hidden_by_profile: string[]; catalog_sha256: string;
    advertised_but_unavailable: string[]; read_only_hint_count: number; write_hint_count: number;
  };
  let { workspaceId, profile }: {workspaceId: string; profile: string} = $props();
  let report = $state<Report | null>(null);
  let busy = $state(false);
  let error = $state('');
  let mounted = $state(false);
  let generation = 0;
  onMount(() => { mounted=true; return () => { mounted=false; generation++; }; });
  async function refresh() {
    const ticket=++generation;
    const id=workspaceId;
    busy=true;error='';
    try {
      const result=await invoke<Report>('get_tool_catalog_status',{id});
      if(mounted && ticket===generation && id===workspaceId) report=result;
    } catch(e) {
      if(mounted && ticket===generation && id===workspaceId) {report=null;error=String(e);}
    } finally {
      if(mounted && ticket===generation) busy=false;
    }
  }
  $effect(() => {
    workspaceId;profile;
    if(!mounted) return;
    report=null;
    void refresh();
  });
</script>

<section class="grid gap-2 rounded-md border border-[var(--color-border)] p-3" aria-label="Tool exposure diagnostics / 工具公開診斷">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <strong class="text-sm">Tool exposure / 工具公開狀態</strong>
    <button type="button" onclick={refresh} disabled={busy} class="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-50">{busy ? 'Checking / 檢查中…' : 'Check catalog / 檢查目錄'}</button>
  </div>
  {#if report}
    <p class="text-sm" data-testid="catalog-count">{report.advertised_count} / {report.registered_count} registered definitions / 已註冊工具定義 · {report.profile}</p>
    <p class="text-xs text-[var(--color-text-muted)]">{report.evidence_source === 'running_listener' ? 'Source: running MCP listener / 來源：運行中的 MCP' : 'MCP is not running; saved configuration only / MCP 未運行；只顯示已存設定'} · v{report.server_version}</p>
    {#if report.hidden_by_profile.length}
      <p role="status" class="text-xs">This profile hides {report.hidden_by_profile.length} registered tools. Choose Advanced / Full in Runtime policy and Save to advertise them; execution permissions remain unchanged. / 此目錄隱藏 {report.hidden_by_profile.length} 個已註冊工具。請在執行策略選 Advanced／Full 並儲存；執行權限不會因此提高。</p>
      <details><summary class="cursor-pointer text-xs">Hidden by profile / 被目錄隱藏的工具</summary><p class="break-words font-mono text-xs">{report.hidden_by_profile.join(', ')}</p></details>
    {:else}
      <p class="text-xs">This profile includes every registered definition. / 此設定包含所有已註冊工具定義。</p>
    {/if}
    <details><summary class="cursor-pointer text-xs">Advertised names / 公開的工具名稱</summary><p class="break-words font-mono text-xs">{report.advertised_names.join(', ')}</p></details>
    <p class="break-all font-mono text-xs" data-testid="catalog-fingerprint">SHA-256: {report.catalog_sha256}</p>
    <p class="text-xs text-[var(--color-text-muted)]">Metadata hints: {report.read_only_hint_count} read-only; {report.write_hint_count} write-capable. These are not approvals. / 中繼資料提示：{report.read_only_hint_count} 個唯讀、{report.write_hint_count} 個可變更；不代表已授權。</p>
    {#if report.advertised_but_unavailable.length}
      <p class="text-xs">Advertised but unavailable in this build / 有定義但本版不可執行：{report.advertised_but_unavailable.join(', ')}.</p>
    {/if}
  {/if}
  {#if error}<p role="alert" class="break-words text-xs">{error}</p>{/if}
  <p class="text-xs text-[var(--color-text-muted)]">ChatGPT loaded tools: unknown. This check does not contact ChatGPT. After a catalog change, refresh the existing connection in ChatGPT Plugins, enable the required actions and select the connection in your chat. Published metadata may require administrator review. / ChatGPT 已載入的工具：未知。本檢查不會連接 ChatGPT。目錄變更後，請於 ChatGPT Plugins 刷新既有連接、啟用所需操作，並在對話選擇該連接；已發佈的設定可能需要管理員審查。</p>
  <p class="text-xs text-[var(--color-text-muted)]">Missing implementations are not a visibility setting. Paseo/Anneal autonomous engines and unexposed internal Codex APIs are not enabled by Full. / 未實作的功能不是顯示設定；Full 不會啟用 Paseo／Anneal 自主引擎或尚未公開的 Codex 內部 API。</p>
</section>
