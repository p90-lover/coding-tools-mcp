import { useEffect, useRef, useState } from 'react'

import { API_BASE, apiFetch } from '@/lib/utils'
import { getTaskStatusText, isTerminalTaskStatus } from '@/lib/tasks'

export function TaskLogPanel({
  taskId,
  onDone,
}: {
  taskId: string
  onDone: (status: string) => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [task, setTask] = useState<any | null>(null)
  const [doneStatus, setDoneStatus] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [logError, setLogError] = useState(false)
  const [statusError, setStatusError] = useState(false)
  const copyGenerationRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const seenEventIdsRef = useRef<Set<number>>(new Set())
  const cursorRef = useRef(0)
  const doneRef = useRef(false)
  const onDoneRef = useRef(onDone)
  const sseHealthyRef = useRef(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const streamSnapshotRef = useRef({ received: false, version: 0, updatedAt: 0 })

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    if (!taskId) return
    let active = true
    let statusReads = 0
    let finalReadPending = false
    let statusNeedsRetry = false
    let eventsPending = false
    let logsNeedRetry = false
    let lastStatusRead = Date.now()
    const requests = new Map<AbortController, ReturnType<typeof setTimeout>>()
    copyGenerationRef.current += 1
    seenEventIdsRef.current = new Set()
    cursorRef.current = 0
    doneRef.current = false
    streamSnapshotRef.current = { received: false, version: 0, updatedAt: 0 }
    sseHealthyRef.current = false
    setLines([])
    setTask(null)
    setDoneStatus(null)
    setCopyStatus('')
    setLogError(false)
    setStatusError(false)

    const read = async (path: string) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      requests.set(controller, timer)
      try {
        return await apiFetch(path, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
        requests.delete(controller)
      }
    }

    const applySnapshot = (snapshot: any, merge = false) => {
      const updatedAt = Date.parse(String(snapshot?.updated_at || ''))
      if (Number.isFinite(updatedAt)) {
        if (updatedAt < streamSnapshotRef.current.updatedAt) return false
        streamSnapshotRef.current.updatedAt = updatedAt
      }
      setTask((current: any) => merge ? { ...current, ...snapshot } : snapshot)
      return true
    }

    const pushEvent = (payload: any) => {
      if (!active) return
      const eventId = Number(payload?.id || 0)
      if (eventId && seenEventIdsRef.current.has(eventId)) return
      if (eventId) {
        seenEventIdsRef.current.add(eventId)
        cursorRef.current = Math.max(cursorRef.current, eventId)
      }
      if (payload?.line) setLines(prev => [...prev, payload.line])
      if (payload?.done === true && isTerminalTaskStatus(payload.status) && !doneRef.current) {
        doneRef.current = true
        sseHealthyRef.current = false
        eventSourceRef.current?.close()
        eventSourceRef.current = null
        const nextStatus = payload.status
        setDoneStatus(nextStatus)
        onDoneRef.current(nextStatus)
      }
    }

    const syncEvents = async () => {
      if (eventsPending || !active) return
      eventsPending = true
      try {
        while (active) {
          const cursor = cursorRef.current
          const data = await read(`/tasks/${taskId}/events?since=${cursor}`)
          if (!active) return
          const items = data.items || []
          for (const item of items) pushEvent(item)
          if (items.length < 200 || cursorRef.current <= cursor) break
        }
        if (active) { logsNeedRetry = false; setLogError(false) }
      } catch {
        if (active) { logsNeedRetry = true; setLogError(true) }
      } finally {
        eventsPending = false
      }
    }

    const syncTask = async (force = false) => {
      const doneAtStart = doneRef.current
      if (!active || (doneAtStart ? finalReadPending : statusReads > 0)) return
      if (doneAtStart) finalReadPending = true
      const snapshotVersion = streamSnapshotRef.current.version
      statusReads += 1
      lastStatusRead = Date.now()
      try {
        const latest = await read(`/tasks/${taskId}`)
        if (!active || (!doneAtStart && doneRef.current)
          || snapshotVersion !== streamSnapshotRef.current.version
          || (!force && (doneRef.current || (sseHealthyRef.current && streamSnapshotRef.current.received)))) return
        if (!applySnapshot(latest)) return
        statusNeedsRetry = false
        setStatusError(false)
        if (isTerminalTaskStatus(latest.status) && !doneRef.current) {
          pushEvent({ done: true, status: latest.status })
          void syncEvents()
        }
      } catch (error) {
        if (active && (doneAtStart || !doneRef.current) && snapshotVersion === streamSnapshotRef.current.version) {
          if (!doneRef.current && error instanceof Error && error.message.includes('任务不存在')) {
            setTask({ status: 'failed', error: '任务不存在' })
            statusNeedsRetry = false
            setStatusError(false)
            logsNeedRetry = false
            setLogError(false)
            pushEvent({ done: true, status: 'failed', line: '任务不存在' })
          } else {
            statusNeedsRetry = true
            setStatusError(true)
          }
        }
      } finally {
        statusReads -= 1
        if (doneAtStart) finalReadPending = false
      }
    }

    const es = new EventSource(`${API_BASE}/tasks/${taskId}/logs/stream`)
    eventSourceRef.current = es
    es.onopen = () => {
      if (!active) return
      sseHealthyRef.current = true
      streamSnapshotRef.current.received = false
    }
    es.onmessage = (e) => {
      if (!active || doneRef.current) return
      let payload
      try {
        payload = JSON.parse(e.data)
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid task stream frame')
      } catch {
        sseHealthyRef.current = false
        streamSnapshotRef.current.received = false
        logsNeedRetry = true
        setLogError(true)
        return
      }
      sseHealthyRef.current = true
      if (payload.task && applySnapshot(payload.task, true)) {
        streamSnapshotRef.current.received = true
        streamSnapshotRef.current.version += 1
        setStatusError(false)
      }
      pushEvent(payload)
      if (payload.done) void syncTask(true)
    }
    es.onerror = () => {
      if (!active) return
      if (doneRef.current) {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        return
      }
      sseHealthyRef.current = false
      streamSnapshotRef.current.received = false
    }

    void syncTask()
    const poll = window.setInterval(async () => {
      if (!active) return
      if ((doneRef.current && statusNeedsRetry) || (!doneRef.current && (!sseHealthyRef.current || !streamSnapshotRef.current.received
        || Date.now() - lastStatusRead >= 15000))) {
        await syncTask(true)
      }
      if (active && ((!doneRef.current && !sseHealthyRef.current) || logsNeedRetry)) await syncEvents()
    }, 1000)

    return () => {
      active = false
      copyGenerationRef.current += 1
      sseHealthyRef.current = false
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      window.clearInterval(poll)
      for (const [controller, timer] of requests) {
        clearTimeout(timer)
        controller.abort()
      }
      requests.clear()
    }
  }, [taskId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const currentStatus = doneStatus || task?.status || ''
  const progress = task?.progress_detail || {}
  const progressTotal = Number(progress.total || 0)
  const progressCurrent = Number(progress.current || 0)
  const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressCurrent / progressTotal) * 100)) : 0
  const verificationHold = task?.result?.verification_hold
  const errorText = verificationHold?.active ? verificationHold.reason : task?.error || (Array.isArray(task?.errors) ? task.errors[0] : '')
  const statusTone =
    currentStatus === 'succeeded' ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200' :
    currentStatus === 'failed' ? 'border-red-400/40 bg-red-400/10 text-red-200' :
    currentStatus === 'paused' || currentStatus === 'cancelled' || currentStatus === 'interrupted' ? 'border-amber-400/40 bg-amber-400/10 text-amber-200' :
    'border-sky-400/40 bg-sky-400/10 text-sky-200'

  const copyLogs = async () => {
    if (lines.length === 0) return
    const generation = ++copyGenerationRef.current
    setCopyStatus('')
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      if (generation !== copyGenerationRef.current) return
      setCopyStatus('日志已复制')
      return
    } catch {
      // Clipboard API may be unavailable on HTTP or denied by browser permissions.
    }
    if (generation !== copyGenerationRef.current) return
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
      setCopyStatus('日志已复制')
    } catch {
      setCopyStatus('复制失败，请手动选择日志复制')
    } finally {
      el.remove()
      activeElement?.focus()
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className={`rounded-2xl border px-4 py-3 ${statusTone}`}>
          <div className="text-[11px] uppercase tracking-[0.18em] opacity-70">Status</div>
          <div className="mt-1 text-sm font-semibold">{currentStatus ? getTaskStatusText(currentStatus) : '正在读取任务状态...'}</div>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-hover)] px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">Progress</div>
          <div className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{progress.label || task?.progress || '0/0'}</div>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-hover)] px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">Events</div>
          <div className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{lines.length} 条日志</div>
        </div>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-hover)] ring-1 ring-[var(--border)]">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            currentStatus === 'failed' ? 'bg-red-400' :
            currentStatus === 'succeeded' ? 'bg-emerald-400' :
            currentStatus === 'paused' ? 'bg-amber-400' :
            'bg-sky-400'
          }`}
          style={{ width: `${progressTotal > 0 ? progressPercent : (isTerminalTaskStatus(currentStatus) ? 100 : 18)}%` }}
        />
      </div>

      {currentStatus === 'pending' || currentStatus === 'cancel_requested' ? (
        <div role="status" className="rounded-2xl border border-sky-400/25 bg-sky-400/5 px-4 py-3 text-sm text-[var(--text-secondary)]">
          {currentStatus === 'pending'
            ? '任务排队中，可能正在等待同平台或同账号的任务释放执行槽。关闭窗口不会取消任务。'
            : '取消请求已提交；当前步骤退出后才会结束任务并释放执行槽。'}
        </div>
      ) : null}

      {statusError && <p role="alert" className="text-xs text-amber-300">暂时无法更新任务详情，正在重试；已确认的任务状态保持不变。</p>}
      {logError && <p role="alert" className="text-xs text-amber-300">部分日志暂时无法读取，正在重试；任务状态单独确认。</p>}

      {errorText ? (
        <div className={`rounded-2xl border px-4 py-3 text-sm ${verificationHold?.active || currentStatus === 'paused' ? 'border-amber-400/35 bg-amber-500/10 text-amber-100' : 'border-red-400/35 bg-red-500/10 text-red-100'}`}>
          <div className="mb-1 font-semibold">{verificationHold?.active || currentStatus === 'paused' ? '暂停原因' : '失败原因'}</div>
          <div className="break-words opacity-85">{errorText}</div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">Live Log</div>
          <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">实时执行日志</div>
        </div>
        <span role="status" aria-live="polite" className="text-xs text-[var(--text-secondary)]">{copyStatus}</span>
        <button
          type="button"
          onClick={copyLogs}
          disabled={lines.length === 0}
          className="rounded-full border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          复制日志
        </button>
      </div>

      <div className="min-h-[260px] flex-1 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-input)] p-4 font-mono text-xs ">
        {lines.length === 0 && (
          <div className="flex h-full min-h-[180px] items-center justify-center rounded-2xl border border-dashed border-[var(--border)] text-[var(--text-muted)]">
            等待任务日志...
          </div>
        )}
        <div className="space-y-1.5">
          {lines.map((line, index) => (
            <div
              key={index}
              className={`rounded-xl border border-white/5 bg-white/[0.025] px-3 py-2 leading-5 ${
                line.includes('✓') || line.includes('成功') ? 'text-emerald-400' :
                line.includes('✗') || line.includes('失败') || line.includes('错误') ? 'text-red-400' :
                'text-[var(--text-secondary)]'
              }`}
            >
              {line}
            </div>
          ))}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
