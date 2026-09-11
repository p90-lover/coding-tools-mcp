<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { createWorkspaceRefresh } from "$lib/workspace-refresh";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { open } from "@tauri-apps/plugin-dialog";
  import AppShell from "$lib/components/AppShell.svelte";
  import ToastHost from "$lib/components/ToastHost.svelte";
  import WorkspaceNavItem from "$lib/components/WorkspaceNavItem.svelte";
  import {
    createWorkspace,
    getActionsRuntimeStatus,
    getRuntimeStatus,
    listLinkedProjects,
    listWorkspaces,
    openWorkspaceDirectory,
  } from "$lib/api/workspaces";
  import { workspaceLoadError, workspaceLoaded } from "$lib/control-center/state";
  import {
    actionsRuntimeStates,
    linkedProjectsByWorkspace,
    mcpRuntimeStates,
    workspaces,
  } from "$lib/stores/app";
  import { showToast } from "$lib/stores/toast";
  import { startUiMemoryGuard } from "$lib/ui-memory-guard";
  import { startCloseGuard } from "$lib/close-guard";
  import CloseConfirmDialog from "$lib/components/CloseConfirmDialog.svelte";
  import type { RuntimeState } from "$lib/types";

  let { children } = $props();
  let closeConfirmOpen = $state(false);

  let registryRefresh: ((invalidate?:boolean)=>Promise<void>) | null = null;
  async function refreshWorkspaces(){ await registryRefresh?.(true); }
  async function refreshInitialRuntimeStatus(){
    const items=$workspaces;
    const mcpStates: Record<string, RuntimeState> = {};
    const actionsStates: Record<string, RuntimeState> = {};
    await Promise.all(
      items.map(async (item) => {
        try {
          const [mcp, actions] = await Promise.all([
            getRuntimeStatus(item.id),
            getActionsRuntimeStatus(item.id),
          ]);
          mcpStates[item.id] = mcp.state;
          actionsStates[item.id] = actions.state;
        } catch {
          // Missing status is unknown, never a fabricated stopped/running state.
        }
      }),
    );
    mcpRuntimeStates.set(mcpStates);
    actionsRuntimeStates.set(actionsStates);
  }

  async function addWorkspace() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || Array.isArray(selected)) return;
      const profile = await createWorkspace(selected);
      await refreshWorkspaces();
      goto(`/workspace/${profile.id}`);
    } catch (error) {
      showToast(String(error), {
        title: "添加工作区失败",
        kind: "error",
        duration: 8000,
      });
    }
  }

  function openWorkspace(id: string) {
    goto(`/workspace/${id}`);
  }

  async function openLinkedProject(path: string) {
    try {
      await openWorkspaceDirectory(path);
    } catch (error) {
      showToast(String(error), {
        title: "无法打开 Linked Project",
        kind: "error",
      });
    }
  }

  function openFrpSettings() {
    goto("/settings/frp");
  }

  function openSoftwareSettings() {
    goto("/settings/software");
  }

  function openGeneralSettings() {
    goto("/settings/general");
  }

  function openKeysSettings() {
    goto("/settings/keys");
  }

  onMount(() => {
    if ($page.url.pathname === "/control") return;
    const registry=createWorkspaceRefresh(async()=>{
      const items=await listWorkspaces();
      const linked=await Promise.all(items.map(async item=>[item.id,await listLinkedProjects(item.id)] as const));
      return {items,linked};
    },value=>{
      workspaces.set(value.items);linkedProjectsByWorkspace.set(Object.fromEntries(value.linked));
      workspaceLoaded.set(true);workspaceLoadError.set("");
    },()=>{workspaceLoadError.set("Workspace refresh unavailable; last verified list retained. / 工作區刷新未成功，保留上次已驗證清單。");});
    registryRefresh=registry.run;
    const refresh=()=>{void registry.run(true);};
    window.addEventListener('coding-tools-workspaces-changed',refresh);
    window.addEventListener('focus',refresh);
    const poll=setInterval(()=>{void registry.run(false);},5000);
    const stopGuard = startUiMemoryGuard();
    const stopClose = startCloseGuard(() => {
      closeConfirmOpen = true;
    });
    void (async () => {
      try { await refreshWorkspaces(); await refreshInitialRuntimeStatus(); }
      catch { workspaceLoadError.set("Desktop service unavailable. Open the installed app to load your workspaces. / 桌面服務未連線，請在已安裝程式載入工作區。"); }
    })();
    return () => {
      registryRefresh=null;registry.stop();clearInterval(poll);
      window.removeEventListener("coding-tools-workspaces-changed",refresh);window.removeEventListener("focus",refresh);
      stopGuard();
      stopClose();
    };
  });
</script>

{#if $page.url.pathname === "/control"}
  {@render children()}
{:else}
<AppShell onAddWorkspace={addWorkspace}>
  {#snippet settingsNav()}
    <button
      type="button"
      class="tx-settings-link {$page.url.pathname === '/settings/general' ? 'active' : ''}"
      onclick={openGeneralSettings}
    >
      一般設定
    </button>
    <button
      type="button"
      class="tx-settings-link {$page.url.pathname === '/settings/keys' ? 'active' : ''}"
      onclick={openKeysSettings}
    >
      共用金鑰
    </button>
    <button
      type="button"
      class="tx-settings-link {$page.url.pathname === '/settings/frp' ? 'active' : ''}"
      onclick={openFrpSettings}
    >
      FRP 設定
    </button>
    <button
      type="button"
      class="tx-settings-link {$page.url.pathname === '/settings/software' ? 'active' : ''}"
      onclick={openSoftwareSettings}
    >
      軟體管理
    </button>
  {/snippet}
  {#snippet sidebar()}
    <div class="space-y-1">
      {#each $workspaces as workspace (workspace.id)}
        <WorkspaceNavItem
          workspace={workspace}
          active={$page.url.pathname === `/workspace/${workspace.id}`}
          mcpState={$mcpRuntimeStates[workspace.id] ?? "stopped"}
          actionsState={$actionsRuntimeStates[workspace.id] ?? "stopped"}
          linkedProjects={$linkedProjectsByWorkspace[workspace.id] ?? []}
          onClick={() => openWorkspace(workspace.id)}
          onOpenProject={(path) => void openLinkedProject(path)}
        />
      {/each}
    </div>
  {/snippet}

  {#snippet children()}
    {@render children()}
  {/snippet}
</AppShell>

<ToastHost />
<CloseConfirmDialog
  open={closeConfirmOpen}
  onCancel={() => {
    closeConfirmOpen = false;
  }}
/>

{/if}
