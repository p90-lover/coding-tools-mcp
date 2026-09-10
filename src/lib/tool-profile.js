/** Catalog visibility only; never change execution permissions here. */
export const TOOL_PROFILE_OPTIONS = Object.freeze([
  { value: 'core', label: 'Core / 核心工具' },
  { value: 'advanced', label: 'Advanced / Full — 完整工具目錄' },
  { value: 'read-only', label: 'Read-only catalog / 唯讀工具目錄' },
  { value: 'compat-readonly-all', label: 'Compatibility / 完整目錄（如實權限）' },
]);

/** Match the server's canonical values, including legacy full. @param {string} value */
export function normalizeToolProfile(value) {
  switch (value) {
    case 'full':
    case 'advanced': return 'advanced';
    case 'read-only': return 'read-only';
    case 'compat-readonly-all': return 'compat-readonly-all';
    default: return 'core';
  }
}
