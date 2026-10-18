import { useCallback, useEffect, useRef, useState } from 'react'
import { TaskLogPanel } from '@/components/tasks/TaskLogPanel'
import { isTerminalTaskStatus } from '@/lib/tasks'
import { apiFetch } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Plus, Trash2, RefreshCw, ToggleLeft, ToggleRight, Globe2, ShieldCheck, CircleOff, Activity } from 'lucide-react'

export default function Proxies() {
  const [proxies, setProxies] = useState<any[]>([])
  const [newProxy, setNewProxy] = useState('')
  const [region, setRegion] = useState('')
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState('')
  const [checkTask, setCheckTask] = useState<{ id: string; status: string } | null>(null)
  const mountedRef = useRef(true)
  const listRequestRef = useRef(0)
  const mutatingRef = useRef(false)
  const checkTaskIdRef = useRef<string | null>(null)
  const checking = Boolean(checkTask && !isTerminalTaskStatus(checkTask.status))

  const load = useCallback(async () => {
    if (!mountedRef.current) return
    const request = ++listRequestRef.current
    setLoading(true)
    setError('')
    try {
      const items = await apiFetch('/proxies')
      if (mountedRef.current && request === listRequestRef.current) {
        setProxies(items)
        setHasLoaded(true)
      }
    } catch (error) {
      if (mountedRef.current && request === listRequestRef.current) setError(error instanceof Error ? error.message : '加载代理失败')
    } finally {
      if (mountedRef.current && request === listRequestRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    let active = true
    void load()
    void apiFetch('/proxies/check').then(data => {
      if (!active || checkTaskIdRef.current || !data.task) return
      checkTaskIdRef.current = data.task.id
      setCheckTask({ id: data.task.id, status: data.task.status })
    }).catch(() => {
      if (active) setError('无法读取代理检测状态，请刷新页面后重试')
    })
    return () => { active = false; mountedRef.current = false; listRequestRef.current += 1 }
  }, [load])

  const runMutation = async (operation: () => Promise<void>) => {
    if (mutatingRef.current) return
    mutatingRef.current = true
    setMutating(true)
    setError('')
    try {
      await operation()
    } catch (error) {
      if (mountedRef.current) setError(error instanceof Error ? error.message : '代理操作失败，请重试')
    } finally {
      mutatingRef.current = false
      if (mountedRef.current) setMutating(false)
    }
  }

  const add = () => runMutation(async () => {
    const lines = newProxy.trim().split('\n').map(line => line.trim()).filter(Boolean)
    if (!lines.length) return
    await apiFetch(lines.length > 1 ? '/proxies/bulk' : '/proxies', {
      method: 'POST',
      body: JSON.stringify(lines.length > 1 ? { proxies: lines, region } : { url: lines[0], region }),
    })
    if (mountedRef.current) setNewProxy('')
    await load()
  })

  const del = (id: number) => runMutation(async () => {
    await apiFetch(`/proxies/${id}`, { method: 'DELETE' })
    await load()
  })

  const toggle = (id: number) => runMutation(async () => {
    await apiFetch(`/proxies/${id}/toggle`, { method: 'PATCH' })
    await load()
  })

  const check = () => runMutation(async () => {
    if (checking) return
    const task = await apiFetch('/proxies/check', { method: 'POST' })
    const id = task.task_id || task.id
    if (!id) throw new Error('未返回代理检测任务，请重试')
    if (!mountedRef.current) return
    checkTaskIdRef.current = String(id)
    setCheckTask({ id: String(id), status: task.status || 'pending' })
  })

  const cancelCheck = () => runMutation(async () => {
    const id = checkTaskIdRef.current
    if (!id) return
    const task = await apiFetch(`/tasks/${id}/cancel`, { method: 'POST' })
    if (mountedRef.current && checkTaskIdRef.current === id) {
      setCheckTask(current => !current || current.id !== id || isTerminalTaskStatus(current.status)
        ? current : { id, status: task.status || 'cancel_requested' })
    }
  })

  const activeCount = proxies.filter((item) => item.is_active).length
  const totalSuccess = proxies.reduce((sum, item) => sum + Number(item.success_count || 0), 0)
  const totalFail = proxies.reduce((sum, item) => sum + Number(item.fail_count || 0), 0)
  const metricCards = [
    { label: '代理数', value: hasLoaded ? proxies.length : '—', icon: Globe2, tone: 'text-[var(--accent)]' },
    { label: '启用', value: hasLoaded ? activeCount : '—', icon: ShieldCheck, tone: 'text-emerald-400' },
    { label: '成功次数', value: hasLoaded ? totalSuccess : '—', icon: Activity, tone: 'text-[var(--accent)]' },
    { label: '失败次数', value: hasLoaded ? totalFail : '—', icon: CircleOff, tone: 'text-red-400' },
  ]

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-[var(--text-primary)]">代理</div>
            <Badge variant="default">总量 {hasLoaded ? proxies.length : '—'}</Badge>
            <Badge variant="secondary">活跃 {hasLoaded ? activeCount : '—'}</Badge>
          </div>
          <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => load()} disabled={loading || mutating}>刷新列表</Button>
          <Button variant="outline" size="sm" onClick={check} disabled={checking || loading || mutating || proxies.length === 0}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${checking ? 'animate-spin' : ''}`} />
            {checking ? '检测中...' : '检测全部'}
          </Button>
          </div>
        </div>
      </Card>

      {error && <div role="alert" className="rounded-lg border border-red-400/30 px-4 py-3 text-sm text-red-400">{error}</div>}
      {loading && <p role="status" className="text-sm text-[var(--text-secondary)]">正在加载代理...</p>}
      {checkTask && (
        <Card>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">代理检测</h2>
            {checking ? (
              <Button size="sm" variant="outline" onClick={cancelCheck} disabled={mutating || checkTask.status === 'cancel_requested'}>
                {checkTask.status === 'cancel_requested' ? '取消中...' : '取消检测'}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => { checkTaskIdRef.current = null; setCheckTask(null) }}>关闭检测结果</Button>
            )}
          </div>
          <div className="h-[580px]">
            <TaskLogPanel taskId={checkTask.id} onDone={status => {
              if (checkTaskIdRef.current !== checkTask.id) return
              setCheckTask({ id: checkTask.id, status })
              void load()
            }} />
          </div>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {metricCards.map(({ label, value, icon: Icon, tone }) => (
          <Card key={label} className="bg-transparent">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">{label}</div>
                <div className="mt-1.5 text-xl font-semibold tracking-[-0.03em] text-[var(--text-primary)]">{value}</div>
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-soft)] bg-[var(--chip-bg)]">
                <Icon className={`h-5 w-5 ${tone}`} />
              </div>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,330px)_minmax(0,1fr)]">
        <Card className="bg-[var(--bg-pane)]/60">
          <div className="space-y-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">新增</div>
              <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">添加代理或批量导入</div>
            </div>
            <textarea
              value={newProxy}
              onChange={e => setNewProxy(e.target.value)}
              placeholder="http://user:pass@host:port"
              aria-label="代理地址"
              disabled={mutating}
              rows={8}
              className="control-surface control-surface-mono resize-none"
            />
            <input
              value={region}
              onChange={e => setRegion(e.target.value)}
              placeholder="地区标签 (如 US, SG)"
              aria-label="地区标签"
              disabled={mutating}
              className="control-surface"
            />
            <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-pane)]/45 px-3.5 py-2.5 text-xs leading-5 text-[var(--text-secondary)]">
              支持单条代理直接录入，也支持多行批量导入。地区标签会一起写入，用于后续筛选和出入口识别。
            </div>
            <Button onClick={add} disabled={mutating || !newProxy.trim()} className="w-full">
              <Plus className="h-4 w-4 mr-1.5" />
              添加到代理池
            </Button>
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-medium text-[var(--text-primary)]">
            代理列表
          </div>
        <div className="glass-table-wrap">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
              <th className="px-4 py-2.5 text-left">代理地址</th>
              <th className="px-4 py-2.5 text-left">地区</th>
              <th className="px-4 py-2.5 text-left">成功/失败</th>
              <th className="px-4 py-2.5 text-left">状态</th>
              <th className="px-4 py-2.5 text-left">操作</th>
            </tr>
          </thead>
          <tbody>
            {hasLoaded && !loading && !error && proxies.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8">
                  <div className="empty-state-panel">当前代理池为空，可以先从左侧输入一个或批量导入。</div>
                </td>
              </tr>
            )}
            {proxies.map(p => (
              <tr key={p.id} className="border-b border-[var(--border)]/40 hover:bg-[var(--bg-hover)]/70">
                <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-secondary)]">{p.url}</td>
                <td className="px-4 py-2.5 text-[var(--text-muted)]">{p.region || '-'}</td>
                <td className="px-4 py-2.5">
                  <span className="text-emerald-400">{p.success_count}</span>
                  <span className="text-[var(--text-muted)]"> / </span>
                  <span className="text-red-400">{p.fail_count}</span>
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={p.is_active ? 'success' : 'danger'}>
                    {p.is_active ? '活跃' : '禁用'}
                  </Badge>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggle(p.id)} disabled={mutating || loading} className="table-action-btn">
                      {p.is_active ? <ToggleRight className="mr-1.5 h-4 w-4" /> : <ToggleLeft className="mr-1.5 h-4 w-4" />}
                      {p.is_active ? '停用' : '启用'}
                    </button>
                    <button onClick={() => del(p.id)} disabled={mutating || loading} className="table-action-btn table-action-btn-danger">
                      <Trash2 className="mr-1.5 h-4 w-4" />
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        </Card>
      </div>
    </div>
  )
}
