/**
 * Only real bounded, memory-only frames may reach the preview. Never persist them.
 * @param {Record<string, unknown> | null | undefined} frame
 * @returns {string | null}
 */
export function frameSource(frame) {
  if (!frame || frame.persisted !== false || frame.capture_storage !== 'memory_only') return null;
  if (typeof frame.mime_type !== 'string' || !['image/png', 'image/jpeg'].includes(frame.mime_type)) return null;
  if (typeof frame.base64 !== 'string' || !frame.base64.length || frame.base64.length > 7_000_000) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(frame.base64)) return null;
  return `data:${frame.mime_type};base64,${frame.base64}`;
}
/** @param {Record<string, unknown> | null | undefined} frame @param {number} now */
export function isFrameStale(frame, now = Date.now()) {
  const stamp = Number(frame?.captured_at_unix_ms);
  return !Number.isFinite(stamp) || stamp > now + 1000 || now - stamp > 5000;
}
/** @param {Record<string, unknown> | null | undefined} status */
export function controlLabel(status) {
  if (status?.state === 'unavailable') return 'Status unavailable — use Stop to revoke · 狀態未確認，可按停止撤銷';
  if (status?.state === 'paused') return 'Paused · 已暫停';
  if (status?.state !== 'active') return 'Stopped · 已停止';
  return status.action ? 'ChatGPT / MCP is using your computer · 正在操作電腦' : 'Control enabled · 等待下一個操作';
}

/** @param {Record<string, unknown> | null | undefined} status */
export function durationLabel(status) {
  if (status?.state === 'stopped' || !status) return 'Off · 關閉';
  if (status.always_enabled === true) return 'Always enabled · 持續啟用（直到停止）';
  const seconds = Number(status.remaining_seconds);
  return Number.isFinite(seconds) && seconds >= 0 ? `${Math.floor(seconds)}s` : 'Timed · 限時';
}

/** @param {Record<string, unknown> | null | undefined} grant */
export function rememberedGrantLabel(grant) {
  if (!grant?.remembered) return 'Session only · 僅本次會話';
  if (grant.suspended) return 'Auto-restore suspended · 已暫停自動恢復';
  return grant.restore_on_start ? 'Remembered · Restore after restart · 重啟後恢復' : 'App remembered · 已記住應用程式';
}
/** @param {Record<string, unknown>} entry */
export function windowAvailability(entry) {
  if (entry.minimized) return 'Minimized — not capturable · 已縮小，不能擷取';
  return entry.foreground ? 'Foreground · 前台' : 'Background · 背景';
}
