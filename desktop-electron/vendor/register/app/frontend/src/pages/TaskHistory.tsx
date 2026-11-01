import { useCallback, useEffect, useRef, useState } from 'react'
import { getPlatforms } from '@/lib/app-data'
import { apiFetch } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getTaskStatusText, TASK_STATUS_VARIANTS } from '@/lib/tasks'
import { RefreshCw, Activity, CheckCircle2, AlertTriangle, Clock3, ChevronDown } from 'lucide-react'

function shortId(id: string) {
  if (!id) return '-'
  return id.length > 12 ? '...' + id.slice(-8) : id
}

function formatError(error: string | null | undefined): string {
  if (!error) return ''
  let message = error
  try {
    if (error.startsWith('{') || error.startsWith('[')) {
      const parsed = JSON.parse(error)
      const detail = parsed?.message ?? parsed?.error?.message ?? parsed?.error ?? parsed?.detail
        ?? parsed?.errors?.[0]?.message ?? parsed?.errors?.[0]?.kind ?? parsed?.errors?.[0]
      if (detail !== undefined && detail !== null) {
        message = typeof detail === 'string' ? detail : JSON.stringify(detail)
      }
    }
  } catch {
    // Keep plain text and malformed JSON readable.
  }
  return message.length > 100 ? message.slice(0, 100) + '...' : message
}

export default function TaskHistory() {
  const [tasks, setTasks] = useState<any[]>([])
  const [platform, setPlatform] = useState('')
  const [status, setStatus] = useState('')
  const [platforms, setPlatforms] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [total, setTotal] = useState(0)
  const filterKey = JSON.stringify([platform, status])
  const [pagination, setPagination] = useState({ key: '', page: 1 })
  const page = pagination.key === filterKey ? pagination.page : 1
  const queryKey = JSON.stringify([platform, status, page])
  const currentQueryRef = useRef({ platform, status, page, key: queryKey, filterKey })
  currentQueryRef.current = { platform, status, page, key: queryKey, filterKey }
  const loadRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const pageCount = Math.max(1, Math.ceil(total / 50))

  const load = useCallback(async () => {
    if (!mountedRef.current) return
    const query = currentQueryRef.current
    const request = ++loadRequestRef.current
    setLoading(true)
    setError('')
    setTasks([])
    try {
      const params = new URLSearchParams({ page: String(query.page), page_size: '50' })
      if (query.platform) params.set('platform', query.platform)
      if (query.status) params.set('status', query.status)
      const data = await apiFetch(`/tasks?${params}`)
      if (!mountedRef.current || request !== loadRequestRef.current || query.key !== currentQueryRef.current.key) return
      setTotal(data.total)
      const lastPage = Math.max(1, Math.ceil(data.total / 50))
      if (query.page > lastPage) {
        setPagination({ key: query.filterKey, page: lastPage })
        return
      }
      setTasks(data.items || [])
    } catch (error) {
      if (!mountedRef.current || request !== loadRequestRef.current || query.key !== currentQueryRef.current.key) return
      setTotal(0)
      setError(error instanceof Error ? error.message : '任务记录加载失败，请重试')
    } finally {
      if (mountedRef.current && request === loadRequestRef.current && query.key === currentQueryRef.current.key) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    getPlatforms().then(data => { if (mountedRef.current) setPlatforms(data || []) })
      .catch(() => { if (mountedRef.current) setPlatforms([]) })
    return () => { mountedRef.current = false; loadRequestRef.current += 1 }
  }, [])

  useEffect(() => {
    void load()
    return () => { loadRequestRef.current += 1 }
  }, [load, queryKey])

  const succeeded = tasks.filter((t) => t.status === 'succeeded').length
  const failed = tasks.filter((t) => t.status === 'failed').length
  const running = tasks.filter((t) =>
    ['running', 'claimed', 'pending', 'cancel_requested'].includes(t.status)
  ).length

  const metricCards = [
    { label: '匹配任务', value: total, icon: Activity, tone: 'text-[var(--accent)]' },
    { label: '本页成功', value: succeeded, icon: CheckCircle2, tone: 'text-emerald-500' },
    { label: '本页失败', value: failed, icon: AlertTriangle, tone: 'text-red-500' },
    { label: '本页进行中', value: running, icon: Clock3, tone: 'text-amber-500' },
  ]

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">任务记录</h1>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      {error && <p role="alert" className="rounded-lg border border-red-400/30 px-4 py-3 text-sm text-red-400">{error}</p>}
      {/* Metrics */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {metricCards.map(({ label, value, icon: Icon, tone }) => (
          <div
            key={label}
            className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3"
          >
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--chip-bg)] ${tone}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div>
              <div className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">{label}</div>
              <div className="text-lg font-semibold text-[var(--text-primary)]">{value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters — inline with table header */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2.5">
          <span className="text-sm font-medium text-[var(--text-primary)]">最近任务</span>
          <div className="flex-1" />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative">
              <select
                value={platform}
                aria-label="任务平台筛选"
                onChange={(e) => { setPlatform(e.target.value); setPagination({ key: '', page: 1 }) }}
                className="h-8 appearance-none rounded-md border border-[var(--border)] bg-[var(--bg-input)] pl-3 pr-7 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
              >
                <option value="">全部平台</option>
                {platforms.map((item: any) => (
                  <option key={item.name} value={item.name}>{item.display_name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--text-muted)]" />
            </div>
            <div className="relative">
              <select
                value={status}
                aria-label="任务状态筛选"
                onChange={(e) => { setStatus(e.target.value); setPagination({ key: '', page: 1 }) }}
                className="h-8 appearance-none rounded-md border border-[var(--border)] bg-[var(--bg-input)] pl-3 pr-7 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
              >
                <option value="">全部状态</option>
                <option value="pending">排队中</option>
                <option value="claimed">启动中</option>
                <option value="running">运行中</option>
                <option value="cancel_requested">取消中</option>
                <option value="succeeded">成功</option>
                <option value="failed">失败</option>
                <option value="cancelled">已取消</option>
                <option value="interrupted">已中断</option>
                <option value="paused">手机验证暂停</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--text-muted)]" />
            </div>
            {(platform || status) && (
              <button
                onClick={() => { setPlatform(''); setStatus(''); setPagination({ key: '', page: 1 }) }}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)]"
              >
                清除筛选
              </button>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg-pane)]">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">时间</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">任务 ID</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">平台</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">状态</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">进度</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">成功/失败</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">错误</th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-[var(--text-muted)]">
                    {loading ? '正在加载任务记录...' : error ? '任务记录不可用，请点击刷新重试' : '暂无任务记录'}
                  </td>
                </tr>
              )}
              {tasks.map((task) => {
                const success = task.success || 0
                const errorCount = task.error_count || 0
                const total = success + errorCount
                const verificationHold = task.result?.verification_hold
                const reason = verificationHold?.active ? verificationHold.reason : task.error
                const errorText = formatError(reason)
                return (
                  <tr
                    key={task.id}
                    className="border-b border-[var(--border)]/50 transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-[var(--text-muted)]">
                      {task.created_at
                        ? new Date(task.created_at).toLocaleString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                          })
                        : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="cursor-default font-mono text-xs text-[var(--text-muted)]"
                        title={task.id}
                      >
                        {shortId(task.id)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary">{task.platform || '-'}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={TASK_STATUS_VARIANTS[task.status] || 'secondary'}>
                        {getTaskStatusText(task.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--text-secondary)]">
                      {task.progress || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {total > 0 ? (
                          <>
                            <div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-[var(--chip-bg)]">
                              {success > 0 && (
                                <div
                                  className="h-full bg-emerald-500 rounded-full"
                                  style={{ width: `${(success / total) * 100}%` }}
                                />
                              )}
                              {errorCount > 0 && (
                                <div
                                  className="h-full bg-red-500 rounded-full"
                                  style={{ width: `${(errorCount / total) * 100}%` }}
                                />
                              )}
                            </div>
                            <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">
                              <span className="text-emerald-500">{success}</span>
                              {' / '}
                              <span className="text-red-500">{errorCount}</span>
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-[var(--text-muted)]">-</span>
                        )}
                      </div>
                    </td>
                    <td className="max-w-[280px] px-4 py-3">
                      {errorText ? (
                        <span
                          className={`block truncate text-xs cursor-default ${verificationHold?.active || task.status === 'paused' ? 'text-amber-500' : 'text-red-500'}`}
                          title={reason || ''}
                        >
                          {errorText}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)]">-</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <nav aria-label="任务分页" className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--text-secondary)]">
          <span>本页 {tasks.length} 个，共 {total} 个 · 每页 50 个</span>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" disabled={loading || page <= 1}
              onClick={() => setPagination({ key: filterKey, page: page - 1 })}>上一页</Button>
            <span aria-live="polite">第 {page} / {pageCount} 页</span>
            <Button size="sm" variant="outline" disabled={loading || page >= pageCount}
              onClick={() => setPagination({ key: filterKey, page: page + 1 })}>下一页</Button>
          </div>
        </nav>
      </div>
    </div>
  )
}
