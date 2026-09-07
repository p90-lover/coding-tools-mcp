<script lang="ts">
  export interface RuntimePolicyDraft {
    toolProfile: string;
    permissionMode: string;
    approvalMode: string;
    allowedCommands: string;
    workspaceLocalEntries: boolean;
    workspaceScriptExtensions: string;
    allowScreenCapture: boolean;
  }

  interface Props {
    toolProfile: string;
    permissionMode: string;
    approvalMode: string;
    allowedCommands: string;
    workspaceLocalEntries: boolean;
    workspaceScriptExtensions: string;
    allowScreenCapture: boolean;
    onSave: (draft: RuntimePolicyDraft) => void | Promise<void>;
  }

  const TOOL_PROFILE_OPTIONS = [
    { value: "full", label: "完整工具" },
    { value: "read-only", label: "只读工具" },
    { value: "compat-readonly-all", label: "兼容只读" },
  ] as const;

  const APPROVAL_MODE_OPTIONS = [
    { value: "ask", label: "每次變更都詢問" },
    { value: "on-request", label: "按需批准（Codex）" },
    { value: "never", label: "从不批准" },
  ] as const;

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

  function normalizeApprovalMode(value: string): string {
    if (value === "never") return "never";
    if (value === "on-request" || value === "auto-workspace") return "on-request";
    return "ask";
  }

  let { toolProfile, permissionMode, approvalMode, allowedCommands, workspaceLocalEntries, workspaceScriptExtensions, allowScreenCapture = false, onSave }: Props = $props();

  let draftProfile = $state("full");
  let draftMode = $state("workspace-write");
  let draftApprovalMode = $state("on-request");
  let draftCommands = $state("");
  let draftLocalEntries = $state(true);
  let draftExtensions = $state(".exe,.bat,.cmd,.ps1");
  let draftScreenCapture = $state(false);
  let saving = $state(false);

  const dirty = $derived(
    draftProfile !== toolProfile || draftMode !== normalizePermissionMode(permissionMode) || draftApprovalMode !== normalizeApprovalMode(approvalMode) || draftCommands !== allowedCommands || draftLocalEntries !== workspaceLocalEntries || draftExtensions !== workspaceScriptExtensions || draftScreenCapture !== allowScreenCapture,
  );

  $effect(() => {
    draftProfile = toolProfile;
    draftMode = normalizePermissionMode(permissionMode);
    draftApprovalMode = normalizeApprovalMode(approvalMode);
    draftCommands = allowedCommands;
    draftLocalEntries = workspaceLocalEntries;
    draftExtensions = workspaceScriptExtensions;
    draftScreenCapture = allowScreenCapture;
  });

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    try {
      await onSave({ toolProfile: draftProfile, permissionMode: draftMode, approvalMode: draftApprovalMode, allowedCommands: draftCommands.trim(), workspaceLocalEntries: draftLocalEntries, workspaceScriptExtensions: draftExtensions.trim(), allowScreenCapture: draftScreenCapture });
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
    <span class="text-xs text-[var(--color-text-muted)]">工具档位</span>
    <select
      class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
      bind:value={draftProfile}
    >
      {#each TOOL_PROFILE_OPTIONS as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>
  <label class="grid gap-1">
    <span class="text-xs text-[var(--color-text-muted)]">系统命令（逗号分隔）</span>
    <input type="text" class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-sm" placeholder="python,git,curl,powershell,..." bind:value={draftCommands} />
  </label>
  <label class="flex items-center gap-2 text-sm">
    <input type="checkbox" bind:checked={draftLocalEntries} />
    <span>允许执行 Workspace 内本地入口</span>
  </label>
  <label class="grid gap-1">
    <span class="text-xs text-[var(--color-text-muted)]">本地脚本扩展名（逗号分隔）</span>
    <input type="text" class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-sm" placeholder=".exe,.bat,.cmd,.ps1" bind:value={draftExtensions} disabled={!draftLocalEntries} />
  </label>
  <label class="grid gap-1">
    <span class="text-xs text-[var(--color-text-muted)]">批准模式</span>
    <select
      class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
      bind:value={draftApprovalMode}
    >
      {#each APPROVAL_MODE_OPTIONS as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>
  <p class="text-xs text-[var(--color-text-muted)]">
    on-request 会自动执行已批准 Workspace 内的常规变更；网络、删除及敏感解释器写入会改用 request_permissions。never 会直接拒绝这些敏感操作。
  </p>
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
    read-only 会阻止项目修改及大部分命令；workspace-write 允许 Workspace 内写入；danger-full-access 只跳过软批准。管理员提升、受保护仓库路径及 Workspace 外写入仍会硬性拒绝；当前执行边界仍为 policy_only，并非操作系统级 sandbox。
  </p>
  <fieldset class="grid gap-2 rounded-md border border-[var(--color-border)] p-3">
    <legend class="text-sm font-medium">本機視覺工具 / Local vision</legend>
    <label class="flex items-start gap-2 text-sm">
      <input type="checkbox" bind:checked={draftScreenCapture} />
      <span>允許此 Workspace 的 MCP 擷取螢幕、視窗及列出視窗標題</span>
    </label>
    <p class="text-xs text-[var(--color-text-muted)]">預設關閉。啟用後，已連接的客戶端可要求截圖；可能包含私人資料。圖片只在記憶體處理，不會另存檔案或呼叫 Codex／OCR 模型。系統錄屏權限仍須自行授權。儲存後必須重新啟動 MCP；關閉也須重啟才會撤銷執行中服務的權限。</p>
    <p class="text-xs text-[var(--color-text-muted)]">圖片查看、區域裁切、遮蔽、像素比較在本機執行；語意解讀由收到 MCP 圖片的 ChatGPT 負責。此開關不會開放 Actions 的螢幕擷取。</p>
  </fieldset>
  <div class="flex justify-end pt-1">
    <button
      type="submit"
      class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      disabled={saving || !dirty}
    >
      {saving ? "保存中…" : "保存策略"}
    </button>
  </div>
</form>
