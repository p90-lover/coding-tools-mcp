<script lang="ts">
  import { onMount } from "svelte";
  import { openUrl } from "$lib/api/app-info";
  import { getRuntimeStatus, startRuntime } from "$lib/api/workspaces";
  import { startTunnel, testTunnel } from "$lib/api/tunnel";
  import { CHATGPT_SETUP_URL, connectionState, normalizeMcpEndpoint } from "$lib/chatgpt-setup.js";
  import type { WorkspaceProfile } from "$lib/types";

  let { workspaceId, profile, publicEndpoint = "" }: { workspaceId: string; profile: WorkspaceProfile; publicEndpoint?: string } = $props();
  let confirmedEndpoint = $state("");
  let preparedEndpoint = $state("");
  let busy = $state(false);
  let message = $state("");
  let mounted = $state(false);
  let sequence = 0;
  const endpoint = $derived(preparedEndpoint || publicEndpoint);
  const connection = $derived(connectionState(endpoint, confirmedEndpoint));
  const key = $derived(`coding-tools-mcp:confirmed-endpoint:${encodeURIComponent(workspaceId)}`);

  onMount(() => { mounted = true; });
  $effect(() => {
    workspaceId;
    if (!mounted) return;
    sequence += 1;
    preparedEndpoint = "";
    busy = false;
    message = "";
    try { confirmedEndpoint = localStorage.getItem(key) ?? ""; } catch { confirmedEndpoint = ""; }
  });

  $effect(() => {
    publicEndpoint;
    preparedEndpoint = "";
  });

  async function prepare() {
    if (busy) return;
    const seq = ++sequence;
    const id = workspaceId;
    const authType = profile.auth.type;
    const tunnelType = profile.tunnel.type;
    busy = true;
    message = "正在準備本機 MCP 與隧道…";
    try {
      if (authType !== "oauth" && authType !== "bearer") throw new Error("請先啟用 OAuth 或 Bearer 認證；不會公開無認證 MCP。");
      let status = await getRuntimeStatus(id);
      if (status.state !== "running") status = await startRuntime(id);
      if (status.state !== "running") throw new Error("MCP 服務未成功啟動。");
      let candidate = status.publicEndpoint;
      if (tunnelType === "cloudflare" || tunnelType === "frp") {
        const tunnel = await startTunnel(id, "mcp");
        if (tunnel.state !== "running") throw new Error("隧道未成功啟動。");
        candidate = `${tunnel.publicUrl.replace(/\/+$/, "")}/mcp`;
        const probe = await testTunnel(id, "mcp");
        if (!probe.success) throw new Error(probe.message || "隧道連線驗證失敗。");
        // A probe may recover a quick tunnel and change its address.
        if (probe.publicUrl) candidate = `${probe.publicUrl.replace(/\/+$/, "")}/mcp`;
      }
      const ready = normalizeMcpEndpoint(candidate);
      if (seq !== sequence || id !== workspaceId) return;
      preparedEndpoint = ready;
      await navigator.clipboard.writeText(ready);
      await openUrl(CHATGPT_SETUP_URL);
      if (seq !== sequence || id !== workspaceId) return;
      message = "MCP 網址已複製並開啟 ChatGPT 設定。請新增／更新 App、掃描工具及完成授權；本程式不會替你按同意。";
    } catch (error) {
      if (seq === sequence && id === workspaceId) message = String(error);
    } finally {
      if (seq === sequence && id === workspaceId) busy = false;
    }
  }

  function confirmConnected() {
    try {
      const value = normalizeMcpEndpoint(endpoint);
      localStorage.setItem(key, value);
      confirmedEndpoint = value;
      message = "已記錄你確認使用的網址；這不是 ChatGPT 連線的自動驗證。";
    } catch (error) { message = String(error); }
  }
</script>

<section class="grid gap-3 rounded-md border border-[var(--color-border)] p-3" aria-label="ChatGPT assisted setup">
  <p class="text-sm font-medium">連接 ChatGPT / Assisted setup</p>
  <p class="text-xs text-[var(--color-text-muted)]">一鍵啟動與驗證已設定的隧道、複製 MCP 網址並開啟 ChatGPT。首次登入、App 建立、工具重新掃描及 OAuth 授權仍由你完成。</p>
  {#if connection.status === "endpoint_changed"}
    <p role="alert" class="text-sm">隧道網址已改變：請更新或重新建立 ChatGPT App 並重新授權。不要沿用舊網址的 Token。</p>
  {:else if connection.status === "endpoint_unchanged"}
    <p class="text-xs text-[var(--color-text-muted)]">網址與你上次確認的一致；普通隧道重啟毋須因網址而重建 App。認證過期或工具變更仍可能需要重新授權／掃描。</p>
  {/if}
  {#if !connection.stable_hostname || profile.tunnel.cloudflare_mode === "quick" && profile.tunnel.type === "cloudflare"}
    <p class="text-xs text-[var(--color-text-muted)]">Quick Tunnel 網址可能改變。長期連接請在隧道設定選 Named Tunnel，填入固定網域及 Cloudflare Token。</p>
  {/if}
  <div class="flex flex-wrap gap-2">
    <button type="button" onclick={prepare} disabled={busy} class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{busy ? "準備中…" : "準備並開啟 ChatGPT"}</button>
    <button type="button" onclick={confirmConnected} disabled={busy || connection.status === "invalid_endpoint"} class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50">我已在 ChatGPT 完成連接</button>
  </div>
  {#if message}<p role="status" class="text-xs break-words">{message}</p>{/if}
</section>
