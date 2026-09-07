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
  if (status?.state === 'paused') return 'Paused · 已暫停';
  if (status?.state !== 'active') return 'Stopped · 已停止';
  return status.action ? 'ChatGPT / MCP is using your computer · 正在操作電腦' : 'Control enabled · 等待下一個操作';
}
