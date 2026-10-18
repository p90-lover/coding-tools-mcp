import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const API = import.meta.env.VITE_API_BASE || '/api'
export const API_BASE = API

export const BLOCKED_ACCOUNT_STATUS_LABELS: Record<string, string> = {
  fraud_guard: '风控拦截',
  rate_limit_exceeded: '手机号限流',
}

export const BLOCKED_ACCOUNT_STATUS_REASONS: Record<string, string> = {
  fraud_guard: '风控拦截 · 需人工审核',
  rate_limit_exceeded: '手机号限流 · 需人工处理',
}

export const BLOCKED_ACCOUNT_STATUS_CODES = Object.freeze([
  'fraud_guard',
  'rate_limit_exceeded',
] as const)

export function isBlockedAccountStatus(value: unknown): boolean {
  return BLOCKED_ACCOUNT_STATUS_CODES.includes(String(value || '').trim() as (typeof BLOCKED_ACCOUNT_STATUS_CODES)[number])
}

export function getAccountStatusLabel(value: unknown): string {
  const status = String(value || '').trim()
  return BLOCKED_ACCOUNT_STATUS_LABELS[status] || status
}

export function getBlockedAccountStatusReason(value: unknown): string {
  const status = String(value || '').trim()
  return BLOCKED_ACCOUNT_STATUS_REASONS[status] || ''
}

export const BLOCKED_ACCOUNT_STATUS_FILTER_OPTIONS = [
  { value: 'fraud_guard', label: '风控拦截' },
  { value: 'rate_limit_exceeded', label: '手机号限流' },
] as const

export function getAuthToken(): string {
  const token = localStorage.getItem('_auth_token') || ''
  if (!token) return ''
  try {
    new Headers({ Authorization: `Bearer ${token}` })
  } catch {
    setAuthToken('')
    return ''
  }
  return token
}
export function setAuthToken(token: string) {
  if (token) localStorage.setItem('_auth_token', token)
  else localStorage.removeItem('_auth_token')
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) },
  })
  if (res.status === 401 && !path.startsWith('/auth/')) {
    setAuthToken('')
    window.location.reload()
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function apiDownload(path: string, opts?: RequestInit) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      ...(opts?.body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...(opts?.headers || {}),
    },
  })
  if (res.status === 401) {
    setAuthToken('')
    window.location.reload()
    throw new Error('Unauthorized')
  }
  if (!res.ok) {
    const body = await res.text()
    let detail: unknown
    try { detail = JSON.parse(body)?.detail } catch { /* Plain-text error. */ }
    throw new Error(typeof detail === 'string' ? detail : body)
  }
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') || ''
  const extended = disposition.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i)?.[1]
  const plain = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/i)
  let filename = plain?.[1]?.replace(/\\(.)/g, '$1') || plain?.[2]?.trim() || 'download'
  if (extended) {
    try { filename = decodeURIComponent(extended.trim()) } catch { /* Keep the plain filename or default. */ }
  }
  return { blob, filename }
}

export function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
