<script lang="ts">
  import { FolderInput, FolderOpen, Plus } from "@lucide/svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { openWorkspaceDirectory } from "$lib/api/workspaces";
  import { showToast } from "$lib/stores/toast";
  import type { LinkedProject } from "$lib/types";

  interface Props {
    name: string;
    path: string;
    linkedProjects?: LinkedProject[];
    onSave: (name: string) => void | Promise<void>;
    onUpdatePath: (path: string) => void | Promise<void>;
    onQuickAddProject?: (path: string) => void | Promise<void>;
  }

  let {
    name,
    path,
    linkedProjects = [],
    onSave,
    onUpdatePath,
    onQuickAddProject,
  }: Props = $props();

  let draftName = $state("");
  let saving = $state(false);
  let opening = $state(false);
  let updatingPath = $state(false);
  let quickAdding = $state(false);

  const dirty = $derived(draftName.trim() !== name && draftName.trim().length > 0);

  $effect(() => {
    draftName = name;
  });

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    try {
      await onSave(draftName.trim());
    } finally {
      saving = false;
    }
  }

  async function openDirectory(target = path) {
    if (opening || !target.trim()) return;
    opening = true;
    try {
      await openWorkspaceDirectory(target);
    } catch (error) {
      showToast(String(error), {
        kind: "error",
        title: "无法打开目录",
      });
    } finally {
      opening = false;
    }
  }

  function normalizePath(value: string): string {
    return value.trim().replace(/[\\/]+$/, "");
  }

  async function updateDirectory() {
    if (updatingPath) return;
    updatingPath = true;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: path.trim() || undefined,
      });
      if (!selected || Array.isArray(selected)) return;
      const nextPath = normalizePath(selected);
      if (!nextPath || nextPath === normalizePath(path)) return;
      await onUpdatePath(nextPath);
    } catch (error) {
      showToast(String(error), {
        kind: "error",
        title: "无法更新目录",
      });
    } finally {
      updatingPath = false;
    }
  }

  async function quickAddProject() {
    if (quickAdding || !onQuickAddProject) return;
    quickAdding = true;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) return;
      await onQuickAddProject(normalizePath(selected));
    } catch (error) {
      showToast(String(error), {
        kind: "error",
        title: "添加 Linked Project 失败",
        duration: 8000,
      });
    } finally {
      quickAdding = false;
    }
  }
</script>

<form
  class="flex flex-col gap-3 sm:flex-row sm:items-end"
  onsubmit={(event) => {
    event.preventDefault();
    void save();
  }}
>
  <label class="tx-field min-w-0 flex-1">
    <span class="tx-label">工作区名称</span>
    <input type="text" class="tx-input" bind:value={draftName} />
  </label>
  <div class="tx-field min-w-0 flex-1">
    <span class="tx-label">路径</span>
    <div class="flex min-w-0 items-center gap-2">
      <p
        class="tx-mono min-w-0 flex-1 truncate rounded-[10px] border border-transparent px-2.5 py-2 text-[var(--color-text-secondary)]"
        title={path}
      >
        {path}
      </p>
      <button
        type="button"
        class="tx-btn-ghost shrink-0 px-2.5 py-1.5 text-xs"
        disabled={opening || !path.trim()}
        onclick={() => void openDirectory()}
      >
        <FolderOpen size={14} class="inline-block" />
        <span class="ml-1">{opening ? "打开中…" : "打开目录"}</span>
      </button>
      <button
        type="button"
        class="tx-btn-ghost shrink-0 px-2.5 py-1.5 text-xs"
        disabled={updatingPath}
        onclick={() => void updateDirectory()}
      >
        <FolderInput size={14} class="inline-block" />
        <span class="ml-1">{updatingPath ? "选择中…" : "更新目录"}</span>
      </button>
    </div>
  </div>
  <button type="submit" class="tx-btn-primary shrink-0" disabled={saving || !dirty}>
    {saving ? "保存中…" : "保存名称"}
  </button>
</form>

<div class="mt-3 rounded-[12px] border border-[var(--color-border)] p-3">
  <div class="flex items-center justify-between gap-3">
    <div>
      <p class="text-sm font-medium">Linked Projects</p>
      <p class="mt-0.5 text-xs text-[var(--color-text-muted)]">
        同一个 MCP Workspace 可安全连接其他硬盘或 Workspace 外目录。
      </p>
    </div>
    <button
      type="button"
      class="tx-btn-ghost shrink-0 px-2.5 py-1.5 text-xs"
      disabled={quickAdding || !onQuickAddProject}
      onclick={() => void quickAddProject()}
    >
      <Plus size={14} class="inline-block" />
      <span class="ml-1">{quickAdding ? "添加中…" : "Quick Add Project"}</span>
    </button>
  </div>

  {#if linkedProjects.length > 0}
    <div class="mt-3 grid gap-2">
      {#each linkedProjects as project (project.alias)}
        <button
          type="button"
          class="flex min-w-0 items-center gap-2 rounded-[10px] border border-[var(--color-border)] px-3 py-2 text-left hover:bg-[var(--color-surface-hover)]"
          title={project.path}
          onclick={() => void openDirectory(project.path)}
        >
          <FolderOpen size={14} class="shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{project.name}</span>
            <span class="tx-mono block truncate text-[11px] text-[var(--color-text-muted)]">
              @{project.alias} · {project.path}
            </span>
          </span>
          <span class="shrink-0 text-[10px] uppercase text-[var(--color-text-muted)]">
            {project.mode}
          </span>
        </button>
      {/each}
    </div>
  {:else}
    <p class="mt-3 text-xs text-[var(--color-text-muted)]">
      尚未添加 linked project。点击 Quick Add Project 选择任意其他硬盘目录。
    </p>
  {/if}
</div>
