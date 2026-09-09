<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { workspaces, mcpRuntimeStates } from '$lib/stores/app';
  import { locale } from '$lib/control-center/state';
  import { translated as t } from '$lib/control-center/model';
  type Thread = { id: string; status: string; turn_id?: string | null };
  type Snapshot = { connected: boolean; model_usage_enabled: boolean; model?: string;
    requests_used?: number; request_limit?: number; seconds_remaining?: number;
    stop_reason?: string | null; native_identity?: string; threads?: Thread[] };
  type Answer = Thread & { answer: string; answer_truncated: boolean; notice?: string | null };
  let workspaceId = $state('');
  let executable = $state('');
  let sha256 = $state('');
  let codexHome = $state('');
  let model = $state('');
  let consent = $state(false);
  let requestLimit = $state(4);
  let lifetime = $state(300);
  let snapshot = $state<Snapshot | null>(null);
  let selectedThread = $state('');
  let answer = $state<Answer | null>(null);
  let prompt = $state('');
  let error = $state('');
  let busy = $state(false);
  let polling = false;
  let disposed = false;
  let selectionGeneration = 0;
  const active = new Set(['starting', 'inProgress', 'compacting', 'interrupt_requested']);
  function selectionChanged() {
    selectionGeneration += 1;
    snapshot = null; selectedThread = ''; answer = null; error = ''; consent = false;
    void refresh();
  }
  async function refresh() {
    if (!workspaceId || polling || disposed) return;
    const id = workspaceId, generation = selectionGeneration;
    polling = true;
    try {
      const value = await invoke<Snapshot>('codex_local_status', { workspaceId: id });
      if (disposed || generation !== selectionGeneration) return;
      snapshot = value;
      if (selectedThread) {
        const threadId = selectedThread;
        const result = await invoke<Answer>('codex_local_read', { workspaceId: id, threadId });
        if (!disposed && generation === selectionGeneration && threadId === selectedThread) answer = result;
      }
    } catch (e) {
      if (!disposed && generation === selectionGeneration) {
        snapshot = null;
        error = String(e);
      }
    } finally { polling = false; }
  }
  async function connect() {
    if (busy || !workspaceId) return;
    busy = true; error = '';
    const id = workspaceId, generation = selectionGeneration;
    try {
      const result = await invoke<Snapshot>('codex_local_connect', { workspaceId: id, connection: {
        executable: executable.trim(), expected_sha256: sha256.trim(), codex_home: codexHome.trim(),
        allow_model_usage: consent, model: model.trim(), request_limit: requestLimit, lifetime_seconds: lifetime,
      }});
      if (generation === selectionGeneration && !disposed) snapshot = result;
    } catch (e) { if (generation === selectionGeneration && !disposed) error = String(e); }
    finally { busy = false; }
  }
  async function stop() {
    const id = workspaceId;
    if (!id) return;
    // Stop is deliberately usable while another local request is waiting for native RPC.
    try {
      await invoke('codex_local_disconnect', { workspaceId: id });
      if (id === workspaceId && !disposed) { snapshot = null; answer = null; selectedThread = ''; consent = false; }
    } catch (e) { if (id === workspaceId && !disposed) error = String(e); }
  }
  async function control(operation: string) {
    if (busy || !workspaceId) return;
    busy = true; error = '';
    const generation = selectionGeneration, id = workspaceId;
    const args: Record<string, string> = { operation, request_id: crypto.randomUUID() };
    if (operation !== 'start') args.thread_id = selectedThread;
    if (['start', 'send', 'review'].includes(operation)) args.text = prompt;
    try {
      const result = await invoke<{ ok: boolean; thread_id?: string; error?: unknown }>('codex_local_control', { workspaceId: id, args });
      if (disposed || generation !== selectionGeneration) return;
      if (!result.ok) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? result));
      if (result.thread_id) selectedThread = result.thread_id;
      prompt = '';
      await refresh();
    } catch (e) {
      if (!disposed && generation === selectionGeneration) error = `${String(e)} — ${t($locale, 'Inspect state; do not resubmit an unknown outcome.', '請先檢查狀態，不要重送結果不明的操作。')}`;
    } finally { busy = false; }
  }
  onMount(() => {
    disposed = false;
    const timer = setInterval(() => { if (snapshot?.connected) void refresh(); }, 1200);
    return () => { disposed = true; clearInterval(timer); };
  });
</script>

<section class="cc-panel native-panel" aria-labelledby="native-codex-title">
  <div class="native-heading">
    <div><h2 id="native-codex-title">{t($locale, 'Native Codex sessions', '原生 Codex 會話')}</h2>
      <p>{t($locale, 'Optional App Server connection · disabled until local consent', '可選 App Server 連接 · 本機同意前保持停用')}</p></div>
    <button class="cc-button danger" type="button" disabled={!workspaceId} onclick={() => void stop()}>{t($locale, 'Stop & disconnect all native threads', '停止並斷開所有原生會話')}</button>
  </div>
  <div class="cc-notice">
    <span>{t($locale,
      'This starts the native executable you select. Agent turns, review and compaction can spend provider quota. All authenticated clients of this MCP listener share this grant. Existing model-free tools and read-only Paseo/Anneal adapters are separate.',
      '此功能會啟動你選擇的原生程式。Agent 回合、審查及壓縮可能消耗供應商配額；此 MCP 監聽服務的所有已驗證用戶端共用這項授權。現有免模型工具與唯讀 Paseo／Anneal 介接器是分開的。')}</span>
  </div>
  <form class="cc-form" onsubmit={(event) => { event.preventDefault(); void connect(); }}>
    <label>{t($locale, 'Workspace with a running authenticated MCP listener', '已啟動認證 MCP 監聽服務的工作區')}
      <select bind:value={workspaceId} onchange={selectionChanged} disabled={busy} required>
        <option value="">{t($locale, 'Select workspace', '選擇工作區')}</option>
        {#each $workspaces as workspace}<option value={workspace.id}>{workspace.name} · {$mcpRuntimeStates[workspace.id] ?? 'stopped'}</option>{/each}
      </select>
    </label>
    <div class="native-fields">
      <label>{t($locale, 'Installed native Codex executable (absolute path)', '已安裝的原生 Codex 執行檔（絕對路徑）')}<input bind:value={executable} autocomplete="off" spellcheck="false" required disabled={busy || !!snapshot?.connected}/></label>
      <label>SHA-256<input bind:value={sha256} autocomplete="off" spellcheck="false" pattern="[a-fA-F0-9]{64}" required disabled={busy || !!snapshot?.connected}/></label>
      <label>{t($locale, 'Dedicated Codex home outside the workspace', '工作區以外的專用 Codex 主目錄')}<input bind:value={codexHome} autocomplete="off" spellcheck="false" required disabled={busy || !!snapshot?.connected}/></label>
      <label>{t($locale, 'Model ID from your native provider configuration', '原生供應商設定中的模型 ID')}<input bind:value={model} autocomplete="off" spellcheck="false" required disabled={busy || !!snapshot?.connected}/></label>
      <label>{t($locale, 'Model-request limit (not token/cost limit)', '模型請求上限（並非 Token／費用上限）')}<input type="number" bind:value={requestLimit} min="1" max="20" required disabled={busy || !!snapshot?.connected}/></label>
      <label>{t($locale, 'Consent lifetime in seconds', '授權有效秒數')}<input type="number" bind:value={lifetime} min="30" max="900" required disabled={busy || !!snapshot?.connected}/></label>
    </div>
    <label class="native-consent"><input type="checkbox" bind:checked={consent} disabled={busy || !!snapshot?.connected}/><span>{t($locale, 'I authorize native model usage for this connection. Unchecked connects for handshake/status only.', '我授權這次連接使用原生模型；未勾選時只允許握手及查看狀態。')}</span></label>
    <p class="cc-help">{t($locale,
      'Select a trusted native binary, not a shell wrapper. Sign in to the dedicated home separately; no credentials are copied or requested here. Native configuration, logs and provider retention are outside the bridge’s RAM-only response handling. Read-only policy is requested, not an independently verified OS sandbox. Permission changes revoke this connection.',
      '請選擇可信任的原生執行檔，而非 Shell 包裝程式。請另行登入專用主目錄；此處不會複製或索取憑證。原生設定、日誌及供應商保留政策，不屬於介接層僅用記憶體處理回應的保證。此處會要求唯讀權限，但不是獨立驗證的作業系統沙箱；權限變更會撤銷此連接。')}</p>
    <div class="cc-button-row"><button class="cc-button primary" disabled={busy || !!snapshot?.connected || !workspaceId}>{t($locale, busy ? 'Working…' : 'Connect selected native runtime', busy ? '處理中…' : '連接選定的原生執行環境')}</button>
      <button class="cc-button ghost" type="button" disabled={!workspaceId} onclick={() => void refresh()}>{t($locale, 'Refresh state', '重新讀取狀態')}</button></div>
  </form>
  {#if error}<div class="cc-notice red" role="alert">{error}</div>{/if}
  {#if snapshot}
    <p class="native-status" role="status">{snapshot.connected ? t($locale, 'Connected', '已連接') : t($locale, 'Not connected', '未連接')} · {snapshot.requests_used ?? 0}/{snapshot.request_limit ?? requestLimit} · {snapshot.seconds_remaining ?? 0}s · {snapshot.stop_reason ?? snapshot.native_identity ?? ''}</p>
    <div class="cc-form">
      <label>{t($locale, 'Owned native thread', '此連接擁有的原生會話')}<select bind:value={selectedThread} onchange={() => { answer = null; void refresh(); }} disabled={busy}><option value="">{t($locale, 'New thread', '新會話')}</option>{#each snapshot.threads ?? [] as thread}<option value={thread.id}>{thread.id} · {thread.status}</option>{/each}</select></label>
      <label>{t($locale, 'Task or review instructions', '任務或審查指示')}<textarea bind:value={prompt} maxlength="16000" rows="4" disabled={busy || !snapshot.connected}></textarea></label>
      <div class="cc-button-row">
        <button class="cc-button primary" disabled={busy || !snapshot.connected || !snapshot.model_usage_enabled || !prompt.trim()} onclick={() => void control(selectedThread ? 'send' : 'start')}>{t($locale, selectedThread ? 'Send native turn' : 'Start native thread', selectedThread ? '傳送原生回合' : '開始原生會話')}</button>
        <button class="cc-button" disabled={busy || !snapshot.connected || !snapshot.model_usage_enabled || !selectedThread || !prompt.trim()} onclick={() => void control('review')}>{t($locale, 'Native review', '原生審查')}</button>
        <button class="cc-button" disabled={busy || !snapshot.connected || !snapshot.model_usage_enabled || !selectedThread} onclick={() => void control('compact')}>{t($locale, 'Native compaction', '原生壓縮')}</button>
        <button class="cc-button" disabled={busy || !snapshot.connected || !selectedThread} onclick={() => void control('interrupt')}>{t($locale, 'Interrupt turn', '中斷回合')}</button>
        <button class="cc-button ghost" disabled={busy || !snapshot.connected || !selectedThread || !!answer && active.has(answer.status)} onclick={() => void control('close')}>{t($locale, 'Close idle thread', '關閉閒置會話')}</button>
      </div>
    </div>
  {/if}
  {#if answer}<div class="native-answer"><strong>{answer.status} · {answer.turn_id ?? '—'}</strong>{#if answer.notice}<p>{answer.notice}</p>{/if}<pre>{answer.answer}</pre>{#if answer.answer_truncated}<p>{t($locale, 'Response truncated at the 64 KiB bridge limit.', '回應已按介接層 64 KiB 上限截斷。')}</p>{/if}</div>{/if}
</section>

<style>
  .native-panel { padding: 1.5rem; margin-top: 1.5rem; }
  .native-heading { display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
  .native-heading h2 { margin: 0 0 .4rem; } .native-heading p { margin: 0; }
  .native-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: 1rem; }
  .native-consent { display: flex; flex-direction: row; align-items: start; gap: .6rem; }
  .native-consent input { width: auto; margin-top: .25rem; }
  .native-status { overflow-wrap: anywhere; } .native-answer { margin-top: 1rem; }
  .native-answer pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 24rem; overflow: auto; }
</style>
