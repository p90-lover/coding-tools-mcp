import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RefreshCw, CheckCircle, XCircle } from 'lucide-react'
import { getPlatforms, invalidatePlatformsCache } from '@/lib/app-data'
import type { ChoiceOption } from '@/lib/config-options'
import { Save } from 'lucide-react'

function SolverPanel() {
  const [status, setStatus] = useState<any>(null)
  const [checking, setChecking] = useState(true)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState('')
  const mountedRef = useRef(true)
  const checkPendingRef = useRef(false)
  const restartPendingRef = useRef(false)

  const checkSolver = useCallback(async () => {
    if (!mountedRef.current || checkPendingRef.current) return
    checkPendingRef.current = true
    setChecking(true)
    try {
      const result = await apiFetch('/solver/status')
      if (mountedRef.current) {
        setStatus(result)
        setError('')
      }
    } catch (error) {
      if (mountedRef.current) setError(error instanceof Error ? error.message : '无法读取求解器状态')
    } finally {
      checkPendingRef.current = false
      if (mountedRef.current) setChecking(false)
    }
  }, [])

  const restartSolver = async () => {
    if (restartPendingRef.current || checkPendingRef.current || !status || status.disabled || status.restarting) return
    restartPendingRef.current = true
    setRestarting(true)
    setError('')
    try {
      const result = await apiFetch('/solver/restart', { method: 'POST' })
      if (!mountedRef.current) return
      if (result.disabled) setStatus({ running: false, disabled: true, message: result.message })
      else if (result.ok === false) setError(result.error || result.message || '重启请求失败')
      else await checkSolver()
    } catch (error) {
      if (mountedRef.current) setError(error instanceof Error ? error.message : '重启结果未知，请刷新状态')
    } finally {
      restartPendingRef.current = false
      if (mountedRef.current) setRestarting(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    void checkSolver()
    return () => { mountedRef.current = false }
  }, [checkSolver])

  useEffect(() => {
    if (!status?.restarting) return
    const timer = window.setInterval(() => void checkSolver(), 2000)
    return () => window.clearInterval(timer)
  }, [status?.restarting, checkSolver])

  const busy = restarting || Boolean(status?.restarting)
  const solverLabel = status?.disabled ? '已禁用' : busy ? '重启中' : !status ? checking ? '检测中' : '状态未知' : status.running ? '运行中' : '未运行'
  return (
    <section>
      <h2 className="text-base font-semibold text-[var(--text-primary)]">Turnstile 求解器</h2>
      <p className="mt-1 text-sm text-[var(--text-muted)]">本地 Turnstile 验证码求解服务状态。</p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div role="status" className="flex items-center gap-2">
          {checking || busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : status?.running ? <CheckCircle className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-[var(--text-muted)]" />}
          <span className={cn('text-sm font-medium', status?.running ? 'text-emerald-400' : 'text-[var(--text-secondary)]')}>{solverLabel}</span>
        </div>
        <Button variant="outline" size="sm" disabled={checking || restarting} onClick={() => { if (!restartPendingRef.current) void checkSolver() }}>刷新状态</Button>
        <Button variant="outline" size="sm" onClick={restartSolver} disabled={checking || busy || !status || status.disabled}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />重启 Solver
        </Button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
      {(status?.message || status?.last_error) && <p className="mt-3 text-sm text-[var(--text-muted)]">{status.message || status.last_error}</p>}
    </section>
  )
}

function PlatformCapsPanel() {
  const [platforms, setPlatforms] = useState<any[]>([])
  const [drafts, setDrafts] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const pendingKeysRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)

  useEffect(() => {
    let active = true
    mountedRef.current = true
    setLoading(true)
    setLoadError('')
    getPlatforms({ force: loadAttempt > 0 }).then(list => {
      if (!active) return
      setPlatforms(list)
      const initial: Record<string, any> = {}
      list.forEach(platform => {
        initial[platform.name] = {
          supported_executors: [...platform.supported_executors],
          supported_identity_modes: [...platform.supported_identity_modes],
          supported_oauth_providers: [...platform.supported_oauth_providers],
        }
      })
      setDrafts(initial)
    }).catch(error => {
      if (active) setLoadError(error instanceof Error ? error.message : '加载平台能力失败')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false; mountedRef.current = false }
  }, [loadAttempt])

  const toggle = (name: string, field: string, value: string) => {
    if (pendingKeysRef.current.has(name)) return
    setSaved(current => ({ ...current, [name]: false }))
    setDrafts((d) => {
      const arr: string[] = [...(d[name]?.[field] || [])]
      const idx = arr.indexOf(value)
      if (idx >= 0) arr.splice(idx, 1)
      else arr.push(value)
      return { ...d, [name]: { ...d[name], [field]: arr } }
    })
  }

  const save = async (name: string) => {
    if (pendingKeysRef.current.has(name)) return
    pendingKeysRef.current.add(name)
    setSaving(current => ({ ...current, [name]: true }))
    setSaved(current => ({ ...current, [name]: false }))
    setErrors(current => ({ ...current, [name]: '' }))
    try {
      await apiFetch(`/platforms/${name}/capabilities`, {
        method: 'PUT', body: JSON.stringify(drafts[name]),
      })
      invalidatePlatformsCache()
      if (mountedRef.current) setSaved(current => ({ ...current, [name]: true }))
    } catch (error) {
      if (mountedRef.current) setErrors(current => ({ ...current, [name]: error instanceof Error ? error.message : '保存平台能力失败' }))
    } finally {
      pendingKeysRef.current.delete(name)
      if (mountedRef.current) setSaving(current => ({ ...current, [name]: false }))
    }
  }

  const reset = async (name: string) => {
    if (pendingKeysRef.current.has(name)) return
    pendingKeysRef.current.add(name)
    setSaving(current => ({ ...current, [name]: true }))
    setSaved(current => ({ ...current, [name]: false }))
    setErrors(current => ({ ...current, [name]: '' }))
    try {
      await apiFetch(`/platforms/${name}/capabilities`, { method: 'DELETE' })
      invalidatePlatformsCache()
      const list = await getPlatforms({ force: true })
      if (!mountedRef.current) return
      const platform = list.find(item => item.name === name)
      if (!platform) throw new Error('默认值已提交，但未读取到平台，请重试')
      setDrafts(current => ({
        ...current,
        [name]: {
          supported_executors: [...platform.supported_executors],
          supported_identity_modes: [...platform.supported_identity_modes],
          supported_oauth_providers: [...platform.supported_oauth_providers],
        },
      }))
      setPlatforms(current => current.map(item => item.name === name ? platform : item))
    } catch (error) {
      if (mountedRef.current) setErrors(current => ({ ...current, [name]: error instanceof Error ? error.message : '恢复默认失败，请重试' }))
    } finally {
      pendingKeysRef.current.delete(name)
      if (mountedRef.current) setSaving(current => ({ ...current, [name]: false }))
    }
  }

  return (
    <section>
      <h2 className="text-base font-semibold text-[var(--text-primary)]">平台能力</h2>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        自定义各平台支持的执行方式、注册身份和第三方入口。
      </p>
      {(loading || loadError) && <div role={loadError ? 'alert' : 'status'} className="mt-4 text-sm text-amber-500">
        {loadError || '正在加载平台能力...'}
        {loadError && <Button variant="outline" className="mt-2 block" onClick={() => setLoadAttempt(attempt => attempt + 1)}>重新加载平台能力</Button>}
      </div>}
      <div className="mt-4 space-y-4">
        {platforms.map((p) => {
          const draft = drafts[p.name] || {}
          const executors: string[] = draft.supported_executors || []
          const modes: string[] = draft.supported_identity_modes || []
          const oauths: string[] = draft.supported_oauth_providers || []
          const executorOptions: ChoiceOption[] = p.supported_executor_options || []
          const identityOptions: ChoiceOption[] = p.supported_identity_mode_options || []
          const oauthOptions: ChoiceOption[] = p.supported_oauth_provider_options || []
          return (
            <fieldset disabled={loading || Boolean(saving[p.name])}
              key={p.name}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5"
            >
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    {p.display_name}
                  </h3>
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                    {p.name} v{p.version}
                  </p>
                </div>
                <button disabled={saving[p.name]} onClick={() => void reset(p.name)} className="table-action-btn">
                  恢复默认
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="mb-2 text-xs text-[var(--text-muted)]">执行方式</p>
                  <div className="flex flex-wrap gap-4">
                    {executorOptions.map((option) => (
                      <label
                        key={option.value}
                        className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-secondary)]"
                      >
                        <input
                          type="checkbox"
                          checked={executors.includes(option.value)}
                          onChange={() => toggle(p.name, 'supported_executors', option.value)}
                          className="checkbox-accent"
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs text-[var(--text-muted)]">注册身份</p>
                  <div className="flex flex-wrap gap-4">
                    {identityOptions.map((option) => (
                      <label
                        key={option.value}
                        className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-secondary)]"
                      >
                        <input
                          type="checkbox"
                          checked={modes.includes(option.value)}
                          onChange={() => toggle(p.name, 'supported_identity_modes', option.value)}
                          className="checkbox-accent"
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs text-[var(--text-muted)]">第三方入口</p>
                  <div className="flex flex-wrap gap-4">
                    {oauthOptions.map((option) => (
                      <label
                        key={option.value}
                        className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-secondary)]"
                      >
                        <input
                          type="checkbox"
                          checked={oauths.includes(option.value)}
                          onChange={() =>
                            toggle(p.name, 'supported_oauth_providers', option.value)
                          }
                          className="checkbox-accent"
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              {errors[p.name] && <p role="alert" className="mt-3 text-sm text-red-400">{errors[p.name]}</p>}
              <div className="mt-4">
                <Button size="sm" onClick={() => save(p.name)} disabled={saving[p.name]}>
                  <Save className="mr-1 h-3.5 w-3.5" />
                  {saved[p.name] ? '已保存 ✓' : saving[p.name] ? '保存中...' : '保存'}
                </Button>
              </div>
            </fieldset>
          )
        })}
      </div>
    </section>
  )
}

export default function AdvancedSettings() {
  return (
    <div className="space-y-8">
      <SolverPanel />
      <div className="border-t border-[var(--border)]" />
      <PlatformCapsPanel />
    </div>
  )
}
