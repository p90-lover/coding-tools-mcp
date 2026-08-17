<script lang="ts">
  import { FolderOpen } from "@lucide/svelte";
  import ServiceStatusPair from "$lib/components/ServiceStatusPair.svelte";
  import type { LinkedProject, RuntimeState, WorkspaceProfile } from "$lib/types";

  interface Props {
    workspace: WorkspaceProfile;
    active: boolean;
    mcpState: RuntimeState;
    actionsState: RuntimeState;
    linkedProjects?: LinkedProject[];
    onClick: () => void;
    onOpenProject?: (path: string) => void;
  }

  let {
    workspace,
    active,
    mcpState,
    actionsState,
    linkedProjects = [],
    onClick,
    onOpenProject,
  }: Props = $props();
</script>

<div class="tx-nav-item" class:active>
  <button type="button" class="tx-nav-button" onclick={onClick}>
    <ServiceStatusPair mcp={mcpState} actions={actionsState} />
    <span class="min-w-0 flex-1 truncate text-sm font-medium">{workspace.name}</span>
  </button>

  {#if active && linkedProjects.length > 0}
    <div class="pb-1 pl-7 pr-2">
      {#each linkedProjects as project (project.alias)}
        <button
          type="button"
          class="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          title={project.path}
          onclick={(event) => {
            event.stopPropagation();
            onOpenProject?.(project.path);
          }}
        >
          <FolderOpen size={12} class="shrink-0" />
          <span class="min-w-0 flex-1 truncate">{project.name}</span>
          <span class="tx-mono shrink-0 text-[10px] text-[var(--color-text-muted)]">
            @{project.alias}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
