<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { locale } from '$lib/control-center/state';
  import { translated as t } from '$lib/control-center/model';
  type Preview = {
    provider: string; source_sha256: string; applied: false;
    proposed: { permission_mode: string | null; approval_mode: string | null; network_allowed: boolean | null };
    proposed_roots: string[]; rules: Record<'deny' | 'ask' | 'allow', number>; diagnostics: string[];
  };
  let provider = $state('codex');
  let content = $state('');
  let busy = $state(false);
  let error = $state('');
  let result = $state<Preview | null>(null);
  async function preview() {
    if (busy) return;
    error = ''; result = null;
    if (!content.trim() || new TextEncoder().encode(content).byteLength > 65536) {
      error = t($locale, 'Paste a configuration of at most 64 KiB.', '請貼上不超過 64 KiB 的設定。'); return;
    }
    busy = true;
    try {
      result = await invoke<Preview>('provider_config_preview', { provider, content });
      content = '';
    } catch {
      error = t($locale, 'The configuration could not be parsed. Check the format; no settings were applied.', '無法解析設定，請檢查格式；沒有套用任何設定。');
    } finally { busy = false; }
  }
</script>

<section class="cc-panel config-preview" aria-labelledby="provider-config-heading">
  <header><h2 id="provider-config-heading">{t($locale, 'Reuse your coding-tool configuration', '重用編碼工具設定')}</h2>
    <p>{t($locale, 'Preview Codex TOML or Claude Code JSON locally. This does not start an agent or change tool permissions.', '在本機預覽 Codex TOML 或 Claude Code JSON，不會啟動 Agent 或變更工具權限。')}</p></header>
  <form class="cc-form" onsubmit={(event) => { event.preventDefault(); void preview(); }}>
    <label>{t($locale, 'Configuration format', '設定格式')}
      <select bind:value={provider} disabled={busy} onchange={() => { result = null; error = ''; }}>
        <option value="codex">Codex · config.toml</option><option value="claude">Claude Code · settings.json</option>
      </select>
    </label>
    <label>{t($locale, 'Configuration content', '設定內容')}
      <textarea bind:value={content} disabled={busy} rows="5" maxlength="65536" spellcheck="false" autocomplete="off"
        placeholder={provider === 'codex' ? 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"' : '{"permissions":{"defaultMode":"acceptEdits"}}'}></textarea>
    </label>
    <p class="cc-help">{t($locale, 'Do not paste API keys. Hook bodies, environment values and command patterns are not displayed or activated. Input is not saved and is cleared after a successful read.', '請勿貼上 API 金鑰。Hook 內容、環境變數值及指令規則不會顯示或啟用；輸入不會儲存，讀取成功後會清空。')}</p>
    <button class="cc-button secondary" disabled={busy || !content.trim()}>{t($locale, busy ? 'Reading configuration…' : 'Preview compatibility', busy ? '讀取設定中…' : '預覽相容性')}</button>
  </form>
  {#if error}<p class="cc-notice red" role="alert">{error}</p>{/if}
  {#if result}
    <div class="cc-notice amber" role="status">{t($locale, 'Preview only — not applied. Review workspace permissions, additional roots and managed restrictions before activation.', '僅供預覽，尚未套用。啟用前須核對工作區權限、額外目錄及管理政策限制。')}</div>
    <dl>
      <dt>{t($locale, 'Proposed filesystem mode', '建議檔案系統模式')}</dt><dd>{result.proposed.permission_mode ?? t($locale, 'Needs review', '需要核對')}</dd>
      <dt>{t($locale, 'Approval mode', '批准模式')}</dt><dd>{result.proposed.approval_mode ?? t($locale, 'Unspecified', '未指定')}</dd>
      <dt>{t($locale, 'Network access', '網絡存取')}</dt><dd>{result.proposed.network_allowed === null ? t($locale, 'Unspecified', '未指定') : result.proposed.network_allowed ? t($locale, 'Requested', '已提出要求') : t($locale, 'Disabled in source', '來源設定為停用')}</dd>
      <dt>{t($locale, 'Rules requiring translation', '需要轉換的規則')}</dt><dd>Deny {result.rules.deny} · Ask {result.rules.ask} · Allow {result.rules.allow}</dd>
      <dt>{t($locale, 'Additional roots to review', '待核對的額外目錄')}</dt><dd>{result.proposed_roots.length}</dd>
    </dl>
    <p class="cc-help">{t($locale, '“Never” does not grant full access. Provider sandbox modes are not automatically equivalent to this app’s execution boundary.', '「Never」不代表完整存取權；供應商 Sandbox 模式亦不會被視為自動等同本程式的執行邊界。')}</p>
    <details><summary>{t($locale, 'Compatibility details', '相容性詳情')}</summary>
      <p class="hash">SHA-256: {result.source_sha256}</p>
      {#each result.diagnostics as diagnostic}<p class="diagnostic">{diagnostic}</p>{/each}
    </details>
  {/if}
</section>

<style>
  .config-preview { padding: 24px; margin-top: 20px; }
  header p { margin: 8px 0 20px; opacity: .75; }
  textarea { font-family: monospace; resize: vertical; min-height: 120px; }
  dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 20px; margin: 20px 0; }
  dt { opacity: .75; } dd { margin: 0; overflow-wrap: anywhere; }
  .hash, .diagnostic { font-family: monospace; overflow-wrap: anywhere; font-size: .8rem; }
  @media (max-width: 640px) { dl { grid-template-columns: 1fr; } dd { margin-bottom: 10px; } }
</style>
