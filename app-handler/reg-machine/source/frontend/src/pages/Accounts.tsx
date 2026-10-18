import { useEffect, useState, useRef, useCallback } from 'react'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Dialog from '@radix-ui/react-dialog'
import { useNavigate, useParams } from 'react-router-dom'
import { getPlatforms } from '@/lib/app-data'


import { apiDownload, apiFetch, BLOCKED_ACCOUNT_STATUS_FILTER_OPTIONS, getAccountStatusLabel, getBlockedAccountStatusReason, triggerBrowserDownload } from '@/lib/utils'

import { TaskLogPanel } from '@/components/tasks/TaskLogPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { getTaskStatusText, getVerificationRecoveryParams, isTerminalTaskStatus, TASK_STATUS_VARIANTS } from '@/lib/tasks'
import type { VerificationHold } from '@/lib/tasks'
import { RefreshCw, Copy, ExternalLink, Download, Upload, Plus, X, Trash2, Zap } from 'lucide-react'

const STATUS_VARIANT: Record<string, any> = {
  registered: 'default', trial: 'success', subscribed: 'success',
  expired: 'warning', invalid: 'danger', fraud_guard: 'danger', rate_limit_exceeded: 'warning',
  free: 'secondary', eligible: 'secondary', valid: 'success', unknown: 'secondary',
}


function getAccountOverview(acc: any) {
  return acc?.overview || {}
}

function getDisplaySummary(acc: any) {
  return acc?.display_summary && typeof acc.display_summary === 'object' ? acc.display_summary : {}
}

function getVerificationMailbox(acc: any) {
  const providerResources = Array.isArray(acc?.provider_resources) ? acc.provider_resources : []
  const normalized = providerResources.find((item: any) => item?.resource_type === 'mailbox')
  if (normalized) {
    return {
      provider: normalized.provider_name,
      email: normalized.handle || normalized.display_name,
      account_id: normalized.resource_identifier,
    }
  }
  return null
}

function getLifecycleStatus(acc: any) {
  return getDisplaySummary(acc)?.status?.lifecycle || acc?.lifecycle_status || 'registered'
}

function getDisplayStatus(acc: any) {
  const lifecycle = getLifecycleStatus(acc)
  if (lifecycle === 'fraud_guard' || lifecycle === 'rate_limit_exceeded') return lifecycle
  const display = getDisplaySummary(acc)?.status?.display || acc?.display_status || acc?.plan_state || lifecycle
  if (display === 'fraud_guard' || display === 'rate_limit_exceeded') return display
  return display
}

function getPlanState(acc: any) {
  return getDisplaySummary(acc)?.status?.plan_state || acc?.plan_state || acc?.overview?.plan_state || 'unknown'
}

function getValidityStatus(acc: any) {
  return getDisplaySummary(acc)?.status?.validity || acc?.validity_status || acc?.overview?.validity_status || 'unknown'
}

function getCompactStatusMeta(acc: any) {
  const summary = getDisplaySummary(acc)
  const primaryMetrics = Array.isArray(summary?.primary_metrics) ? summary.primary_metrics : []
  if (primaryMetrics.length > 0) {
    return primaryMetrics.slice(0, 2).map((item: any) => {
      const sub = item?.sub ? ` · ${item.sub}` : ''
      return `${item?.label || ''}:${item?.value || '-'}${sub}`
    }).join(' / ')
  }
  const overview = getAccountOverview(acc)
  const parts = [
    `生命周期:${getAccountStatusLabel(getLifecycleStatus(acc))}`,
    `套餐:${getPlanState(acc)}`,
    `有效:${getValidityStatus(acc)}`,
  ]
  const remainingCredits = overview?.remaining_credits
  const usageTotal = overview?.usage_total
  if (remainingCredits || usageTotal) {
    parts.push(`额度:${remainingCredits || '-'} / 已用:${usageTotal || '-'}`)
  }
  return parts.join(' / ')
}

function getPrimaryMetrics(acc: any) {
  const metrics = getDisplaySummary(acc)?.primary_metrics
  return Array.isArray(metrics) ? metrics : []
}

function getSecondaryMetrics(acc: any) {
  const metrics = getDisplaySummary(acc)?.secondary_metrics
  return Array.isArray(metrics) ? metrics : []
}

function getDisplayWarnings(acc: any) {
  const warnings = getDisplaySummary(acc)?.warnings
  return Array.isArray(warnings) ? warnings : []
}

function getDisplayBadges(acc: any) {
  const badges = getDisplaySummary(acc)?.badges
  return Array.isArray(badges) ? badges : []
}

function getDisplaySections(acc: any) {
  const sections = getDisplaySummary(acc)?.sections
  return Array.isArray(sections) ? sections : []
}

function getProviderAccounts(acc: any) {
  return Array.isArray(acc?.provider_accounts) ? acc.provider_accounts : []
}

function getCredentials(acc: any) {
  return Array.isArray(acc?.credentials) ? acc.credentials : []
}

function getCashierUrl(acc: any) {
  const overview = getAccountOverview(acc)
  return overview?.cashier_url || acc?.cashier_url || ''
}

function getPrimaryToken(acc: any) {
  if (acc?.primary_token) return acc.primary_token
  const credential = getCredentials(acc).find((item: any) => item?.scope === 'platform' && item?.credential_type === 'token' && item?.value)
  return credential?.value || ''
}

function buildActionParamDraft(action: any, acc: any) {
  const params = Array.isArray(action?.params) ? action.params : []
  const emailPrefix = String(acc?.email || '').split('@')[0] || 'Development'
  const draft: Record<string, string> = {}
  params.forEach((param: any) => {
    if (action?.id === 'create_api_key' && param?.key === 'name') {
      draft[param.key] = `${emailPrefix}Development`
      return
    }
    draft[param?.key || ''] = Array.isArray(param.options) && param.options.length > 0 ? String(param.options[0]) : ''
  })
  return draft
}




// ── 新增账号弹框 ─────────────────────────────────────────
function AddModal({ platform, onClose, onDone }: { platform: string; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ email: '', password: '', lifecycle_status: 'registered', primary_token: '', cashier_url: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savePendingRef = useRef(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    if (savePendingRef.current) return
    savePendingRef.current = true
    setSaving(true)
    setError('')
    try {
      await apiFetch('/accounts', { method: 'POST', body: JSON.stringify({ ...form, platform }) })
      onDone()
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，请重试')
    } finally {
      savePendingRef.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={value => { if (!value && !savePendingRef.current) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop">
          <Dialog.Content aria-describedby={undefined} aria-label="手动新增账号"
        className="dialog-panel dialog-panel-sm"
            onOpenAutoFocus={() => { returnFocusRef.current = document.activeElement as HTMLElement }}
            onCloseAutoFocus={event => { event.preventDefault(); returnFocusRef.current?.focus() }}
            onEscapeKeyDown={event => { if (savePendingRef.current) event.preventDefault() }}
            onPointerDownOutside={event => { if (savePendingRef.current) event.preventDefault() }}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
              <Dialog.Title asChild><h2 className="text-base font-semibold text-[var(--text-primary)]">手动新增账号</h2></Dialog.Title>
              <button aria-label="关闭" disabled={saving} onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X className="h-4 w-4" /></button>
            </div>
            {error && <p role="alert" className="px-6 pt-4 text-sm text-red-400">{error}</p>}
            <fieldset disabled={saving} className="px-6 py-4 space-y-3">
              {[['email','邮箱','text'],['password','密码','text'],['primary_token','主凭证','text'],['cashier_url','试用链接','text']].map(([k,l,t]) => (
                <div key={k}>
                  <label className="text-xs text-[var(--text-muted)] block mb-1">{l}</label>
                  <input aria-label={l} type={t} value={(form as any)[k]} onChange={e => set(k, e.target.value)} className="control-surface" />
                </div>
              ))}
              <div>
                <label className="text-xs text-[var(--text-muted)] block mb-1">生命周期状态</label>
                <select aria-label="生命周期状态" value={form.lifecycle_status} onChange={e => set('lifecycle_status', e.target.value)} className="control-surface appearance-none">
                  <option value="registered">已注册</option>
                  <option value="trial">试用中</option>
                  <option value="subscribed">已订阅</option>
                </select>
              </div>
            </fieldset>
            <div className="flex gap-3 px-6 py-4 border-t border-[var(--border)]">
              <Button onClick={save} disabled={saving} className="flex-1">{saving ? '保存中...' : '保存'}</Button>
              <Button variant="outline" disabled={saving} onClick={onClose} className="flex-1">取消</Button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function formatResultValue(value: any) {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

function ResultStat({ label, value }: { label: string; value: any }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-sm font-medium text-[var(--text-primary)] break-all">{formatResultValue(value)}</div>
    </div>
  )
}

function metricToneClass(tone?: string) {
  if (tone === 'good') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
  if (tone === 'warning') return 'border-amber-500/25 bg-amber-500/10 text-amber-200'
  if (tone === 'danger') return 'border-red-500/25 bg-red-500/10 text-red-200'
  return 'border-[var(--border)] bg-[var(--bg-hover)] text-[var(--text-primary)]'
}

function metricAccentClass(tone?: string) {
  if (tone === 'good') return 'from-emerald-400/70 to-cyan-300/50'
  if (tone === 'warning') return 'from-amber-300/80 to-orange-300/50'
  if (tone === 'danger') return 'from-red-400/80 to-rose-300/50'
  return 'from-[var(--accent)]/80 to-[var(--accent-strong)]/45'
}

function DisplayMetricCard({ metric, compact = false }: { metric: any; compact?: boolean }) {
  return (
    <div className={`group relative overflow-hidden rounded-lg border px-3.5 py-3 ${metricToneClass(metric?.tone)}`}>
      <div className={`pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-b ${metricAccentClass(metric?.tone)}`} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] opacity-65">{metric?.label || '-'}</div>
          {metric?.sub ? <div className="mt-1 truncate text-[11px] opacity-65">{metric.sub}</div> : null}
        </div>
        <div className={`${compact ? 'text-sm' : 'text-lg'} shrink-0 font-semibold tracking-[-0.03em]`}>{formatResultValue(metric?.value)}</div>
      </div>
      {typeof metric?.percent === 'number' ? (
        <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-black/25">
          <div className={`h-full rounded-full bg-gradient-to-r ${metricAccentClass(metric?.tone)}`} style={{ width: `${Math.max(0, Math.min(100, metric.percent))}%` }} />
        </div>
      ) : null}
    </div>
  )
}

function DisplayWarnings({ warnings }: { warnings: any[] }) {
  if (!warnings.length) return null
  return (
    <div className="space-y-2">
      {warnings.map((item: any, index: number) => (
        <div key={`${item?.key || 'warning'}-${index}`} className={`rounded-xl border px-3 py-2 text-xs ${metricToneClass(item?.tone || 'warning')}`}>
          {item?.message || '-'}
        </div>
      ))}
    </div>
  )
}

function DisplaySections({ sections }: { sections: any[] }) {
  if (!sections.length) return null
  return (
    <div className="space-y-3">
      {sections.map((section: any) => (
        <div key={section?.key || section?.title} className="rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] p-3">
          <div className="text-xs font-semibold text-[var(--text-primary)]">{section?.title || '明细'}</div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {(Array.isArray(section?.items) ? section.items : []).map((item: any, index: number) => (
              <div key={`${item?.title || 'item'}-${index}`} className="rounded-lg border border-[var(--border)] bg-black/20 p-3">
                <div className="text-xs font-semibold text-[var(--text-primary)]">{item?.title || '-'}</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[var(--text-secondary)]">
                  {(Array.isArray(item?.metrics) ? item.metrics : []).map((metric: any) => (
                    <div key={metric?.key || metric?.label}>
                      <span className="text-[var(--text-muted)]">{metric?.label || '-'}: </span>
                      <span>{formatResultValue(metric?.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ActionResultHighlights({ payload }: { payload: any }) {
  if (!payload || typeof payload !== 'object') return null

  const stats: Array<{ label: string; value: any }> = []
  if ('valid' in payload) stats.push({ label: '账号有效', value: payload.valid })
  if (payload.membership_type) stats.push({ label: '套餐', value: payload.membership_type })
  if (payload.plan) stats.push({ label: '套餐', value: payload.plan })
  if (payload.plan_id) stats.push({ label: 'Plan ID', value: payload.plan_id })
  if (typeof payload.has_valid_payment_method === 'boolean') stats.push({ label: '已绑卡', value: payload.has_valid_payment_method })
  if ('trial_eligible' in payload) stats.push({ label: '可试用', value: payload.trial_eligible })
  if (payload.trial_length_days) stats.push({ label: '试用天数', value: payload.trial_length_days })
  if (payload.remaining_credits) stats.push({ label: '剩余额度', value: payload.remaining_credits })
  if (payload.usage_total) stats.push({ label: '已用额度', value: payload.usage_total })
  if (payload.plan_credits) stats.push({ label: '总额度', value: payload.plan_credits })
  if (payload.usage_summary?.plan_title) stats.push({ label: 'Kiro 套餐', value: payload.usage_summary.plan_title })
  if ('days_until_reset' in (payload.usage_summary || {})) stats.push({ label: '重置倒计时', value: payload.usage_summary?.days_until_reset })
  if (payload.usage_summary?.next_reset_at) stats.push({ label: '下次重置', value: payload.usage_summary.next_reset_at })
  if ('available' in (payload.portal_session || {})) stats.push({ label: 'Portal 可用', value: payload.portal_session?.available })
  if (payload.desktop_app_state?.app_name) stats.push({ label: '桌面应用', value: payload.desktop_app_state?.app_name })
  if ('running' in (payload.desktop_app_state || {})) stats.push({ label: '桌面已打开', value: payload.desktop_app_state?.running })
  if ('ready' in (payload.desktop_app_state || {})) stats.push({ label: '桌面就绪', value: payload.desktop_app_state?.ready })
  if (payload.key_prefix) stats.push({ label: 'API Key 前缀', value: payload.key_prefix })
  if (payload.key_prefix && payload.name) stats.push({ label: 'Key 名称', value: payload.name })
  if (payload.key_prefix && payload.id) stats.push({ label: 'Key ID', value: payload.id })

  const cursorModels = payload.usage_summary?.models && typeof payload.usage_summary.models === 'object'
    ? Object.entries(payload.usage_summary.models)
    : []
  const kiroBreakdowns = Array.isArray(payload.usage_summary?.breakdowns)
    ? payload.usage_summary.breakdowns
    : []
  const kiroPlans = Array.isArray(payload.usage_summary?.plans)
    ? payload.usage_summary.plans
    : []

  if (stats.length === 0 && cursorModels.length === 0 && kiroBreakdowns.length === 0 && kiroPlans.length === 0 && !payload.quota_note) {
    return null
  }

  return (
    <div className="space-y-4 mb-4">
      {stats.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map(item => <ResultStat key={item.label} label={item.label} value={item.value} />)}
        </div>
      )}

      {cursorModels.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] p-4">
          <div className="text-sm font-semibold text-[var(--text-primary)]">Cursor Usage</div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {cursorModels.map(([model, info]: [string, any]) => (
              <div key={model} className="rounded-lg border border-[var(--border)] bg-black/20 p-3">
                <div className="text-xs font-semibold text-[var(--text-primary)]">{model}</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[var(--text-secondary)]">
                  <div>请求数: {formatResultValue(info?.num_requests)}</div>
                  <div>总请求: {formatResultValue(info?.num_requests_total)}</div>
                  <div>Token: {formatResultValue(info?.num_tokens)}</div>
                  <div>剩余请求: {formatResultValue(info?.remaining_requests)}</div>
                  <div>请求上限: {formatResultValue(info?.max_request_usage)}</div>
                  <div>Token 上限: {formatResultValue(info?.max_token_usage)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {kiroBreakdowns.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] p-4">
          <div className="text-sm font-semibold text-[var(--text-primary)]">Kiro Usage</div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {kiroBreakdowns.map((item: any, index: number) => (
              <div key={`${item.resource_type || item.display_name}-${index}`} className="rounded-lg border border-[var(--border)] bg-black/20 p-3">
                <div className="text-xs font-semibold text-[var(--text-primary)]">{item.display_name || item.resource_type}</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[var(--text-secondary)]">
                  <div>已用: {formatResultValue(item.current_usage)}</div>
                  <div>上限: {formatResultValue(item.usage_limit)}</div>
                  <div>剩余: {formatResultValue(item.remaining_usage)}</div>
                  <div>单位: {formatResultValue(item.unit)}</div>
                  <div>试用状态: {formatResultValue(item.trial_status)}</div>
                  <div>试用到期: {formatResultValue(item.trial_expiry)}</div>
                  <div>试用上限: {formatResultValue(item.trial_usage_limit)}</div>
                  <div>试用剩余: {formatResultValue(item.trial_remaining_usage)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {kiroPlans.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] p-4">
          <div className="text-sm font-semibold text-[var(--text-primary)]">Kiro Plans</div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {kiroPlans.map((plan: any) => (
              <div key={plan.name} className="rounded-lg border border-[var(--border)] bg-black/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-[var(--text-primary)]">{plan.title || plan.name}</div>
                  <div className="text-xs text-emerald-400">{formatResultValue(plan.amount)} {plan.currency || ''}</div>
                </div>
                <div className="mt-1 text-[11px] text-[var(--text-muted)]">{plan.billing_interval || '-'}</div>
                {Array.isArray(plan.features) && plan.features.length > 0 && (
                  <div className="mt-2 text-xs text-[var(--text-secondary)] break-words">
                    {plan.features.join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {payload.quota_note && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          {payload.quota_note}
        </div>
      )}
    </div>
  )
}

function ActionResultModal({
  title,
  payload,
  notice,
  onClose,
}: {
  title: string
  payload: any
  notice?: { type: 'success' | 'error'; text: string } | null
  onClose: () => void
}) {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  const [copyNotice, setCopyNotice] = useState('')
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const copyResult = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopyNotice('已复制')
    } catch {
      setCopyNotice('复制失败，请检查浏览器剪贴板权限')
    }
  }

  return (
    <Dialog.Root open onOpenChange={value => { if (!value) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop">
          <Dialog.Content aria-label={title} className="dialog-panel dialog-panel-lg flex flex-col"

            onOpenAutoFocus={() => { returnFocusRef.current = document.activeElement as HTMLElement }}
            onCloseAutoFocus={event => {
              event.preventDefault()
              const previous = returnFocusRef.current
              if (previous?.isConnected && previous !== document.body && !previous.matches(':disabled')) previous.focus()
              else document.querySelector<HTMLElement>('[data-active-task-dialog]')?.focus()
            }}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 px-6 py-4 border-b border-[var(--border)]">
              <div className="min-w-0 flex-1">
                <Dialog.Title asChild><h2 className="break-all text-base font-semibold text-[var(--text-primary)]">{title}</h2></Dialog.Title>
                <Dialog.Description asChild><p className="text-xs text-[var(--text-muted)] mt-0.5">操作结果</p></Dialog.Description>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void copyResult()}>
                  <Copy className="h-4 w-4 mr-1" />
                  复制
                </Button>
                <button aria-label="关闭" onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {copyNotice ? <p role="status" className="mb-3 text-sm text-[var(--text-secondary)]">{copyNotice}</p>
                : notice ? <p role={notice.type === 'error' ? 'alert' : 'status'} className="mb-3 text-sm text-[var(--text-secondary)]">{notice.text}</p> : null}
              <ActionResultHighlights payload={payload} />
              <pre className="bg-[var(--bg-hover)] border border-[var(--border)] rounded-xl p-4 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-all overflow-auto max-h-[65vh]">
                {content}
              </pre>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function getBatchTaskSummary(task: any) {
  const source = task?.result?.data && typeof task.result.data === 'object'
    ? task.result.data
    : (task?.result && typeof task.result === 'object' ? task.result : (task?.data || task || {}))
  const count = (value: any) => {
    if (Array.isArray(value)) return value.length
    const numeric = Number(value)
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
  }
  const summary = {
    refreshed: count(source?.refreshed),
    skipped: count(source?.skipped),
    failed: count(source?.failed),
    remaining: count(source?.remaining),
    needsUserAction: count(source?.needs_user_action ?? source?.needsUserAction ?? source?.requires_user_action),
  }
  const hasSummary = ['refreshed', 'skipped', 'failed', 'remaining', 'needs_user_action', 'needsUserAction', 'requires_user_action']
    .some(key => source?.[key] !== undefined)
  return hasSummary ? summary : null
}

function ActionTaskModal({
  title,
  taskId,
  taskStatus,
  summary,
  notice,
  visible,
  onClose,
  onDone,
}: {
  title: string
  taskId: string
  taskStatus: string | null
  summary?: any
  notice?: { type: 'success' | 'error'; text: string } | null
  visible: boolean
  onClose: () => void
  onDone: (status: string) => void
}) {
  const [cancelRequested, setCancelRequested] = useState(false)
  const [cancelSubmitting, setCancelSubmitting] = useState(false)
  const cancelPendingRef = useRef(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const closeRequestedRef = useRef(false)
  const [cancelError, setCancelError] = useState('')
  const terminal = isTerminalTaskStatus(taskStatus || '')
  const cancelPending = cancelSubmitting || cancelRequested || taskStatus === 'cancel_requested'
  const batchSummary = getBatchTaskSummary(summary)
  const partial = Boolean(batchSummary && (
    batchSummary.skipped > 0 ||
    batchSummary.failed > 0 ||
    batchSummary.remaining > 0 ||
    batchSummary.needsUserAction > 0
  ))

  const close = () => {
    if (!terminal) return
    closeRequestedRef.current = true
    onClose()
  }

  // Continue monitoring inactive tasks without mounting a hidden modal.
  if (!visible) return <div hidden><TaskLogPanel taskId={taskId} onDone={onDone} /></div>

  const requestCancel = async () => {
    if (terminal || cancelPending || cancelPendingRef.current) return
    cancelPendingRef.current = true
    setCancelSubmitting(true)
    setCancelError('')
    try {
      const response = await apiFetch(`/tasks/${taskId}/cancel`, { method: 'POST' })
      if (response?.ok === false) throw new Error(response.error || '取消任务失败')
      setCancelRequested(true)
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : '取消任务失败，请重试')
    } finally {
      cancelPendingRef.current = false
      setCancelSubmitting(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={value => { if (!value) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop">
          <Dialog.Content
        data-active-task-dialog="" className="dialog-panel flex w-[min(960px,calc(100vw-32px))] max-w-none flex-col overflow-hidden"
        style={{ maxHeight: '90vh' }}

            onOpenAutoFocus={() => { closeRequestedRef.current = false; returnFocusRef.current = document.activeElement as HTMLElement }}
            onCloseAutoFocus={event => {
              event.preventDefault()
              const previous = returnFocusRef.current
              if (closeRequestedRef.current && previous?.isConnected && previous !== document.body && !previous.matches(':disabled')) previous.focus()
            }}
            onEscapeKeyDown={event => { if (!terminal) event.preventDefault() }}
            onPointerDownOutside={event => { if (!terminal) event.preventDefault() }}
          >
            <div className="relative shrink-0 overflow-hidden border-b border-[var(--border)] px-6 py-5">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(9,182,162,0.18),transparent_34%),linear-gradient(90deg,rgba(255,255,255,0.04),transparent)]" />
              <div className="relative flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="mb-2 inline-flex rounded-full border border-[var(--border)] bg-[var(--chip-bg)] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                    Platform Action
                  </div>
                  <Dialog.Title asChild><h2 className="truncate text-lg font-semibold text-[var(--text-primary)]">{title}</h2></Dialog.Title>
                  <Dialog.Description asChild><p className="mt-1 text-xs text-[var(--text-muted)]">任务状态、错误摘要与实时日志集中展示</p></Dialog.Description>
                </div>
                <div className="flex items-center gap-2">
                  {taskStatus ? (
                    <Badge variant={taskStatus === 'succeeded' && partial ? 'warning' : (TASK_STATUS_VARIANTS[taskStatus] || 'secondary')}>
                      {getTaskStatusText(taskStatus)}
                    </Badge>
                  ) : null}
                  <button
                    onClick={close}
                    disabled={!terminal}
                    aria-label={terminal ? '关闭任务' : '任务进行中'}
                    className="rounded-full border border-[var(--border)] bg-[var(--bg-hover)] p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
            {batchSummary ? (
              <div
                role="status"
                aria-live="polite"
                className={`border-b px-6 py-3 text-sm ${partial ? 'border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'}`}
              >
                <div className="font-semibold">{partial ? '批量刷新部分完成' : '批量刷新已完成'}</div>
                <div className="mt-1 text-xs">
                  已刷新 {batchSummary.refreshed} 个 · 跳过 {batchSummary.skipped} 个 · 失败 {batchSummary.failed} 个 · 待处理 {batchSummary.remaining} 个
                  {batchSummary.needsUserAction > 0 ? ` · 需人工处理 ${batchSummary.needsUserAction} 个` : ''}
                </div>
                {batchSummary.skipped > 0 ? <div className="mt-1 text-xs">待注册账号请使用“批量恢复注册”；其他跳过项请查看日志。</div> : null}
                {batchSummary.failed > 0 ? <div className="mt-1 text-xs">失败账号未计入成功，请查看日志后单独重试。</div> : null}
                {batchSummary.remaining > 0 || batchSummary.needsUserAction > 0 ? <div className="mt-1 text-xs">仍有账号未完成，任务结果不视为全部成功。</div> : null}
              </div>
            ) : null}
            {notice ? <div role={notice.type === 'error' ? 'alert' : 'status'}
              className={`shrink-0 border-b px-6 py-2 text-xs ${notice.type === 'error' ? 'border-red-500/30 text-red-200' : 'border-[var(--border)] text-[var(--text-secondary)]'}`}>{notice.text}</div> : null}
            {cancelError ? <div role="alert" className="border-b border-red-500/30 bg-red-500/10 px-6 py-2 text-xs text-red-200">{cancelError}</div> : null}
            {cancelPending && !terminal ? <div role="status" className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-100">{cancelSubmitting ? '正在提交取消请求...' : '取消请求已提交，等待后端返回最终状态；在此之前不会显示为已取消。'}</div> : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <TaskLogPanel taskId={taskId} onDone={onDone} />
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-6 py-3 text-xs text-[var(--text-muted)]">
              <span className="max-w-full break-all">任务 ID: {taskId}</span>
              <div className="flex items-center gap-2">
                {!terminal ? (
                  <Button variant="outline" size="sm" onClick={requestCancel} disabled={cancelPending}>
                    {cancelSubmitting ? '正在提交取消...' : cancelPending ? '取消请求已提交' : '取消任务'}
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" onClick={close} disabled={!terminal}>
                  关闭
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ActionParamsModal({
  action,
  initialValues,
  contextLabel,
  submitting,
  error = '',
  onClose,
  onReturnFocus,
  onSubmit,
}: {
  action: any
  initialValues: Record<string, string>
  contextLabel?: string
  submitting: boolean
  error?: string
  onClose: () => void
  onReturnFocus?: () => void
  onSubmit: (params: Record<string, string>) => void
}) {
  const [form, setForm] = useState<Record<string, string>>(initialValues)

  useEffect(() => {
    setForm(initialValues)
  }, [action?.id, initialValues])

  const params = Array.isArray(action?.params) ? action.params : []

  return (
    <Dialog.Root open onOpenChange={value => { if (!value && !submitting) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop">
          <Dialog.Content
            aria-label={action?.label || '动作参数'} className="dialog-panel dialog-panel-md"
            onEscapeKeyDown={event => { if (submitting) event.preventDefault() }}
            onPointerDownOutside={event => { if (submitting) event.preventDefault() }}
            onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus() } }}
          >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div>
            <Dialog.Title asChild><h2 className="text-base font-semibold text-[var(--text-primary)]">{action?.label || '动作参数'}</h2></Dialog.Title>
            <Dialog.Description asChild><p className="text-xs text-[var(--text-muted)] mt-0.5">填写执行该动作所需的参数</p></Dialog.Description>
            {contextLabel && <p className="mt-1 break-all text-xs text-[var(--text-muted)]">{contextLabel}</p>}
          </div>
          <button aria-label="关闭" disabled={submitting} onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && <p role="alert" className="px-6 pt-4 text-sm text-red-400">{error}</p>}
        <fieldset disabled={submitting} className="px-6 py-4 space-y-4">
          {params.map((param: any) => {
            const value = form[param.key] ?? ''
            if (Array.isArray(param.options) && param.options.length > 0) {
              return (
                <label key={param.key} className="block">
                  <div className="mb-1 text-xs text-[var(--text-muted)]">{param.label || param.key}</div>
                  <select aria-label={param.label || param.key}
                    value={value}
                    onChange={e => setForm(current => ({ ...current, [param.key]: e.target.value }))}
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-2 text-sm outline-none focus:border-[var(--text-accent)]"
                  >
                    {param.options.map((option: string) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
              )
            }
            if (param.type === 'textarea') {
              return (
                <label key={param.key} className="block">
                  <div className="mb-1 text-xs text-[var(--text-muted)]">{param.label || param.key}</div>
                  <textarea aria-label={param.label || param.key}
                    value={value}
                    onChange={e => setForm(current => ({ ...current, [param.key]: e.target.value }))}
                    rows={3}
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-2 text-sm outline-none focus:border-[var(--text-accent)]"
                  />
                </label>
              )
            }
            return (
              <label key={param.key} className="block">
                <div className="mb-1 text-xs text-[var(--text-muted)]">{param.label || param.key}</div>
                <input aria-label={param.label || param.key}
                  type={param.type === 'number' ? 'number' : 'text'}
                  value={value}
                  onChange={e => setForm(current => ({ ...current, [param.key]: e.target.value }))}
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-2 text-sm outline-none focus:border-[var(--text-accent)]"
                />
              </label>
            )
          })}
        </fieldset>
        <div className="px-6 py-4 border-t border-[var(--border)] flex gap-3">
          <Button onClick={() => onSubmit(form)} disabled={submitting} className="flex-1">
            {submitting ? '执行中...' : '执行'}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={submitting} className="flex-1">取消</Button>
        </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
// ── 行操作菜单 ─────────────────────────────────────────────
type AccountActionTask = {
  taskId: string
  title: string
  accountId: number
  actionId: string
  platform: string
  operation: number
  onFinished: () => void
}

type AccountActionOptions = {
  action: any
  params: Record<string, string>
  title: string
  platform: string
  submit: (params: Record<string, any>, operation: number) => Promise<unknown> | undefined
  returnFocus?: () => void
}

function ActionMenu({
  acc, actions, actionsLoading, actionsError, onReloadActions,
  verificationHold, verificationHoldLoading, verificationHoldError,
  runningTaskAction, onActionStart, onTask, onOptions, onError,
  onDetail, onDelete, onResult,
}: {
  acc: any
  actions: any[]
  actionsLoading: boolean
  actionsError: string
  onReloadActions: () => Promise<void>
  verificationHold: VerificationHold | null
  verificationHoldLoading: boolean
  verificationHoldError: string
  runningTaskAction: string | null
  onActionStart: () => number
  onTask: (task: AccountActionTask) => void
  onOptions: (options: AccountActionOptions) => void
  onError: (operation: number, error: string) => void
  onDetail: () => void
  onDelete: () => void
  onResult: (title: string, payload: any, operation: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [localRunning, setRunning] = useState<string | null>(null)
  const running = localRunning || runningTaskAction
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const keyboardMenuOpenRef = useRef(false)
  useEffect(() => {
    const menu = menuRef.current
    if (!open || actionsLoading || !keyboardMenuOpenRef.current || !menu) return
    const active = document.activeElement
    if (active === menu || active === triggerRef.current || active === document.body) {
      menu.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus()
    }
  }, [open, actionsLoading, actions.length])

  const deletePendingRef = useRef(false)
  const actionPendingRef = useRef(false)
  const actionGenerationRef = useRef(0)
  useEffect(() => () => { actionGenerationRef.current += 1 }, [acc.id, acc.platform])

  const recoveryHold = verificationHold?.active ? verificationHold : getAccountOverview(acc)?.legacy_extra?.verification_hold || null
  const recoveryParams = getVerificationRecoveryParams(acc.id, recoveryHold)
  const blockedActionStatus = [
    acc?.lifecycle_status,
    acc?.display_status,
    acc?.display_summary?.status?.lifecycle,
    acc?.display_summary?.status?.display,
  ].find(status => status === 'fraud_guard' || status === 'rate_limit_exceeded') || ''
  const blockedActionReason = getBlockedAccountStatusReason(blockedActionStatus)
  const manualRateRecoveryParams = verificationHold?.active
    ? getVerificationRecoveryParams(acc.id, verificationHold)
    : null
  const manualRateRecoveryAllowed = blockedActionStatus === 'rate_limit_exceeded'
    && verificationHold?.active === true
    && manualRateRecoveryParams !== null

  const deleteAccount = async () => {
    if (deletePendingRef.current || running) return
    setOpen(false)
    if (!confirm(`确认删除 ${acc.email}？`)) return
    deletePendingRef.current = true
    actionGenerationRef.current += 1
    const operation = onActionStart()
    setRunning('delete')
    try {
      await apiFetch(`/accounts/${acc.id}`, { method: 'DELETE' })
      await onDelete()
    } catch (error) {
      onError(operation, error instanceof Error ? error.message : '删除失败，请重试')
    } finally {
      deletePendingRef.current = false
      setRunning(null)
    }
  }

  const runAction = (action: any, params: Record<string, any>, reservedOperation?: number) => {
    if (actionPendingRef.current) return
    const operation = reservedOperation ?? onActionStart()
    const actionBlockedStatus = [
      acc?.lifecycle_status, acc?.display_status,
      acc?.display_summary?.status?.lifecycle, acc?.display_summary?.status?.display,
    ].find(status => status === 'fraud_guard' || status === 'rate_limit_exceeded') || ''
    const actionAllowsManualRateRecovery = actionBlockedStatus === 'rate_limit_exceeded'
      && verificationHold?.active === true
      && getVerificationRecoveryParams(acc.id, verificationHold) !== null
      && params.resume_verification_hold === true
    if (acc.platform === 'chatgpt' && action.id === 'complete_registration'
      && actionBlockedStatus && !actionAllowsManualRateRecovery) {
      const reason = actionBlockedStatus === 'fraud_guard' ? '风控拦截 · 需人工审核' : '手机号限流 · 需人工处理'
      onError(operation, `${reason}，不能更换号码绕过`)
      return
    }
    if (acc.platform === 'chatgpt' && action.id === 'complete_registration'
      && (verificationHoldLoading || verificationHoldError || recoveryParams === null
        || (recoveryHold?.active && params.resume_verification_hold !== true))) {
      onError(operation, verificationHoldError || '手机验证暂停，仅能手动恢复原账号')
      return
    }
    actionPendingRef.current = true
    const generation = ++actionGenerationRef.current
    setRunning(action.id)
    return apiFetch(`/actions/${acc.platform}/${acc.id}/${action.id}`, { method: 'POST', body: JSON.stringify({ params }) })
      .then(resp => {
        const taskId = resp?.task_id || resp?.id
        if (!resp?.sync && resp?.ok !== false && taskId) {
          onTask({
            taskId, title: `${acc.email} · ${action.label}`,
            accountId: acc.id, actionId: action.id, platform: acc.platform, operation,
            onFinished: () => {
              if (generation === actionGenerationRef.current) setRunning(null)
            },
          })
          return
        }
        if (generation === actionGenerationRef.current) setRunning(null)
        if (resp?.ok === false) {
          onError(operation, resp.error || '操作失败，请重试')
        } else if (resp?.sync && resp.ok) {
          onResult(action.label, resp.data, operation)
        } else {
          onError(operation, '未返回执行任务，请刷新后重试')
        }
      })
      .catch((error) => {
        if (generation === actionGenerationRef.current) setRunning(null)
        onError(operation, error instanceof Error ? error.message : '请求失败，请重试')
      })
      .finally(() => { actionPendingRef.current = false })
  }

  return (
    <div className="relative flex min-w-[136px] items-center justify-end gap-1.5 whitespace-nowrap">
      <button onClick={onDetail} data-account-detail-id={acc.id} className="table-action-btn">详情</button>
      {(actions.length > 0 || actionsLoading || actionsError) && (
        <DropdownMenu.Root open={open} modal={false} onOpenChange={value => { setOpen(value); if (value && !actionsLoading) void onReloadActions(); if (!value) keyboardMenuOpenRef.current = false }}>
          <DropdownMenu.Trigger asChild>
            <button ref={triggerRef} data-account-action-id={acc.id} disabled={!!running} title={actionsError || undefined}
              onPointerDown={() => { keyboardMenuOpenRef.current = false }}
              onKeyDown={event => { if (['Enter', ' ', 'ArrowDown'].includes(event.key)) keyboardMenuOpenRef.current = true }}
              className="table-action-btn">更多 ▾</button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              ref={menuRef}
              aria-label="账号操作"
              align="end"
              sideOffset={8}
              collisionPadding={12}
              className="z-[9999] w-[220px] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]/96 py-1.5 shadow-[var(--shadow-soft)]"
              style={{ maxHeight: 'var(--radix-dropdown-menu-content-available-height)' }}
            >
              {actionsLoading && <p role="status" className="px-3 py-2 text-xs text-[var(--text-muted)]">正在加载操作...</p>}
              {actionsError && (
                <div className="px-3 py-2">
                  <p role="alert" className="mb-2 text-xs text-red-400">{actionsError}</p>
                  <DropdownMenu.Item asChild onSelect={event => event.preventDefault()}>
                    <Button size="sm" variant="outline" onClick={() => void onReloadActions()}>重试操作列表</Button>
                  </DropdownMenu.Item>
                </div>
              )}
              {actions.map(a => (
                <DropdownMenu.Item key={a.id} asChild disabled={!!running || actionsLoading || (acc.platform === 'chatgpt' && a.id === 'complete_registration'
                    && ((Boolean(blockedActionStatus) && !manualRateRecoveryAllowed)
                      || verificationHoldLoading || Boolean(verificationHoldError) || recoveryParams === null))}>
                <button
                  onClick={() => {
                    setOpen(false)
                    if (a.id === 'upload_cpa') {
                      const operation = onActionStart()
                      actionGenerationRef.current += 1
                      setRunning(a.id)
                      apiDownload('/accounts/export/cpa', {
                        method: 'POST',
                        body: JSON.stringify({ platform: acc.platform, ids: [acc.id] }),
                      })
                        .then(({ blob, filename }) => {
                          triggerBrowserDownload(blob, filename)
                          onResult(a.label, { message: 'CPA 文件已导出' }, operation)
                        })
                        .catch((error: any) => onError(operation, error?.message || '导出失败'))
                        .finally(() => setRunning(null))
                      return
                    }
                    if (acc.platform === 'chatgpt' && a.id === 'complete_registration' && recoveryHold?.active) {
                      runAction({ ...a, label: '手动恢复手机验证' }, recoveryParams || {})
                      return
                    }
                    if (Array.isArray(a.params) && a.params.length > 0) {
                      onOptions({
                        action: a,
                        params: buildActionParamDraft(a, acc),
                        title: `${acc.email} · ${a.label}`,
                        returnFocus: () => triggerRef.current?.focus(),
                        platform: acc.platform,
                        submit: (params, operation) => runAction(a, params, operation),
                      })
                      return
                    }
                    runAction(a, {})
                  }}
                  disabled={!!running || actionsLoading || (acc.platform === 'chatgpt' && a.id === 'complete_registration'
                    && ((Boolean(blockedActionStatus) && !manualRateRecoveryAllowed)
                      || verificationHoldLoading || Boolean(verificationHoldError) || recoveryParams === null))}
                  title={acc.platform === 'chatgpt' && a.id === 'complete_registration' && blockedActionStatus && !manualRateRecoveryAllowed
                    ? `${blockedActionReason}，不能更换号码绕过`
                    : acc.platform === 'chatgpt' && a.id === 'complete_registration' && blockedActionStatus === 'rate_limit_exceeded' && manualRateRecoveryAllowed
                      ? '仅可手动恢复原账号的手机验证；不会更换号码或自动重试。'
                      : acc.platform === 'chatgpt' && a.id === 'complete_registration' && recoveryHold?.active
                        ? recoveryParams ? '由你手动重试同一账号的手机验证；验证成功前暂停状态会保留，不会自动重试。' : '手机验证已暂停，请在原账号上手动恢复；不能切换账号重试。'
                        : undefined}
                  className="w-full px-3 py-2 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--bg-hover)] disabled:opacity-50">
                  {running === a.id ? (a.id === 'upload_cpa' ? '导出中...' : '执行中...') : a.id === 'upload_cpa' ? '导出 CPA' : acc.platform === 'chatgpt' && a.id === 'complete_registration' && blockedActionStatus === 'rate_limit_exceeded' && manualRateRecoveryAllowed ? '手动恢复手机验证' : acc.platform === 'chatgpt' && a.id === 'complete_registration' && blockedActionStatus && !manualRateRecoveryAllowed ? '需人工审核/处理' : acc.platform === 'chatgpt' && a.id === 'complete_registration' && recoveryHold?.active && recoveryParams ? '手动恢复手机验证' : a.label}
                </button>
                </DropdownMenu.Item>
              ))}
              <div className="my-1 border-t border-[var(--border)]/70" />
              <DropdownMenu.Item asChild disabled={!!running || actionsLoading}>
              <button
                onClick={() => void deleteAccount()}
                disabled={!!running || actionsLoading}
                className="w-full px-3 py-2 text-left text-xs text-[#f0b0b0] transition-colors hover:bg-[rgba(239,68,68,0.08)] hover:text-[#ffd5d5]"
              >
                删除
              </button>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      {actions.length === 0 && !actionsLoading && !actionsError && (
        <button
          onClick={() => void deleteAccount()}
          disabled={!!running}
          className="table-action-btn table-action-btn-danger"
        >
          删除
        </button>
      )}
    </div>
  )
}

// ── 账号详情弹框 ───────────────────────────────────────────
function DetailModal({ acc, onClose, onSave }: { acc: any; onClose: () => void; onSave: () => void }) {
  const initialFormRef = useRef({
    lifecycle_status: getLifecycleStatus(acc),
    primary_token: getPrimaryToken(acc),
    cashier_url: getCashierUrl(acc),
  })
  const [form, setForm] = useState(initialFormRef.current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const savePendingRef = useRef(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const overview = getAccountOverview(acc)
  const verificationMailbox = getVerificationMailbox(acc)
  const providerAccounts = getProviderAccounts(acc)
  const credentials = getCredentials(acc)
  const primaryMetrics = getPrimaryMetrics(acc)
  const secondaryMetrics = getSecondaryMetrics(acc)
  const warnings = getDisplayWarnings(acc)
  const displayBadges = getDisplayBadges(acc)
  const displaySections = getDisplaySections(acc)
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyNotice('已复制')
    } catch {
      setCopyNotice('复制失败，请检查浏览器剪贴板权限')
    }
  }
  const platformCredentials = credentials.filter((item: any) => item.scope === 'platform')

  const save = async () => {
    if (savePendingRef.current) return
    savePendingRef.current = true
    setSaving(true)
    setError('')
    try {
      const patch = Object.fromEntries(
        (Object.keys(initialFormRef.current) as Array<keyof typeof form>)
          .filter(key => form[key] !== initialFormRef.current[key])
          .map(key => [key, form[key]]),
      )
      if (Object.keys(patch).length > 0) {
        await apiFetch(`/accounts/${acc.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      }
      onSave()
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，请重试')
    } finally {
      savePendingRef.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={value => { if (!value && !savePendingRef.current) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop">
          <Dialog.Content aria-label="账号详情" className="dialog-panel dialog-panel-sm flex flex-col" style={{maxHeight:'90vh'}}
            onOpenAutoFocus={() => { returnFocusRef.current = document.activeElement as HTMLElement }}
            onCloseAutoFocus={event => { event.preventDefault(); returnFocusRef.current?.focus() }}
            onEscapeKeyDown={event => { if (savePendingRef.current) event.preventDefault() }}
            onPointerDownOutside={event => { if (savePendingRef.current) event.preventDefault() }}
          >
            {/* ── Sticky Header ── */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0">
              <div>
                <Dialog.Title asChild><h2 className="text-base font-semibold text-[var(--text-primary)]">账号详情</h2></Dialog.Title>
                <Dialog.Description asChild><p className="text-xs text-[var(--text-muted)] mt-0.5">{acc.email}</p></Dialog.Description>
              </div>
              <button aria-label="关闭" disabled={saving} onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X className="h-4 w-4" /></button>
            </div>
            {error && <p role="alert" className="px-6 pt-4 text-sm text-red-400">{error}</p>}
            {copyNotice && <p role="status" className="px-6 pt-3 text-sm text-[var(--text-secondary)]">{copyNotice}</p>}
            {/* ── Scrollable Content ── */}
            <div className="px-6 py-4 space-y-3 flex-1 overflow-y-auto min-h-0">
              <div className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--accent-soft)] p-4 shadow-[var(--shadow-soft)]">
                <div className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-[var(--accent-soft)] blur-3xl" />
                <div className="relative flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">核心状态</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_VARIANT[getDisplayStatus(acc)] || 'secondary'}>{getAccountStatusLabel(getDisplayStatus(acc))}</Badge>
                      {getBlockedAccountStatusReason(getDisplayStatus(acc)) && <span className="text-xs font-medium text-red-300">{getBlockedAccountStatusReason(getDisplayStatus(acc))}</span>}
                      <span className="text-lg font-semibold tracking-[-0.03em] text-[var(--text-primary)]">{acc.plan_name || overview.plan_name || overview.plan || getPlanState(acc)}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-right text-[11px] text-[var(--text-muted)] sm:grid-cols-3">
                    <div className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-2.5 py-2">
                      <div className="uppercase tracking-[0.12em]">生命周期</div>
                      <div className="mt-1 text-[var(--text-primary)]">{getLifecycleStatus(acc)}</div>
                    </div>
                    <div className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-2.5 py-2">
                      <div className="uppercase tracking-[0.12em]">有效性</div>
                      <div className="mt-1 text-[var(--text-primary)]">{getValidityStatus(acc)}</div>
                    </div>
                    <div className="rounded-xl border border-[var(--border-soft)] bg-black/10 px-2.5 py-2">
                      <div className="uppercase tracking-[0.12em]">套餐状态</div>
                      <div className="mt-1 text-[var(--text-primary)]">{getPlanState(acc)}</div>
                    </div>
                  </div>
                </div>
                {secondaryMetrics.length > 0 && (
                  <div className="relative mt-4 grid gap-2 sm:grid-cols-2">
                    {secondaryMetrics.slice(0, 4).map((metric: any) => (
                      <DisplayMetricCard key={metric.key || metric.label} metric={metric} compact />
                    ))}
                  </div>
                )}
              </div>

              {primaryMetrics.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {primaryMetrics.map((metric: any) => (
                    <DisplayMetricCard key={metric.key || metric.label} metric={metric} />
                  ))}
                </div>
              )}

              <DisplayWarnings warnings={warnings} />
              <DisplaySections sections={displaySections} />

              {(displayBadges.length > 0 || verificationMailbox?.email) && (
                <div className="space-y-2">
                  {displayBadges.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {displayBadges.map((badge: any, index: number) => (
                        <span key={`${badge?.label || 'badge'}-${index}`} className="rounded-full border border-[var(--border)] bg-[var(--bg-hover)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
                          {badge?.label}
                        </span>
                      ))}
                    </div>
                  )}
                  {verificationMailbox?.email && (
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                      验证码邮箱: {verificationMailbox.email} · {verificationMailbox.provider || '-'} · ID {verificationMailbox.account_id || '-'}
                    </div>
                  )}
                </div>
              )}
              {providerAccounts.length > 0 && (
                <div className="space-y-2">
                  <label className="text-xs text-[var(--text-muted)] block">Provider Accounts</label>
                  {providerAccounts.map((item: any, index: number) => (
                    <div key={`${item.provider_name || 'provider'}-${item.login_identifier || index}`} className="rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] p-3">
                      <div className="text-xs font-semibold text-[var(--text-primary)]">
                        {item.provider_name || item.provider_type || 'provider'}
                      </div>
                      <div className="mt-1 text-xs text-[var(--text-secondary)] break-all">
                        登录标识: {item.login_identifier || '-'}
                      </div>
                      {item.credentials && Object.keys(item.credentials).length > 0 && (
                        <div className="mt-2 grid gap-2">
                          {Object.entries(item.credentials).map(([key, value]: [string, any]) => (
                            <div key={key}>
                              <div className="text-[11px] text-[var(--text-muted)]">{key}</div>
                              <div className="flex items-start gap-1">
                                <div className="flex-1 rounded-md border border-[var(--border)] bg-black/20 px-2 py-1.5 text-xs font-mono text-[var(--text-secondary)] break-all max-h-40 overflow-y-auto">
                                  {String(value || '-')}
                                </div>
                                {value ? (
                                  <button aria-label={`复制 Provider ${key}`} onClick={() => void copyText(String(value))} className="mt-1 shrink-0 text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                                    <Copy className="h-3 w-3" />
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {platformCredentials.length > 0 && (
                <div className="space-y-2">
                  <label className="text-xs text-[var(--text-muted)] block">Platform Credentials</label>
                  {platformCredentials.map((item: any) => (
                    <div key={`${item.scope}-${item.key}`} className="rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] p-3">
                      <div className="text-[11px] text-[var(--text-muted)]">{item.key}</div>
                      <div className="mt-1 flex items-start gap-1">
                        <div className="flex-1 rounded-md border border-[var(--border)] bg-black/20 px-2 py-1.5 text-xs font-mono text-[var(--text-secondary)] break-all max-h-40 overflow-y-auto">
                          {item.value}
                        </div>
                        <button aria-label={`复制凭证 ${item.key}`} onClick={() => void copyText(String(item.value || ''))} className="mt-1 shrink-0 text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div>
                <label className="text-xs text-[var(--text-muted)] block mb-1">生命周期状态</label>
                <select aria-label="生命周期状态" disabled={saving} value={form.lifecycle_status} onChange={e => setForm(f => ({ ...f, lifecycle_status: e.target.value }))}
                  className="control-surface appearance-none">
                  {!['registered','trial','subscribed','expired','invalid'].includes(form.lifecycle_status) && <option value={form.lifecycle_status}>{getAccountStatusLabel(form.lifecycle_status)}</option>}
                  {['registered','trial','subscribed','expired','invalid'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-[var(--text-muted)] block mb-1">主凭证</label>
                <textarea aria-label="主凭证" disabled={saving} value={form.primary_token} onChange={e => setForm(f => ({ ...f, primary_token: e.target.value }))}
                  rows={2} className="control-surface control-surface-mono resize-none" />
              </div>
              <div>
                <label className="text-xs text-[var(--text-muted)] block mb-1">试用链接</label>
                <textarea aria-label="试用链接" disabled={saving} value={form.cashier_url} onChange={e => setForm(f => ({ ...f, cashier_url: e.target.value }))}
                  rows={2} className="control-surface control-surface-mono resize-none" />
              </div>
            </div>
            {/* ── Sticky Footer ── */}
            <div className="flex gap-3 px-6 py-4 border-t border-[var(--border)] shrink-0">
              <Button onClick={save} disabled={saving} className="flex-1">{saving ? '保存中...' : '保存'}</Button>
              <Button variant="outline" disabled={saving} onClick={onClose} className="flex-1">取消</Button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── 导入弹框 ────────────────────────────────────────────────
function ImportModal({ platform, onClose, onDone }: { platform: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState('')
  const submitPendingRef = useRef(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const submit = async () => {
    if (submitPendingRef.current) return
    const lines = text.trim().split('\n').filter(line => line.trim())
    if (lines.length === 0) {
      setError('请至少填写一行账号')
      return
    }
    submitPendingRef.current = true
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const res = await apiFetch('/accounts/import', { method: 'POST', body: JSON.stringify({ platform, lines }) })
      setResult(`导入成功 ${res.created} 个`)
      onDone()
    } catch (error) {
      setError(error instanceof Error ? error.message : '导入失败，请重试')
    } finally {
      submitPendingRef.current = false
      setLoading(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={value => { if (!value && !submitPendingRef.current) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop">
          <Dialog.Content aria-label="批量导入" className="dialog-panel dialog-panel-sm p-6"
            onOpenAutoFocus={() => { returnFocusRef.current = document.activeElement as HTMLElement }}
            onCloseAutoFocus={event => { event.preventDefault(); returnFocusRef.current?.focus() }}
            onEscapeKeyDown={event => { if (submitPendingRef.current) event.preventDefault() }}
            onPointerDownOutside={event => { if (submitPendingRef.current) event.preventDefault() }}
          >
            <Dialog.Title asChild><h2 className="text-base font-semibold text-[var(--text-primary)] mb-2">批量导入</h2></Dialog.Title>
            <Dialog.Description asChild><p className="text-xs text-[var(--text-muted)] mb-3">每行格式: <code className="bg-[var(--bg-hover)] px-1 rounded">email password [cashier_url]</code></p></Dialog.Description>
            <textarea aria-label="待导入账号" disabled={loading} value={text} onChange={e => setText(e.target.value)} rows={8}
              className="control-surface control-surface-mono resize-none mb-3" />
            {error && <p role="alert" className="text-sm text-red-400 mb-3">{error}</p>}
            {result && <p role="status" className="text-sm text-emerald-400 mb-3">{result}</p>}
            <div className="flex gap-2">
              <Button onClick={submit} disabled={loading || !text.trim()} className="flex-1">{loading ? '导入中...' : '导入'}</Button>
              <Button variant="outline" disabled={loading} onClick={onClose} className="flex-1">取消</Button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ExportMenu({
  platform,
  total,
  statusFilter,
  searchFilter,
  selectedIds,
  disabled = false,
}: {
  platform: string
  total: number
  statusFilter: string
  searchFilter: string
  selectedIds: number[]
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const exportPendingRef = useRef(false)
  const hasSelection = selectedIds.length > 0
  const any2apiNeedsSelection = (hasSelection ? selectedIds.length : total) !== 1

  const doExport = async (format: string, allAccounts = false) => {
    if (disabled || exportPendingRef.current) return
    exportPendingRef.current = true
    setLoading(format)
    try {
      const { blob, filename } = await apiDownload(`/accounts/export/${format}`, {
        method: 'POST',
        body: JSON.stringify({
          platform,
          ids: hasSelection ? selectedIds : [],
          select_all: !hasSelection,
          status_filter: !hasSelection && !allAccounts ? statusFilter || null : null,
          search_filter: !hasSelection && !allAccounts ? searchFilter || null : null,
        }),
      })
      triggerBrowserDownload(blob, filename)
      setOpen(false)
    } catch (e: any) {
      window.alert(e?.message || '导出失败')
    } finally {
      exportPendingRef.current = false
      setLoading(null)
    }
  }

  const options = [
    { key: 'json', label: '导出 JSON' },
    { key: 'csv', label: '导出 CSV' },
    { key: 'any2api', label: '导出 Any2Api' },
    { key: 'sub2api', label: '导出 Sub2Api' },
    { key: 'cpa', label: '导出 CPA' },
    ...(platform === 'kiro' ? [{ key: 'kiro-go', label: '导出 Kiro-Go' }] : []),
  ]

  return (
    <div className="relative flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void doExport('cpa', true)}
        disabled={disabled || (total === 0 && !statusFilter && !searchFilter)}
        aria-disabled={!!loading}
        className="aria-disabled:opacity-50"
        title={hasSelection ? '导出勾选账号的 CPA 文件' : '导出全部 ChatGPT 账号，不限当前页面或筛选'}
      >
        <Download className="h-4 w-4 mr-1" />
        {loading ? '导出中...' : hasSelection ? `导出已选 CPA (${selectedIds.length})` : '一键导出全部 CPA'}
      </Button>
      <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button variant="outline" size="sm" aria-label="选择导出格式" disabled={disabled || total === 0}>
            <Download className="h-4 w-4 mr-1" />
            {loading ? '导出中...' : hasSelection ? `导出已选(${selectedIds.length})` : '导出'}
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={8} collisionPadding={12}
            className="z-[9999] min-w-[148px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] py-1 shadow-lg"
            style={{ maxHeight: 'var(--radix-dropdown-menu-content-available-height)' }}
          >
            <DropdownMenu.Label className="px-3 py-1 text-[11px] text-[var(--text-muted)]">
              {hasSelection ? `导出 ${selectedIds.length} 个已选账号` : '导出当前筛选结果'}
            </DropdownMenu.Label>
            {options.map(option => (
              <DropdownMenu.Item key={option.key} asChild
                disabled={disabled || !!loading || (option.key === 'any2api' && any2apiNeedsSelection)}
                onSelect={event => { event.preventDefault(); void doExport(option.key) }}
              >
                <button type="button"
                  disabled={disabled || !!loading || (option.key === 'any2api' && any2apiNeedsSelection)}
                  className="block w-full px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  {option.label}
                  {option.key === 'any2api' && any2apiNeedsSelection && (
                    <span className="mt-0.5 block text-[10px] text-[var(--text-muted)]">请先勾选一个账号</span>
                  )}
                </button>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}

// ── Main ────────────────────────────────────────────────────
export default function Accounts() {
  const { platform } = useParams<{ platform: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState(platform || '')
  useEffect(() => { if (platform) { setTab(platform); setPagination({ key: '', page: 1 }) } }, [platform])

  const [accounts, setAccounts] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const filterKey = JSON.stringify([tab, debouncedSearch, filterStatus])
  const [pagination, setPagination] = useState({ key: '', page: 1 })
  const page = pagination.key === filterKey ? pagination.page : 1
  const loadKey = JSON.stringify([tab, debouncedSearch, filterStatus, page])
  const [loadedQuery, setLoadedQuery] = useState('')
  const [loadError, setLoadError] = useState('')
  const [exportError, setExportError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const loadRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const currentQueryRef = useRef({ platform: tab, search: debouncedSearch, status: filterStatus, page, filterKey, key: loadKey })
  currentQueryRef.current = { platform: tab, search: debouncedSearch, status: filterStatus, page, filterKey, key: loadKey }
  const pageReady = search === debouncedSearch && !loading && loadedQuery === loadKey
  const pageCount = Math.max(1, Math.ceil(total / 100))

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; loadRequestRef.current += 1 }
  }, [])
  const [detail, setDetail] = useState<any | null>(null)
  const [restoreAccountFocus, setRestoreAccountFocus] = useState<{ target: 'detail' | 'action'; accountId: number } | { target: 'list' } | null>(null)
  useEffect(() => {
    if (!pageReady || !restoreAccountFocus) return
    if (document.activeElement === document.body) {
      const selector = restoreAccountFocus.target === 'list'
        ? 'button[aria-label="刷新账号列表"]'
        : `button[data-account-${restoreAccountFocus.target}-id="${restoreAccountFocus.accountId}"]`
      document.querySelector<HTMLButtonElement>(selector)?.focus()
    }
    setRestoreAccountFocus(null)
  }, [accounts, pageReady, restoreAccountFocus])
  const [showImport, setShowImport] = useState(false)
  const [showAdd, setShowAdd] = useState(false)

  const [platformsMap, setPlatformsMap] = useState<Record<string, any>>({})
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [actionResult, setActionResult] = useState<{ title: string; payload: any; accountId?: number } | null>(null)
  const [accountActionTasks, setAccountActionTasks] = useState<Array<AccountActionTask & { status: string | null }>>([])
  const [pendingAccountAction, setPendingAccountAction] = useState<(AccountActionOptions & { operation: number; submitting: boolean; error: string }) | null>(null)
  const [accountActionNotice, setAccountActionNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [accountActionFocus, setAccountActionFocus] = useState(0)
  const accountActionFocusRef = useRef(0)
  const finishedAccountTasksRef = useRef<Set<string>>(new Set())
  const accountOptionsSubmitRef = useRef<number | null>(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [batchRefreshing, setBatchRefreshing] = useState(false)
  const [bulkRecovering, setBulkRecovering] = useState(false)
  const [bulkRefreshSubmitting, setBulkRefreshSubmitting] = useState(false)
  const [bulkRecoveryError, setBulkRecoveryError] = useState('')
  const [bulkRefreshError, setBulkRefreshError] = useState('')
  const [verificationHold, setVerificationHold] = useState<VerificationHold | null>(null)
  const [verificationHoldLoading, setVerificationHoldLoading] = useState(true)
  const [verificationHoldError, setVerificationHoldError] = useState('')
  const [batchTask, setBatchTask] = useState<{ taskId: string; title: string; operation: number } | null>(null)
  const [batchTaskStatus, setBatchTaskStatus] = useState<string | null>(null)
  const [batchTaskSummary, setBatchTaskSummary] = useState<any | null>(null)
  const batchTaskIdRef = useRef<string | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const hasVisibleActionTask = Boolean(batchTask && batchTask.operation === accountActionFocus)
    || accountActionTasks.some(task => task.operation === accountActionFocus && task.platform === tab)
  const copyStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (copyStatusTimer.current !== null) clearTimeout(copyStatusTimer.current)
  }, [])

  useEffect(() => {
    let active = true
    getPlatforms().then((list: any[]) => {
      if (!active) return
      const map: Record<string, any> = {}
      list.forEach(p => { map[p.name] = p })
      setPlatformsMap(map)
      if (!platform && !tab && list[0]?.name) {
        setTab(list[0].name)
      }
    }).catch(() => {})
    return () => { active = false }
  }, [platform, tab])

  const [actionMetadata, setActionMetadata] = useState<{ platform: string; actions: any[]; loading: boolean; error: string }>({ platform: '', actions: [], loading: true, error: '' })
  const actionMetadataRequestRef = useRef(0)
  const reloadPlatformActions = useCallback(async () => {
    if (!tab) return
    const request = ++actionMetadataRequestRef.current
    setActionMetadata(current => ({ platform: tab, actions: current.platform === tab ? current.actions : [], loading: true, error: '' }))
    try {
      const data = await apiFetch(`/actions/${tab}`)
      if (!Array.isArray(data?.actions)) throw new Error('账号操作响应不完整，请重试')
      if (!mountedRef.current || request !== actionMetadataRequestRef.current) return
      setActionMetadata({ platform: tab, actions: data.actions, loading: false, error: '' })
    } catch (error) {
      if (!mountedRef.current || request !== actionMetadataRequestRef.current) return
      setActionMetadata({ platform: tab, actions: [], loading: false, error: error instanceof Error ? error.message : '操作列表加载失败，请重试' })
    }
  }, [tab])

  useEffect(() => {
    void reloadPlatformActions()
    return () => { actionMetadataRequestRef.current += 1 }
  }, [reloadPlatformActions])
  const currentActionMetadata = actionMetadata.platform === tab ? actionMetadata : { actions: [], loading: true, error: '' }

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [tab, filterStatus, debouncedSearch, page])

  const refreshVerificationHold = useCallback(async () => {
    try {
      const data = await apiFetch('/tasks/verification-hold')
      setVerificationHold(data.verification_hold || null)
      setVerificationHoldError('')
    } catch {
      setVerificationHoldError('无法加载手机验证暂停状态，请刷新页面')
    } finally {
      setVerificationHoldLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshVerificationHold()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshVerificationHold()
    }, 5000)
    return () => window.clearInterval(interval)
  }, [refreshVerificationHold])

  const load = useCallback(async () => {
    if (!mountedRef.current) return
    const query = currentQueryRef.current
    const request = ++loadRequestRef.current
    if (!query.platform) return
    setLoading(true)
    setLoadError('')
    try {
      const params = new URLSearchParams({ platform: query.platform, page: String(query.page), page_size: '100' })
      if (query.search) params.set('email', query.search)
      if (query.status) params.set('status', query.status)
      const data = await apiFetch(`/accounts?${params}`)
      if (!mountedRef.current || request !== loadRequestRef.current || query.key !== currentQueryRef.current.key) return
      const lastPage = Math.max(1, Math.ceil(data.total / 100))
      setTotal(data.total)
      if (query.page > lastPage) {
        setAccounts([])
        setLoadedQuery('')
        setPagination({ key: query.filterKey, page: lastPage })
        return
      }
      setAccounts(data.items)
      setLoadedQuery(query.key)
    } catch (error) {
      if (!mountedRef.current || request !== loadRequestRef.current || query.key !== currentQueryRef.current.key) return
      setAccounts([])
      setTotal(0)
      setSelectedIds(new Set())
      setLoadedQuery('')
      setLoadError(error instanceof Error ? error.message : '加载账号失败，请重试')
    } finally {
      if (mountedRef.current && request === loadRequestRef.current && query.key === currentQueryRef.current.key) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { loadRequestRef.current += 1 }
  }, [load, loadKey])

  useEffect(() => {
    setSelectedIds(prev => {
      const visible = new Set(accounts.map(acc => acc.id))
      return new Set([...prev].filter(id => visible.has(id)))
    })
  }, [accounts])

  
  const exportCsv = async () => {
    if (!pageReady || exportingRef.current) return
    const query = currentQueryRef.current
    const ids = [...selectedIds]
    exportingRef.current = true
    setExporting(true)
    setExportError('')
    try {
      const { blob, filename } = await apiDownload('/accounts/export/table-csv', {
        method: 'POST',
        body: JSON.stringify({
          platform: query.platform, ids, select_all: ids.length === 0,
          status_filter: ids.length ? null : query.status || null,
          search_filter: ids.length ? null : query.search || null,
        }),
      })
      triggerBrowserDownload(blob, filename)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '导出失败，请重试')
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }

  const deleteSelected = async () => {
    if (bulkDeleting || !pageReady || selectedIds.size === 0) return
    if (!confirm(`确认删除选中的 ${selectedIds.size} 个账号？此操作不可撤销。`)) return
    const ids = [...selectedIds]
    setBulkDeleting(true)
    setDeleteError('')
    try {
      const results = await Promise.allSettled(ids.map(id => apiFetch(`/accounts/${id}`, { method: 'DELETE' })))
      const deleted = new Set(ids.filter((_, index) => results[index].status === 'fulfilled'
        && (results[index] as PromiseFulfilledResult<any>).value?.ok !== false))
      setSelectedIds(current => new Set([...current].filter(id => !deleted.has(id))))
      if (deleted.size !== ids.length) setDeleteError(`${ids.length - deleted.size} 个账号删除失败，请刷新查看后重试`)
      await load()
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除账号失败，请重试')
    } finally {
      setBulkDeleting(false)
    }
  }

  const beginAccountAction = useCallback(() => {
    const operation = ++accountActionFocusRef.current
    setAccountActionFocus(operation)
    setAccountActionNotice(null)
    setActionResult(null)
    setPendingAccountAction(null)
    return operation
  }, [])

  const isAccountActionCurrent = (operation: number, actionPlatform: string) =>
    mountedRef.current && operation === accountActionFocusRef.current
      && actionPlatform === currentQueryRef.current.platform

  useEffect(() => { beginAccountAction() }, [tab, beginAccountAction])
  useEffect(() => {
    if (!accountActionNotice) return
    const timer = setTimeout(() => setAccountActionNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [accountActionNotice])

  const handleAccountActionError = (operation: number, actionPlatform: string, error: any) => {
    if (!isAccountActionCurrent(operation, actionPlatform)) return
    const text = error instanceof Error ? error.message : String(error || '操作失败，请重试')
    setAccountActionNotice({ type: 'error', text })
    setPendingAccountAction(current => current?.operation === operation ? { ...current, error: text } : current)
    void load()
    void refreshVerificationHold()
  }

  const presentAccountActionResult = async (title: string, data: any, operation: number, actionPlatform: string, accountId?: number) => {
    if (!isAccountActionCurrent(operation, actionPlatform)) return
    const actionUrl = data?.url || data?.checkout_url || data?.cashier_url
    let copyFailed = false
    if (actionUrl) {
      try { window.open(actionUrl, '_blank') } catch { /* The result view retains the link. */ }
      try { await navigator.clipboard.writeText(actionUrl) } catch { copyFailed = true }
      if (!isAccountActionCurrent(operation, actionPlatform)) return
    }
    if (data && typeof data === 'object') {
      const detailKeys = Object.keys(data).filter(key => !['message', 'url', 'checkout_url', 'cashier_url'].includes(key))
      if (actionUrl || detailKeys.length > 0) setActionResult({ title, payload: data, accountId })
      setAccountActionNotice(actionUrl
        ? { type: copyFailed ? 'error' : 'success', text: copyFailed ? '链接已生成，自动复制失败，可在结果中查看' : '链接已生成并复制，可在结果中查看' }
        : { type: 'success', text: String(data.message || '操作成功') })
    } else {
      setAccountActionNotice({ type: 'success', text: typeof data === 'string' && data ? data : '操作成功' })
    }
  }

  const handleSyncAccountAction = (title: string, data: any, operation: number, actionPlatform: string, accountId?: number) => {
    if (!mountedRef.current) return
    setPendingAccountAction(current => current?.operation === operation ? null : current)
    void presentAccountActionResult(title, data, operation, actionPlatform, accountId)
      .catch(error => handleAccountActionError(operation, actionPlatform, error))
      .finally(() => {
        if (mountedRef.current) { void load(); void refreshVerificationHold() }
      })
  }

  const registerAccountActionTask = (task: AccountActionTask) => {
    if (!mountedRef.current) return
    setPendingAccountAction(current => current?.operation === task.operation ? null : current)
    setAccountActionTasks(current => current.some(item => item.taskId === task.taskId)
      ? current : [...current, { ...task, status: null }])
  }

  const handleActionDone = async (actionTask: AccountActionTask, status: string) => {
    if (finishedAccountTasksRef.current.has(actionTask.taskId)) return
    finishedAccountTasksRef.current.add(actionTask.taskId)
    actionTask.onFinished()
    if (!mountedRef.current) return
    setAccountActionTasks(current => current.map(task => task.taskId === actionTask.taskId ? { ...task, status } : task))
    void load()
    void refreshVerificationHold()
    try {
      if (!isAccountActionCurrent(actionTask.operation, actionTask.platform)) return
      const task = await apiFetch(`/tasks/${actionTask.taskId}`)
      if (!isAccountActionCurrent(actionTask.operation, actionTask.platform)) return
      if (status !== 'succeeded') {
        setAccountActionNotice({ type: 'error', text: String(task?.error || getTaskStatusText(status)) })
        return
      }
      await presentAccountActionResult(actionTask.title, task?.data ?? task?.result?.data,
        actionTask.operation, actionTask.platform, actionTask.accountId)
    } catch (error) {
      handleAccountActionError(actionTask.operation, actionTask.platform, error)
    } finally {
      if (mountedRef.current && !isAccountActionCurrent(actionTask.operation, actionTask.platform)) {
        setAccountActionTasks(current => current.filter(task => task.taskId !== actionTask.taskId))
      }
    }
  }

  const openAccountActionOptions = (options: AccountActionOptions) => {
    const operation = beginAccountAction()
    setPendingAccountAction({ ...options, operation, submitting: false, error: '' })
  }

  const submitAccountActionOptions = (params: Record<string, any>) => {
    const pending = pendingAccountAction
    if (!pending || accountOptionsSubmitRef.current === pending.operation) return
    accountOptionsSubmitRef.current = pending.operation
    setPendingAccountAction(current => current?.operation === pending.operation ? { ...current, submitting: true, error: '' } : current)
    void Promise.resolve()
      .then(() => {
        if (isAccountActionCurrent(pending.operation, pending.platform)) return pending.submit(params, pending.operation)
      })
      .catch(error => handleAccountActionError(pending.operation, pending.platform, error))
      .finally(() => {
        if (accountOptionsSubmitRef.current === pending.operation) accountOptionsSubmitRef.current = null
        if (mountedRef.current) setPendingAccountAction(current => current?.operation === pending.operation
          ? { ...current, submitting: false } : current)
      })
  }

  const pageIds = accounts.map(acc => acc.id)
  const allSelectedOnPage = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id))
  const selectedCount = selectedIds.size
  const eligibleRecoveryIds = tab === 'chatgpt'
    ? accounts.filter(acc => acc.platform === 'chatgpt' && selectedIds.has(acc.id)
      && ['phone_required', '2fa_required'].includes(getLifecycleStatus(acc))
      && !['fraud_guard', 'rate_limit_exceeded'].includes(getLifecycleStatus(acc))
      && !['fraud_guard', 'rate_limit_exceeded'].includes(acc?.display_status)
      && !['fraud_guard', 'rate_limit_exceeded'].includes(acc?.display_summary?.status?.display)).map(acc => acc.id)
    : []
  const bulkRecoveryDisabled = Boolean(verificationHold?.active || verificationHoldLoading || verificationHoldError)
    || eligibleRecoveryIds.length === 0 || loading || !pageReady || bulkRecovering
    || batchRefreshing || Boolean(batchTask && !isTerminalTaskStatus(batchTaskStatus || ''))
    || (typeof bulkRefreshSubmitting !== 'undefined' && bulkRefreshSubmitting)

  const toggleOne = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedChatgptAccounts = tab === 'chatgpt'
    ? accounts.filter(acc => acc.platform === 'chatgpt' && selectedIds.has(acc.id))
    : []
  const pendingRegistrationIds = selectedChatgptAccounts
    .filter(acc => ['phone_required', '2fa_required'].includes(getLifecycleStatus(acc))
      && !['fraud_guard', 'rate_limit_exceeded'].includes(getDisplayStatus(acc)))
    .map(acc => acc.id)
  const blockedSelectedIds = selectedChatgptAccounts
    .filter(acc => ['fraud_guard', 'rate_limit_exceeded'].includes(getLifecycleStatus(acc))
      || ['fraud_guard', 'rate_limit_exceeded'].includes(getDisplayStatus(acc)))
    .map(acc => acc.id)
  const eligibleTokenRefreshIds = [...new Set(
    selectedChatgptAccounts
      .filter(acc => !['phone_required', '2fa_required', 'fraud_guard', 'rate_limit_exceeded'].includes(getLifecycleStatus(acc))
        && !['fraud_guard', 'rate_limit_exceeded'].includes(getDisplayStatus(acc)))
      .map(acc => Number(acc.id))
      .filter(id => Number.isSafeInteger(id) && id > 0),
  )].slice(0, 100)
  const activeBatchTask = Boolean(batchTask && !isTerminalTaskStatus(batchTaskStatus || ''))
  const batchOperationDisabled = loading || !pageReady || batchRefreshing || bulkRecovering || bulkRefreshSubmitting || activeBatchTask
  const bulkTokenRefreshDisabled = tab !== 'chatgpt'

    || eligibleTokenRefreshIds.length === 0 || batchOperationDisabled

  const togglePage = () => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allSelectedOnPage) pageIds.forEach(id => next.delete(id))
      else pageIds.forEach(id => next.add(id))
      return next
    })
  }

  const showCopyStatus = (text: string) => {
    if (copyStatusTimer.current !== null) clearTimeout(copyStatusTimer.current)
    setCopyStatus(text)
    copyStatusTimer.current = setTimeout(() => setCopyStatus(''), 500)
  }

  const copy = async (text: string, label = '内容') => {
    setCopyStatus('')
    try {
      await navigator.clipboard.writeText(text)
      showCopyStatus(`${label}已复制`)
      return
    } catch {
      // Some browsers expose Clipboard API but deny writes.
    }
    const activeElement = document.activeElement as HTMLElement | null
    const el = document.createElement('textarea')
    el.value = text
    el.readOnly = true
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    document.body.appendChild(el)
    try {
      el.select()
      if (!document.execCommand('copy')) throw new Error('Copy failed')
      showCopyStatus(`${label}已复制`)
    } catch {
      showCopyStatus('复制失败，请检查浏览器剪贴板权限')
    } finally {
      el.remove()
      activeElement?.focus()
    }
  }

  const currentPlatformMeta = platformsMap[tab]
  const platformLabel = currentPlatformMeta?.display_name || tab
  const recoverSelected = async () => {
    if (bulkRecoveryDisabled) return
    const operation = beginAccountAction()
    setBulkRecoveryError('')
    setBulkRecovering(true)
    try {
      const res = await apiFetch('/actions/chatgpt/bulk/complete_registration', {
        method: 'POST',
        body: JSON.stringify({ account_ids: eligibleRecoveryIds, params: {} }),
      })
      if (res?.ok === false) { void refreshVerificationHold(); throw new Error(res.error || '手机验证已暂停') }
      const taskId = res.task_id || res.id
      if (!taskId) throw new Error('未返回恢复任务，请刷新后重试')
      if (typeof batchTaskIdRef !== 'undefined') batchTaskIdRef.current = String(taskId)
      setBatchTask({ taskId: String(taskId), title: `批量恢复注册（${eligibleRecoveryIds.length} 个账号）`, operation })
      setBatchTaskStatus(null)
      setBatchTaskSummary(null)
    } catch (error) {
      setBulkRecoveryError(error instanceof Error ? error.message : '启动恢复失败，请重试')
    } finally {
      setBulkRecovering(false)
    }
  }
  const refreshSelectedTokens = async () => {
    if (bulkTokenRefreshDisabled) return
    const operation = beginAccountAction()
    setBulkRefreshError('')
    setBulkRefreshSubmitting(true)
    try {
      const res = await apiFetch('/actions/chatgpt/bulk/refresh_token', {
        method: 'POST',
        body: JSON.stringify({ account_ids: eligibleTokenRefreshIds, params: {} }),
      })
      if (res?.ok === false) throw new Error(res.error || '启动 Token 刷新失败')
      const taskId = res?.task_id || res?.id
      if (!taskId) throw new Error('未返回 Token 刷新任务，请刷新后重试')
      if (typeof batchTaskIdRef !== 'undefined') batchTaskIdRef.current = String(taskId)
      setBatchTask({ taskId: String(taskId), title: `批量自动刷新 Token（${eligibleTokenRefreshIds.length}）`, operation })
      setBatchTaskStatus(null)
      setBatchTaskSummary(null)
    } catch (error) {
      setBulkRefreshError(error instanceof Error ? error.message : '启动 Token 刷新失败，请重试')
    } finally {
      setBulkRefreshSubmitting(false)
    }
  }
  const visibleTrial = accounts.filter(acc => getPlanState(acc) === 'trial').length
  const visibleSubscribed = accounts.filter(acc => getPlanState(acc) === 'subscribed').length
  const visibleInvalid = accounts.filter(acc => getValidityStatus(acc) === 'invalid' || getLifecycleStatus(acc) === 'invalid').length
  const linkedCashier = accounts.filter(acc => Boolean(getCashierUrl(acc))).length

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      {copyStatus && <div role="status" aria-live="polite" className="fixed top-5 right-5 z-[9999] rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--text-primary)] shadow-lg">{copyStatus}</div>}
      {detail && <DetailModal key={detail.id} acc={detail} onClose={() => { setRestoreAccountFocus({ target: 'detail', accountId: detail.id }); setDetail(null) }} onSave={() => { setRestoreAccountFocus({ target: 'detail', accountId: detail.id }); setDetail(null); load() }} />}
      {showImport && <ImportModal platform={tab} onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); load() }} />}
      {showAdd && <AddModal platform={tab} onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); load() }} />}

      {batchTask && (
        <div className={batchTask.operation === accountActionFocus ? 'contents' : 'hidden'}>
        <ActionTaskModal
          key={batchTask.taskId}
          title={batchTask.title}
          taskId={batchTask.taskId}
          taskStatus={batchTaskStatus}
          visible={batchTask.operation === accountActionFocus}
          notice={batchTask.operation === accountActionFocus ? accountActionNotice : null}
          summary={batchTask.title.startsWith('批量自动刷新 Token') ? batchTaskSummary : null}
          onClose={() => {
            setRestoreAccountFocus({ target: 'list' })
            batchTaskIdRef.current = null
            setBatchTask(null)
            setBatchTaskStatus(null)
            setBatchTaskSummary(null)
            setBatchRefreshing(false)
            load()
          }}
          onDone={(status) => {
            const completedTaskId = batchTask.taskId
            const isTokenBatch = batchTask.title.startsWith('批量自动刷新 Token')
            setBatchTaskStatus(status)
            setBatchRefreshing(false)
            if (isTokenBatch) {
              void apiFetch(`/tasks/${completedTaskId}`)
                .then(task => {
                  if (batchTaskIdRef.current !== completedTaskId) return
                  setBatchTaskSummary(task?.result?.data ?? task?.result ?? task?.data ?? null)
                })
                .catch(() => {
                  if (batchTaskIdRef.current === completedTaskId) setBatchTaskSummary(null)
                })
            }
            load()
          }}
        />
        </div>
      )}

      {accountActionTasks.map(task => (
        <div key={task.taskId} className={task.operation === accountActionFocus && task.platform === tab ? 'contents' : 'hidden'}>
          <ActionTaskModal
            taskId={task.taskId}
            title={task.title}
            taskStatus={task.status}
            visible={task.operation === accountActionFocus && task.platform === tab}
            notice={task.operation === accountActionFocus && task.platform === tab ? accountActionNotice : null}
            onClose={() => {
              setRestoreAccountFocus({ target: 'action', accountId: task.accountId })
              setAccountActionTasks(current => current.filter(item => item.taskId !== task.taskId))
            }}
            onDone={status => { void handleActionDone(task, status) }}
          />
        </div>
      ))}
      {pendingAccountAction && (
        <ActionParamsModal
          key={pendingAccountAction.operation}
          action={pendingAccountAction.action}
          initialValues={pendingAccountAction.params}
          contextLabel={pendingAccountAction.title}
          submitting={pendingAccountAction.submitting}
          error={pendingAccountAction.error}
          onClose={() => { if (!pendingAccountAction.submitting) setPendingAccountAction(null) }}
          onReturnFocus={pendingAccountAction.returnFocus}
          onSubmit={submitAccountActionOptions}
        />
      )}
      {actionResult && <ActionResultModal title={actionResult.title} payload={actionResult.payload} notice={accountActionNotice} onClose={() => {
        if (actionResult.accountId !== undefined && !document.querySelector('[data-active-task-dialog]')) {
          setRestoreAccountFocus({ target: 'action', accountId: actionResult.accountId })
        }
        setActionResult(null)
        setAccountActionNotice(null)
      }} />}
      {accountActionNotice && !actionResult && !hasVisibleActionTask && (
        <div role={accountActionNotice.type === 'error' ? 'alert' : 'status'}
          className="fixed top-5 right-5 z-[9999] flex cursor-pointer items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm shadow-lg"
          onClick={() => setAccountActionNotice(null)}>
          <span>{accountActionNotice.type === 'error' ? '✗' : '✓'}</span>
          <span>{accountActionNotice.text}</span>
        </div>
      )}

      <Card className="shrink-0 bg-[var(--bg-pane)]/40 border border-[var(--border)] shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 px-5 py-4 border-b border-[var(--border)]/50">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
              {platformLabel}
            </h1>
            <div className="h-4 w-[1px] bg-[var(--border)]"></div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-[var(--text-muted)]">共 {total} 个</span>
              {visibleTrial > 0 && <span className="flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-500 ring-1 ring-inset ring-emerald-500/20">本页试用 {visibleTrial}</span>}
              {visibleSubscribed > 0 && <span className="flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 font-medium text-blue-500 ring-1 ring-inset ring-blue-500/20">本页订阅 {visibleSubscribed}</span>}
              {linkedCashier > 0 && <span className="flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-500 ring-1 ring-inset ring-amber-500/20">本页链接 {linkedCashier}</span>}
              {visibleInvalid > 0 && <span className="flex items-center rounded-full bg-red-500/10 px-2 py-0.5 font-medium text-red-500 ring-1 ring-inset ring-red-500/20">本页失效 {visibleInvalid}</span>}
              {selectedCount > 0 && <span className="flex items-center rounded-full bg-[var(--text-primary)]/10 px-2 py-0.5 font-medium text-[var(--text-primary)] ring-1 ring-inset ring-[var(--text-primary)]/20">已选 {selectedCount}</span>}
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => navigate(`/register?platform=${encodeURIComponent(tab)}`)} disabled={tab === 'chatgpt' && Boolean(verificationHold?.active || verificationHoldLoading || verificationHoldError)} title={tab === 'chatgpt' && verificationHold?.active ? verificationHold.account_exists === false ? '手机验证限制仍有效，关联账号已删除' : '手机验证已暂停，请手动恢复原账号' : undefined} className="h-8 shadow-sm">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              自动注册
            </Button>
            <div className="h-4 w-[1px] bg-[var(--border)]"></div>
            <Button size="sm" variant="outline" onClick={() => { beginAccountAction(); setShowImport(true) }} className="h-8 bg-transparent">
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              导入
            </Button>
            {tab === 'chatgpt' ? (
              <ExportMenu
                key={loadKey}
                disabled={!pageReady}
                platform={tab}
                total={total}
                statusFilter={filterStatus}
                searchFilter={debouncedSearch}
                selectedIds={[...selectedIds]}
              />
            ) : (
              <Button size="sm" variant="outline" onClick={exportCsv} disabled={!pageReady || exporting || total === 0} className="h-8 bg-transparent" title="未勾选时导出全部筛选结果，包括其他页面">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {exporting ? '导出中...' : selectedIds.size ? `导出已选 (${selectedIds.size})` : '导出筛选结果'}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => window.location.assign('/authenticator')} className="h-8 bg-transparent">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              2FA 验证器
            </Button>
            <Button size="sm" variant="outline" onClick={() => { beginAccountAction(); setShowAdd(true) }} className="h-8 bg-transparent">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              手动新增
            </Button>
          </div>
        </div>
        
        {tab === 'chatgpt' && verificationHold?.active && verificationHold.account_exists !== false && (
          <div role="status" className="mx-5 mb-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            <span className="font-semibold">手机验证操作暂停 · 已记录原因：</span>{verificationHold.reason}
            <p className="mt-1 text-xs">仅暂停注册/手机验证操作；其他账号的 Token 刷新和额度查询不受影响。</p>
            <p className="mt-1 text-xs">不会自动换号或重试。{verificationHold.account_id ? `请人工处理账号 ID ${verificationHold.account_id} 的验证问题。` : '正在保存原账号，请刷新后查看。'}</p>
            {verificationHold.retry_after_until && <p className="mt-1 text-xs">服务端重试提示：{verificationHold.retry_after_until}</p>}
          </div>
        )}
        {tab === 'chatgpt' && verificationHoldError && <p role="alert" className="px-5 pb-2 text-sm text-amber-400">{verificationHoldError}</p>}
        {bulkRecoveryError && <p role="alert" className="px-5 pt-2 text-sm text-red-400">{bulkRecoveryError}</p>}
        {bulkRefreshError && <p role="alert" className="px-5 pt-2 text-sm text-red-400">{bulkRefreshError}</p>}
        {loadError && <p role="alert" className="px-5 py-2 text-sm text-red-400">{loadError}</p>}
        {exportError && <p role="alert" className="px-5 py-2 text-sm text-red-400">{exportError}</p>}
        {deleteError && <p role="alert" className="px-5 py-2 text-sm text-red-400">{deleteError}</p>}
        {loading && <p role="status" className="px-5 py-1 text-xs text-[var(--text-muted)]">正在加载账号...</p>}
        {/* Search & Filter Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 bg-[var(--bg-pane)]/20">
          <div className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-3 md:basis-auto">
            <div className="relative min-w-[160px] flex-1 max-w-sm">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-[var(--text-muted)]">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
              </div>
              <input
                type="text"
                placeholder="搜索账号邮箱..."
                value={search}
                onChange={e => { setSelectedIds(new Set()); setPagination({ key: '', page: 1 }); setSearch(e.target.value) }}
                className="w-full rounded-md border border-[var(--border)] bg-transparent py-1.5 pl-8 pr-3 text-sm text-[var(--text-primary)] transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--text-primary)]"
              />
            </div>
            <select
              value={filterStatus}
              aria-label="账号状态筛选"
              onChange={e => { setSelectedIds(new Set()); setPagination({ key: '', page: 1 }); setFilterStatus(e.target.value) }}
              className="rounded-md border border-[var(--border)] bg-transparent py-1.5 pl-3 pr-8 text-sm text-[var(--text-primary)] transition-colors focus:border-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--text-primary)] appearance-none"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundPosition: 'right 8px center', backgroundRepeat: 'no-repeat' }}
            >
              <option value="">全部状态</option>
              <option value="registered">已注册</option>
              <option value="trial">试用中</option>
              <option value="subscribed">已订阅</option>
              <option value="free">免费</option>
              <option value="eligible">可试用</option>
              <option value="expired">已过期</option>
              <option value="invalid">已失效</option>
              {BLOCKED_ACCOUNT_STATUS_FILTER_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {tab === 'chatgpt' && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={refreshSelectedTokens}
                  disabled={bulkTokenRefreshDisabled}
                  title={pendingRegistrationIds.length > 0 ? '待注册账号请使用“批量恢复注册”；此按钮仅刷新可运行账号' : '仅刷新已勾选的 ChatGPT 账号 Token'}
                  className="h-7 px-2.5"
                >
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${bulkRefreshSubmitting ? 'animate-spin' : ''}`} />
                  {bulkRefreshSubmitting ? '提交中...' : `批量自动刷新 Token（${eligibleTokenRefreshIds.length}）`}
                </Button>
                <Button size="sm" variant="outline" onClick={recoverSelected} disabled={bulkRecoveryDisabled} title={verificationHold?.active ? '手机验证已暂停，请手动恢复原账号；批量恢复不可用' : undefined} className="h-7 px-2.5">
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${bulkRecovering ? 'animate-spin' : ''}`} />
                  批量恢复注册（{eligibleRecoveryIds.length}）
                </Button>
              </>
            )}
            {tab === 'chatgpt' && pendingRegistrationIds.length > 0 && (
              <span className="text-xs text-amber-400" title="待注册账号请使用批量恢复注册">
                待注册 {pendingRegistrationIds.length} 个请用恢复注册
              </span>
            )}
            {tab === 'chatgpt' && blockedSelectedIds.length > 0 && (
              <span className="text-xs text-red-300" title="风控拦截或手机号限流账号需人工审核/处理；不能更换号码绕过">
                拦截 {blockedSelectedIds.length} 个需人工审核/处理
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={batchOperationDisabled}
              className="h-7 px-2.5 text-[var(--text-muted)] hover:text-amber-500 hover:bg-amber-500/10"
              title="一键刷新全部账号额度"
              onClick={async () => {
                const operation = beginAccountAction()
                setBatchRefreshing(true)
                try {
                  const res = await apiFetch(`/accounts/check-all?platform=${tab}`, { method: 'POST' })
                  const taskId = res?.task_id || res?.id
                  if (!taskId) throw new Error('未返回额度刷新任务，请刷新后重试')
                  if (typeof batchTaskIdRef !== 'undefined') batchTaskIdRef.current = String(taskId)
                  setBatchTask({ taskId: String(taskId), title: `刷新全部 ${platformLabel} 账号额度`, operation })
                  setBatchTaskStatus(null)
                  setBatchTaskSummary(null)
                } catch (e) {
                  handleAccountActionError(operation, tab, e)
                  setBatchRefreshing(false)
                }
              }}
            >
              <Zap className={`mr-1 h-3.5 w-3.5 ${batchRefreshing ? 'animate-pulse' : ''}`} />
              {batchRefreshing ? '刷新中...' : '刷新额度'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { void load(); void reloadPlatformActions() }} disabled={loading} aria-label="刷新账号列表" className="h-7 w-7 p-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            {selectedCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={bulkDeleting || !pageReady}
                className="h-7 px-2.5 text-red-500 hover:bg-red-500/10 hover:text-red-600"
                onClick={deleteSelected}
                aria-label="删除选中账号"
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {bulkDeleting ? '删除中...' : `删除`}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="min-h-0 flex-1 overflow-hidden p-0 border border-[var(--border)] shadow-sm">
        <div className="flex h-full min-h-0 flex-col">
          <div className="glass-table-wrap min-h-0 flex-1 overflow-auto">
        <table inert={!pageReady} aria-busy={loading} className="table-fixed w-full min-w-[900px] text-sm">
          <colgroup>
            <col className="w-10" />
            <col className="w-[30%]" />
            <col className="w-[12%]" />
            <col className="w-[26%]" />
            <col className="w-[8%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead className="sticky top-0 z-10  bg-[var(--bg-pane)]/80">
            <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wider font-medium text-[var(--text-muted)]">
              <th className="w-10 px-3 py-2 text-left">
                <input
                  type="checkbox"
                  checked={allSelectedOnPage}
                  aria-label="选择本页账号"
                  disabled={!pageReady}
                  onChange={togglePage}
                  className="checkbox-accent rounded-[3px] border-[var(--border)] focus:ring-[var(--text-primary)] focus:ring-offset-0 bg-transparent text-[var(--text-primary)]"
                />
              </th>
              <th className="px-3 py-2 text-left">邮箱 (Email)</th>
              <th className="px-3 py-2 text-left">密码 (Pwd)</th>
              <th className="px-3 py-2 text-left">状态 (Status)</th>
              <th className="px-3 py-2 text-left">试用链接 (Link)</th>
              <th className="px-3 py-2 text-left">注册时间 (Date)</th>
              <th className="px-3 py-2 text-right">操作 (Action)</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-24 text-center">
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-pane)] border border-[var(--border)] shadow-sm">
                      <svg className="h-6 w-6 text-[var(--text-muted)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
                    </div>
                    <h3 className="text-sm font-medium text-[var(--text-primary)]">{loadError ? '账号列表不可用' : !pageReady ? '正在加载账号...' : '暂无数据'}</h3>
                    <p className="text-xs text-[var(--text-muted)] max-w-sm">{loadError ? '请点击刷新账号列表重试。' : !pageReady ? '正在读取账号记录，请稍候。' : '当前平台没有找到任何账号记录。您可以手动新增或通过导入文件批量添加账号。'}</p>
                  </div>
                </td>
              </tr>
            )}
            {accounts.map(acc => (
              (() => {
                const overview = getAccountOverview(acc)
                const verificationMailbox = getVerificationMailbox(acc)
                const primaryMetrics = getPrimaryMetrics(acc)
                const displayBadges = getDisplayBadges(acc)
                return (
              <tr key={acc.id} className="group border-b border-[var(--border)]/30 hover:bg-[var(--text-primary)]/[0.02] transition-colors cursor-pointer"
                  onClick={() => { beginAccountAction(); setDetail(acc) }}>
                <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(acc.id)}
                    aria-label={`选择账号 ${acc.email}`}
                    disabled={!pageReady}
                    onChange={() => toggleOne(acc.id)}
                    className="checkbox-accent rounded-[3px] border-[var(--border)] focus:ring-[var(--text-primary)] focus:ring-offset-0 bg-transparent text-[var(--text-primary)] transition-all opacity-40 group-hover:opacity-100 data-[state=checked]:opacity-100"
                  />
                </td>
                <td className="px-3 py-2.5 font-mono text-sm text-[var(--text-primary)] align-top">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate tracking-tight" title={acc.email}>{acc.email}</span>
                    <button type="button" aria-label="复制邮箱" title="复制邮箱" disabled={!acc.email} onClick={e => { e.stopPropagation(); copy(acc.email, '邮箱') }} className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40"><Copy className="h-3 w-3" /></button>
                  </div>
                  {verificationMailbox && (verificationMailbox.email || verificationMailbox.account_id || verificationMailbox.provider) && (
                    <div
                      className="mt-1 truncate text-xs text-[var(--text-muted)] flex items-center gap-1"
                      title={`验证邮箱: ${verificationMailbox.email || '-'} · ${verificationMailbox.provider || '-'}`}
                    >
                      <svg className="w-3 h-3 opacity-60 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
                      <span className="truncate">{verificationMailbox.email || '-'}</span>
                    </div>
                  )}
                  {overview?.remote_email && overview.remote_email !== acc.email && (
                    <div className="mt-1 truncate text-xs text-[var(--text-muted)]" title={`远端邮箱: ${overview.remote_email}`}>
                      远端邮箱: {overview.remote_email}
                    </div>
                  )}
                  {displayBadges.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {displayBadges.slice(0, 3).map((badge: any, index: number) => (
                        <span key={`${badge?.label || 'badge'}-${index}`} className="rounded border border-[var(--border)]/50 bg-[var(--bg-pane)]/40 px-1 py-0.5 text-[11px] font-medium text-[var(--text-muted)] shadow-sm">
                          {badge?.label}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 font-mono text-[13px] text-[var(--text-muted)] align-top">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate blur-[3px] transition-all cursor-default hover:blur-none select-none hover:select-auto hover:text-[var(--text-primary)]">{acc.password}</span>
                    <button type="button" aria-label="复制密码" title="复制密码" disabled={!acc.password} onClick={e => { e.stopPropagation(); copy(acc.password, '密码') }} className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40"><Copy className="h-3 w-3" /></button>
                  </div>
                </td>
                <td className="px-3 py-2.5 align-top">
                  <div className="min-w-0 flex flex-col items-start gap-1.5">
                    {(() => {
                      const status = getDisplayStatus(acc);
                      const variant = String(STATUS_VARIANT[status] || 'secondary');
                      const statusLabel = getAccountStatusLabel(status);
                      const blockedReason = getBlockedAccountStatusReason(status);
                      const styles = (({
                        success: "bg-emerald-500/10 text-emerald-500 ring-emerald-500/20",
                        warning: "bg-amber-500/10 text-amber-500 ring-amber-500/20",
                        danger: "bg-red-500/10 text-red-500 ring-red-500/20",
                        secondary: "bg-[var(--text-primary)]/5 text-[var(--text-secondary)] ring-[var(--border)]",
                        default: "bg-blue-500/10 text-blue-500 ring-blue-500/20"
                      } as Record<string, string>)[variant]) || "bg-[var(--text-primary)]/5 text-[var(--text-secondary)] ring-[var(--border)]";
                      
                      return (
                        <>
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${styles}`}>
                          <span className={`mr-1 h-1 w-1 rounded-full ${variant === 'success' ? 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.6)]' : variant === 'warning' ? 'bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.6)]' : variant === 'danger' ? 'bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.6)]' : variant === 'default' ? 'bg-blue-500' : 'bg-gray-400'}`}></span>
                          {statusLabel}
                        </span>
                        {blockedReason && <span className="text-xs font-medium text-red-300">{blockedReason}</span>}
                        </>
                      );
                    })()}
                    {primaryMetrics.length > 0 ? (
                      <div className="flex max-w-full flex-col gap-1">
                        {primaryMetrics.slice(0, 2).map((metric: any) => (
                          <div key={metric.key || metric.label} className="flex items-center gap-1.5">
                            <span className="h-1 w-1 rounded-full bg-[var(--text-muted)] opacity-50"></span>
                            <span className="text-xs tracking-tight text-[var(--text-muted)] whitespace-nowrap">
                              <span className="font-medium text-[var(--text-secondary)] mr-0.5">{metric.label}:</span>
                              {metric.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        className="truncate text-xs text-[var(--text-muted)]"
                        title={getCompactStatusMeta(acc)}
                      >
                        {getCompactStatusMeta(acc)}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 align-top">
                  {getCashierUrl(acc) ? (
                    <div className="flex items-center gap-1.5 whitespace-nowrap opacity-70 group-hover:opacity-100 transition-opacity">
                      <button onClick={e => { e.stopPropagation(); copy(getCashierUrl(acc)) }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors p-0.5 rounded hover:bg-[var(--bg-pane)]" title="复制链接"><Copy className="h-3 w-3" /></button>
                      <a href={getCashierUrl(acc)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors p-0.5 rounded hover:bg-[var(--bg-pane)]" title="打开收银台"><ExternalLink className="h-3 w-3" /></a>
                    </div>
                  ) : <span className="text-[var(--text-muted)]/50 text-xs">-</span>}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-[var(--text-muted)] whitespace-nowrap align-top">
                  {acc.created_at ? new Date(acc.created_at).toLocaleString('zh-CN', { 
                    month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit',
                    hour12: false 
                  }) : '-'}
                </td>
                <td className="px-3 py-2.5 align-top" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-end opacity-60 group-hover:opacity-100 transition-opacity">
                    <ActionMenu
                      acc={acc}
                      actions={currentActionMetadata.actions}
                      actionsLoading={currentActionMetadata.loading}
                      actionsError={currentActionMetadata.error}
                      onReloadActions={reloadPlatformActions}
                      verificationHold={verificationHold}
                      verificationHoldLoading={verificationHoldLoading}
                      verificationHoldError={verificationHoldError}
                      onActionStart={beginAccountAction}
                      onTask={registerAccountActionTask}
                      onOptions={openAccountActionOptions}
                      onError={(operation, error) => handleAccountActionError(operation, acc.platform, error)}
                      runningTaskAction={accountActionTasks.find(task => task.accountId === acc.id && !isTerminalTaskStatus(task.status || ''))?.actionId || null}
                      onDetail={() => { beginAccountAction(); setDetail(acc) }}
                      onDelete={() => load()}
                      onResult={(title, payload, operation) => handleSyncAccountAction(title, payload, operation, acc.platform, acc.id)}
                    />
                  </div>
                </td>
              </tr>
                )
              })()
            ))}
          </tbody>
        </table>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--text-secondary)]">
            <span>本页 {accounts.length} 个，共 {total} 个 · 每页 100 个</span>
            <nav aria-label="账号分页" className="flex items-center gap-3">
              <Button size="sm" variant="outline" disabled={!pageReady || page <= 1}
                onClick={() => { setSelectedIds(new Set()); setPagination({ key: filterKey, page: page - 1 }) }}>上一页</Button>
              <span aria-live="polite">第 {page} / {pageCount} 页</span>
              <Button size="sm" variant="outline" disabled={!pageReady || page >= pageCount}
                onClick={() => { setSelectedIds(new Set()); setPagination({ key: filterKey, page: page + 1 }) }}>下一页</Button>
            </nav>
          </div>
        </div>
      </Card>
    </div>
  )
}
