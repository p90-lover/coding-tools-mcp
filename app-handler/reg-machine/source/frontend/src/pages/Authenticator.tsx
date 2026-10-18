import { useEffect, useState } from 'react'
import { Copy, RefreshCw, ShieldCheck, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch, cn } from '@/lib/utils'

type Entry = {
  id: string
  issuer: string
  label: string
  code: string
  period: number
  remaining: number
  expires_at?: number
  source: 'vault' | 'registration'
  verified: boolean | null
}
type VaultData = {
  native: { status: string; message: string; target?: string }
  entries: Entry[]
  fetched_at: number
}

function codeRemaining(entry: Entry, timestamp: number, fetchedAt: number) {
  const deadline = entry.expires_at ?? fetchedAt + entry.remaining
  if (!Number.isFinite(deadline)) return 0
  return Math.max(0, Math.ceil(deadline - timestamp / 1000))
}

export default function Authenticator() {
  const [data, setData] = useState<VaultData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let active = true
    let inFlight = false
    const controller = new AbortController()
    const load = async () => {
      if (inFlight || document.hidden) return
      inFlight = true
      setLoading(true)
      try {
        const result: VaultData = await apiFetch('/authenticator/entries', { signal: controller.signal, cache: 'no-store', headers: { 'X-Requested-With': 'reg-machine-authenticator' } })
        if (active) {
          setData(result)
          setNow(Date.now())
          setError('')
        }
      } catch {
        if (active) {
          setData(null)
          setError('无法读取验证码，请检查后端服务并重试。')
        }
      } finally {
        inFlight = false
        if (active) setLoading(false)
      }
    }
    void load()
    const poll = window.setInterval(() => void load(), 5000)
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    const onVisible = () => { if (!document.hidden) { setNow(Date.now()); void load() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      controller.abort()
      window.clearInterval(poll)
      window.clearInterval(clock)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  const copy = async (entry: Entry) => {
    const timestamp = Date.now()
    if (!entry.code || codeRemaining(entry, timestamp, data?.fetched_at ?? 0) <= 0) {
      setNow(timestamp)
      setNotice('验证码已过期，请等待刷新后重试。')
      return
    }
    try {
      await navigator.clipboard.writeText(entry.code)
      if (codeRemaining(entry, Date.now(), data?.fetched_at ?? 0) <= 0) {
        setNow(Date.now())
        setNotice('验证码已过期，请等待刷新后重试。')
      } else {
        setNotice('验证码已复制')
      }
    } catch {
      setNotice('复制失败，请手动选择验证码复制。')
    }
  }
  const query = search.trim().toLowerCase()
  const entries = (data?.entries || []).filter((entry) =>
    `${entry.issuer} ${entry.label}`.toLowerCase().includes(query)
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--text-primary)]">
            <ShieldCheck className="h-5 w-5 text-[var(--accent)]" />2FA 验证器
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">自动登录现有加密验证器，同时显示本机注册记录的动态验证码。</p>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
          {loading ? '刷新中' : '刷新'}
        </Button>
      </div>

      {data && (
        <div role="status" className={cn('rounded-lg border px-4 py-3 text-sm',
          data.native.status === 'ready'
            ? 'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
            : 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400')}>
          <p>{data.native.message}</p>
          {data.native.target && <p className="mt-1 text-xs opacity-75">{data.native.target}</p>}
        </div>
      )}
      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</p>}
      <p role="status" className="text-xs text-[var(--text-muted)]">{notice || '验证码每 5 秒自动刷新；到期后暂停复制，等待新验证码。'}</p>

      <label className="relative block max-w-md">
        <span className="sr-only">搜索验证器账号</span>
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[var(--text-muted)]" />
        <input value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索账号或服务" className="control-surface w-full pl-9!" />
      </label>

      {!data && loading && <p className="text-sm text-[var(--text-muted)]">正在连接本地验证器…</p>}
      {data && entries.length === 0 && (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
          {query ? '没有匹配的账号' : '暂无验证码记录；注册完成并保存 2FA 密钥后会在这里显示。'}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {entries.map((entry) => {
          const remaining = codeRemaining(entry, now, data?.fetched_at ?? 0)
          const usable = Boolean(entry.code) && remaining > 0
          return (
            <article key={entry.id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
              <p className="text-xs font-medium text-[var(--text-muted)]">{entry.issuer || '验证器'}</p>
              <h2 className="mt-1 break-all text-sm font-semibold text-[var(--text-primary)]">{entry.label}</h2>
              <p className={cn('mt-2 text-xs', entry.source === 'registration' && !entry.verified
                ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--text-muted)]')}>
                {entry.source === 'vault' ? '加密验证器 · 启用状态未知'
                  : entry.verified ? '本机注册记录 · 已验证' : '本机注册记录 · 尚未验证'}
              </p>
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="select-text font-mono text-3xl font-semibold tracking-[0.15em] text-[var(--text-primary)]">
                  {usable ? entry.code : entry.code ? '等待刷新' : '密钥无效'}
                </span>
                <Button variant="outline" size="icon" disabled={!usable} onClick={() => void copy(entry)}
                  aria-label={`复制 ${entry.label} 的验证码`}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="mt-4 h-1 overflow-hidden rounded-full bg-[var(--bg-hover)]" aria-hidden="true">
                <div className="h-full bg-[var(--accent)] transition-[width] duration-1000"
                  style={{ width: `${Math.min(100, remaining / Math.max(1, entry.period) * 100)}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-[var(--text-muted)]">{remaining > 0 ? `${remaining} 秒后更新` : '正在获取新验证码…'}</p>
            </article>
          )
        })}
      </div>
    </div>
  )
}
