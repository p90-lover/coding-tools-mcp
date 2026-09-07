<script lang="ts">
  import type { ActionsConfig } from "$lib/types";

  export interface ActionsPolicyDraft {
    allowedCommands: string;
    maxPatchBytes: number;
    permissionMode: string;
  }

  interface Props {
    allowedCommands: string;
    maxPatchBytes: number;
    permissionMode: string;
    onSave: (draft: ActionsPolicyDraft) => void | Promise<void>;
  }

  const PERMISSION_MODE_OPTIONS = [
    { value: "read-only", label: "只读（Codex）" },
    { value: "workspace-write", label: "工作区写入（Codex）" },
    { value: "danger-full-access", label: "完全访问（Codex）" },
  ] as const;

  function normalizePermissionMode(value: string): string {
    if (value === "safe" || value === "read-only") return "read-only";
    if (value === "dangerous" || value === "danger-full-access") {
      return "danger-full-access";
    }
    if (value === "trusted" || value === "workspace-write") return "workspace-write";
    return "read-only";
  }

  let { allowedCommands, maxPatchBytes, permissionMode, onSave }: Props = $props();

  let draftCommands = $state("");
  let draftMaxPatch = $state(200_000);
  let draftMode = $state("workspace-write");
  let saving = $state(false);

  const dirty = $derived(
    draftCommands !== allowedCommands ||
      draftMaxPatch !== maxPatchBytes ||
      draftMode !== normalizePermissionMode(permissionMode),
  );

  $effect(() => {
    draftCommands = allowedCommands;
    draftMaxPatch = maxPatchBytes;
    draftMode = normalizePermissionMode(permissionMode);
  });

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    try {
      await onSave({
        allowedCommands: draftCommands.trim(),
        maxPatchBytes: draftMaxPatch,
        permissionMode: draftMode,
      });
    } finally {
      saving = false;
    }
  }
</script>

<form
  class="grid gap-3"
  onsubmit={(event) => {
    event.preventDefault();
    void save();
  }}
>
  <label class="grid gap-1">
    <span class="text-xs text-[var(--color-text-muted)]">允许命令（逗号分隔）</span>
    <input
      type="text"
      class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-sm"
      placeholder="pytest,python,cargo,npm,..."
      bind:value={draftCommands}
    />
  </label>
  <label class="grid gap-1">
    <span class="text-xs text-[var(--color-text-muted)]">最大 Patch 字节数</span>
    <input
      type="number"
      min="1024"
      max="5000000"
      class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
      bind:value={draftMaxPatch}
    />
  </label>
  <label class="grid gap-1">
    <span class="text-xs text-[var(--color-text-muted)]">权限模式</span>
    <select
      class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
      bind:value={draftMode}
    >
      {#each PERMISSION_MODE_OPTIONS as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>
  <p class="text-xs text-[var(--color-text-muted)]">
    作用于 Actions gateway 的命令与 patch 边界。read-only 禁止修改；workspace-write 允许 Workspace 内变更；danger-full-access 仍不会绕过管理员提升、受保护仓库路径或 Workspace 外写入的硬性拒绝。
  </p>
  <div class="flex justify-end pt-1">
    <button
      type="submit"
      class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      disabled={saving || !dirty}
    >
      {saving ? "保存中…" : "保存策略"}
    </button>
  </div>
</form>
