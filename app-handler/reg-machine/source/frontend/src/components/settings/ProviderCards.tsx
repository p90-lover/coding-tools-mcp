import { useId, useState, useEffect, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { apiFetch } from '@/lib/utils'
import { getProviderFieldOptions, type ProviderOption, type ProviderSetting } from '@/lib/config-options'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Save, Eye, EyeOff, X, Pencil, Plus, Trash2, FlaskConical, Search } from 'lucide-react'
import { invalidateConfigOptionsCache } from '@/lib/app-data'

const CATEGORY_GROUPS = [
  { key: 'free', label: '免费 / 开箱即用', desc: '无需自建服务，直接使用' },
  { key: 'selfhost', label: '需要自建服务', desc: '需要自行部署后端服务' },
  { key: 'thirdparty', label: '第三方服务', desc: '需要注册第三方平台获取凭据' },
  { key: 'custom', label: '自定义', desc: '通过通用 HTTP 驱动对接任意 API' },
]

/* ------------------------------------------------------------------ */
/*  Toggle                                                             */
/* ------------------------------------------------------------------ */
function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      } ${checked ? 'bg-[var(--accent)]' : 'bg-[var(--chip-bg)] border border-[var(--border)]'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Searchable Select                                                  */
/* ------------------------------------------------------------------ */
function SearchableSelect({ value, options, placeholder, label, onChange }: {
  value: string
  options: Array<{ value: string; label: string }>
  placeholder?: string
  label: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const filtered = search
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()) || o.value.includes(search))
    : options
  const selectedLabel = options.find(o => o.value === value)?.label || value

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !containerRef.current?.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('keydown', dismiss, true)
    return () => window.removeEventListener('keydown', dismiss, true)
  }, [open])

  useEffect(() => {
    if (open) document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, search, listboxId])

  const chooseOption = (next: string) => {
    onChange(next)
    setOpen(false)
    setSearch('')
    triggerRef.current?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setSearch('')
        setActiveIndex(Math.max(0, options.findIndex(option => option.value === value)))
        setOpen(true)
      } else {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex(current => filtered.length ? (current + direction + filtered.length) % filtered.length : 0)
      }
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      if (filtered[activeIndex]) chooseOption(filtered[activeIndex].value)
    }
  }

  return (
    <div ref={containerRef} className="relative"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) window.setTimeout(() => setOpen(false), 0) }}>
      <button ref={triggerRef} type="button" aria-label={`${label}: ${selectedLabel || placeholder || '未选择'}`}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listboxId : undefined}
        onKeyDown={handleKeyDown}
        onClick={() => { setOpen(!open); setSearch(''); setActiveIndex(Math.max(0, options.findIndex(option => option.value === value))) }}
        className="control-surface w-full text-left flex items-center justify-between"
      >
        <span className={selectedLabel ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}>
          {selectedLabel || placeholder || '请选择...'}
        </span>
        <svg className="h-4 w-4 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={open ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'} />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-pane)] shadow-lg">
          <div className="p-2 border-b border-[var(--border)]">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-muted)]" />
              <input ref={inputRef} type="text" role="combobox" aria-label={`搜索${label}`}
                aria-expanded={true} aria-controls={listboxId} aria-autocomplete="list"
                aria-activedescendant={filtered[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
                value={search} onChange={e => { setSearch(e.target.value); setActiveIndex(0) }}
                onKeyDown={handleKeyDown} placeholder="搜索..."
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-base)] pl-8 pr-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
            </div>
          </div>
          <div id={listboxId} role="listbox" aria-label={label} className="max-h-48 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-[var(--text-muted)]">无匹配结果</div>
            ) : filtered.map((o, index) => (
              <button key={o.value} id={`${listboxId}-option-${index}`} type="button" role="option"
                aria-selected={index === activeIndex} tabIndex={-1}
                onMouseMove={() => setActiveIndex(index)} onClick={() => chooseOption(o.value)}
                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--chip-bg)] ${index === activeIndex ? 'bg-[var(--chip-bg)]' : ''} ${o.value === value ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-primary)]'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Edit modal                                                         */
/* ------------------------------------------------------------------ */
function EditModal({
  provider, setting, providerType, onClose, onSaved,
}: {
  provider: ProviderOption; setting: ProviderSetting | null; providerType: string
  onClose: () => void; onSaved: () => Promise<void>
}) {
  const fields = provider.fields || []
  const [form, setForm] = useState<Record<string, string>>(() => {
    const data: Record<string, string> = {}
    for (const field of fields) {
      data[field.key] = (setting?.auth?.[field.key] || '') || (setting?.config?.[field.key] || '')
    }
    return data
  })
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)
  const [asyncOptions, setAsyncOptions] = useState<Record<string, Array<{ value: string; label: string }>>>({})
  const [asyncLoading, setAsyncLoading] = useState<Record<string, boolean>>({})
  const [asyncErrors, setAsyncErrors] = useState<Record<string, string>>({})
  const [saveError, setSaveError] = useState('')
  const mountedRef = useRef(true)
  const savePendingRef = useRef(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const testPendingRef = useRef(false)
  const close = () => { if (!savePendingRef.current) onClose() }

  useEffect(() => {
    let active = true
    mountedRef.current = true
    for (const field of fields) {
      if (field.type !== 'async-select' || !field.asyncUrl) continue
      setAsyncLoading(prev => ({ ...prev, [field.key]: true }))
      apiFetch(field.asyncUrl).then(data => {
        if (!active) return
        const options = getProviderFieldOptions(data, field)
        setAsyncOptions(prev => ({ ...prev, [field.key]: options }))
        if (!options.length) setAsyncErrors(prev => ({ ...prev, [field.key]: '没有可用选项，可直接填写代码或 ID' }))
      }).catch(() => {
        if (active) setAsyncErrors(prev => ({ ...prev, [field.key]: '加载选项失败，可直接填写代码或 ID' }))
      }).finally(() => {
        if (active) setAsyncLoading(prev => ({ ...prev, [field.key]: false }))
      })
    }
    return () => { active = false; mountedRef.current = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (savePendingRef.current || testPendingRef.current) return
    savePendingRef.current = true
    const config: Record<string, string> = { ...(setting?.config || {}) }
    const auth: Record<string, string> = { ...(setting?.auth || {}) }
    for (const field of fields) {
      if (field.category === 'auth' || (!field.category && field.secret)) {
        auth[field.key] = form[field.key] || ''
        delete config[field.key]
      }
      else {
        config[field.key] = form[field.key] || ''
        delete auth[field.key]
      }
    }
    setSaving(true)
    setSaved(false)
    setSaveError('')
    try {
      if (setting) {
        await apiFetch('/provider-settings', {
          method: 'PUT',
          body: JSON.stringify({
            id: setting.id, provider_type: providerType, provider_key: provider.value,
            display_name: setting.display_name || provider.label,
            auth_mode: setting.auth_mode || provider.default_auth_mode || '',
            enabled: setting.enabled, is_default: setting.is_default, config, auth, metadata: setting.metadata || {},
          }),
        })
      } else {
        await apiFetch('/provider-settings', {
          method: 'POST',
          body: JSON.stringify({
            provider_type: providerType, provider_key: provider.value,
            display_name: provider.label, auth_mode: provider.default_auth_mode || '',
            enabled: true, is_default: false, config, auth, metadata: {},
          }),
        })
      }
      invalidateConfigOptionsCache()
      if (!mountedRef.current) return
      setSaved(true)
      await onSaved()
      if (mountedRef.current) onClose()
    } catch (error) {
      if (mountedRef.current) setSaveError(error instanceof Error ? error.message : '保存 provider 配置失败')
    } finally {
      savePendingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  const handleTest = async () => {
    if (testPendingRef.current || savePendingRef.current) return
    testPendingRef.current = true
    const config: Record<string, string> = { ...(setting?.config || {}) }
    const auth: Record<string, string> = { ...(setting?.auth || {}) }
    for (const field of fields) {
      if (field.category === 'auth' || (!field.category && field.secret)) {
        auth[field.key] = form[field.key] || ''
        delete config[field.key]
      }
      else {
        config[field.key] = form[field.key] || ''
        delete auth[field.key]
      }
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await apiFetch('/provider-settings/test', {
        method: 'POST',
        body: JSON.stringify({
          provider_type: providerType,
          provider_key: provider.value,
          config, auth,
        }),
      })
      if (mountedRef.current) setTestResult(result)
    } catch (e: any) {
      if (mountedRef.current) setTestResult({ ok: false, error: e.message || '测试请求失败' })
    } finally {
      testPendingRef.current = false
      if (mountedRef.current) setTesting(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={value => { if (!value) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop">
          <Dialog.Content aria-describedby={undefined} aria-label={provider.label} className="dialog-panel dialog-panel-sm flex flex-col"
            onOpenAutoFocus={() => { returnFocusRef.current = document.activeElement as HTMLElement }}
            onCloseAutoFocus={event => { event.preventDefault(); returnFocusRef.current?.focus() }}
            onEscapeKeyDown={event => { if (savePendingRef.current) event.preventDefault() }}
            onPointerDownOutside={event => { if (savePendingRef.current) event.preventDefault() }}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
              <div>
                <Dialog.Title asChild><h2 className="text-base font-semibold text-[var(--text-primary)]">{provider.label}</h2></Dialog.Title>
                {provider.description && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{provider.description}</p>}
              </div>
              <button aria-label="关闭配置" disabled={saving} onClick={close} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X className="h-4 w-4" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <fieldset disabled={saving || testing} className="min-w-0 px-5 py-4 space-y-4">
                {fields.length === 0 ? (
                  <p className="text-sm text-[var(--text-muted)]">此服务无需额外配置。</p>
                ) : fields.map(field => {
                  const sk = `${provider.value}:${field.key}`
                  return (
                    <div key={field.key}>
                      <label className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">{field.label}</label>
                      {field.hint && <p className="mb-1.5 text-xs text-[var(--text-muted)]">{field.hint}</p>}
                      <div className="relative">
                        {field.type === 'toggle' ? (
                          <div className="flex items-center gap-3">
                            <Toggle label={field.label}
                              checked={['true', '1', 'yes', 'on'].includes((form[field.key] || '').toLowerCase())}
                              onChange={v => setForm(f => ({ ...f, [field.key]: v ? 'true' : 'false' }))}
                            />
                            <span className="text-sm text-[var(--text-muted)]">
                              {['true', '1', 'yes', 'on'].includes((form[field.key] || '').toLowerCase()) ? '已启用' : '未启用'}
                            </span>
                          </div>
                        ) : field.type === 'async-select' ? (
                          asyncLoading[field.key] ? (
                            <div className="control-surface text-[var(--text-muted)] text-sm py-2">加载中...</div>
                          ) : asyncErrors[field.key] ? (
                            <>
                              <input aria-label={field.label} value={form[field.key] || ''} className="control-surface"
                                onChange={event => setForm(current => ({ ...current, [field.key]: event.target.value }))} />
                              <p role="status" className="mt-1 text-xs text-amber-500">{asyncErrors[field.key]}</p>
                            </>
                          ) : (
                            <SearchableSelect label={field.label}
                              value={form[field.key] || ''}
                              options={asyncOptions[field.key] || []}
                              placeholder={field.placeholder}
                              onChange={v => setForm(f => ({ ...f, [field.key]: v }))}
                            />
                          )
                        ) : field.type === 'select' && field.options?.length ? (
                          <select aria-label={field.label} value={form[field.key] || ''} onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))} className="control-surface appearance-none">
                            {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        ) : field.type === 'textarea' ? (
                          <textarea aria-label={field.label}
                            value={form[field.key] || ''}
                            onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                            placeholder={field.placeholder || ''}
                            className="control-surface min-h-32 font-mono text-xs"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                          />
                        ) : (
                          <>
                            <input aria-label={field.label} type={field.secret && !showSecret[sk] ? 'password' : 'text'} value={form[field.key] || ''}
                              onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                              placeholder={field.placeholder || ''} className="control-surface pr-9!" autoComplete="new-password"
                              data-1p-ignore data-lpignore="true" />
                            {field.secret && (
                              <button type="button" aria-label={`${showSecret[sk] ? '隐藏' : '显示'}${field.label}`} onClick={() => setShowSecret(s => ({ ...s, [sk]: !s[sk] }))}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                                {showSecret[sk] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </fieldset>
            </div>
            {saveError && <p role="alert" className="mx-5 text-sm text-red-400">{saveError}</p>}
            {/* Test result */}
            {testResult && (
              <div className={`mx-5 rounded-lg px-3 py-2 text-xs ${
                testResult.ok
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400'
              }`}>
                {testResult.ok ? testResult.message : testResult.error}
              </div>
            )}

            {/* Footer */}
            <div className="flex gap-2 border-t border-[var(--border)] px-5 py-3">
              <Button onClick={handleSave} disabled={saving || testing} className="flex-1">
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {saved ? '已保存 ✓' : saving ? '保存中...' : '保存'}
              </Button>
              <Button variant="outline" onClick={handleTest} disabled={saving || testing || fields.length === 0} className="flex-1">
                <FlaskConical className="h-3.5 w-3.5 mr-1.5" />
                {testing ? '测试中...' : '测试连接'}
              </Button>
              <Button variant="outline" disabled={saving} onClick={close}>取消</Button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */
type Props = {
  providerType: string
  catalog: ProviderOption[]
  settings: ProviderSetting[]
  onReload: () => Promise<void>
  onCreateCustom?: () => void
}

export default function ProviderCards({ providerType, catalog, settings, onReload, onCreateCustom }: Props) {
  const [editTarget, setEditTarget] = useState<{ provider: ProviderOption; setting: ProviderSetting | null } | null>(null)
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message?: string; error?: string }>>({})
  const [testingKeys, setTestingKeys] = useState<Record<string, boolean>>({})
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const pendingKeysRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const settingsMap: Record<string, ProviderSetting> = {}
  for (const s of settings) settingsMap[s.provider_key] = s
  const defaultKey = settings.find(s => s.is_default)?.provider_key || ''

  const grouped: Record<string, ProviderOption[]> = {}
  for (const p of catalog) {
    const cat = p.category || 'custom'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(p)
  }

  const withLoading = async (key: string, fn: () => Promise<void>) => {
    if (!mountedRef.current || pendingKeysRef.current.has(key)) return
    pendingKeysRef.current.add(key)
    setLoading(p => ({ ...p, [key]: true }))
    setActionErrors(p => ({ ...p, [key]: '' }))
    setTestResults(p => { const next = { ...p }; delete next[key]; return next })
    try {
      await fn()
    } catch (error) {
      if (mountedRef.current) setActionErrors(p => ({ ...p, [key]: error instanceof Error ? error.message : '操作失败，请重试' }))
    } finally {
      pendingKeysRef.current.delete(key)
      if (mountedRef.current) setLoading(p => ({ ...p, [key]: false }))
    }
  }

  const handleToggle = (provider: ProviderOption, enable: boolean) => withLoading(provider.value, async () => {
    const setting = settingsMap[provider.value]
    if (enable && !setting) {
      await apiFetch('/provider-settings', {
        method: 'POST',
        body: JSON.stringify({
          provider_type: providerType, provider_key: provider.value,
          display_name: provider.label, auth_mode: provider.default_auth_mode || '',
          enabled: true, is_default: settings.length === 0, config: {}, auth: {}, metadata: {},
        }),
      })
    } else if (setting) {
      await apiFetch('/provider-settings', {
        method: 'PUT',
        body: JSON.stringify({ ...setting, provider_type: providerType,
          provider_key: provider.value, enabled: enable }),
      })
    }
    invalidateConfigOptionsCache()
    await onReload()
  })

  const handleSetDefault = (provider: ProviderOption) => withLoading(provider.value, async () => {
    const setting = settingsMap[provider.value]
    if (!setting) return
    await apiFetch('/provider-settings', {
      method: 'PUT',
      body: JSON.stringify({
        id: setting.id, provider_type: providerType, provider_key: provider.value,
        display_name: setting.display_name, auth_mode: setting.auth_mode,
        enabled: true, is_default: true, config: setting.config, auth: setting.auth, metadata: setting.metadata || {},
      }),
    })
    invalidateConfigOptionsCache()
    await onReload()
  })

  const handleTestInline = async (provider: ProviderOption) => {
    const setting = settingsMap[provider.value]
    if (!setting || pendingKeysRef.current.has(provider.value)) return
    const key = provider.value
    pendingKeysRef.current.add(key)
    setTestingKeys(p => ({ ...p, [key]: true }))
    setTestResults(p => { const n = { ...p }; delete n[key]; return n })
    try {
      const result = await apiFetch('/provider-settings/test', {
        method: 'POST',
        body: JSON.stringify({
          provider_type: providerType,
          provider_key: key,
          config: setting.config || {},
          auth: setting.auth || {},
        }),
      })
      setTestResults(p => ({ ...p, [key]: result }))
    } catch (e: any) {
      setTestResults(p => ({ ...p, [key]: { ok: false, error: e.message || '测试失败' } }))
    } finally {
      pendingKeysRef.current.delete(key)
      if (mountedRef.current) setTestingKeys(p => ({ ...p, [key]: false }))
    }
  }

  const handleDelete = (provider: ProviderOption) => withLoading(provider.value, async () => {
    const setting = settingsMap[provider.value]
    if (setting) await apiFetch(`/provider-settings/${setting.id}`, { method: 'DELETE' })
    let definitionError = ''
    if (!provider.is_builtin && (provider as any).id) {
      try {
        await apiFetch(`/provider-definitions/${(provider as any).id}`, { method: 'DELETE' })
      } catch (error) {
        definitionError = error instanceof Error ? error.message : '删除服务定义失败'
      }
    }
    invalidateConfigOptionsCache()
    await onReload()
    if (definitionError) throw new Error(`配置已移除，但服务定义删除失败：${definitionError}。可再次点击删除重试。`)
  })

  const renderCard = (provider: ProviderOption, allowDelete = false) => {
    const key = provider.value
    const setting = settingsMap[key]
    const isEnabled = Boolean(setting?.enabled)
    const isDefault = key === defaultKey
    const hasFields = (provider.fields || []).length > 0
    const busy = Boolean(loading[key] || testingKeys[key])
    const deletable = Boolean(setting || (!provider.is_builtin && (provider as any).id))

    return (
      <div key={key}>
        <div role="group" aria-label={provider.label} className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
          {/* Left: name + desc + badge */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{provider.label}</span>
              {isDefault && <Badge variant="success">默认</Badge>}
            </div>
            {provider.description && (
              <p className="mt-0.5 text-xs text-[var(--text-muted)] line-clamp-1">{provider.description}</p>
            )}
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              aria-label={`编辑${provider.label}`}
              onClick={() => hasFields && isEnabled ? setEditTarget({ provider, setting }) : undefined}
              disabled={!hasFields || !isEnabled || busy}
              className={`table-action-btn ${(!hasFields || !isEnabled) ? 'opacity-30 cursor-not-allowed' : ''}`}
            >
              <Pencil className="h-3 w-3 mr-1" /> 编辑
            </button>

            <button
              aria-label={`测试${provider.label}`}
              onClick={() => isEnabled ? handleTestInline(provider) : undefined}
              disabled={!isEnabled || busy}
              className={`table-action-btn ${!isEnabled ? 'opacity-30 cursor-not-allowed' : ''}`}
            >
              <FlaskConical className="h-3 w-3 mr-1" /> {testingKeys[key] ? '测试中' : '测试'}
            </button>

            <button
              aria-label={isDefault ? `${provider.label}已为默认` : `设为默认${provider.label}`}
              onClick={() => isEnabled && !isDefault ? handleSetDefault(provider) : undefined}
              disabled={!isEnabled || isDefault || busy}
              className={`table-action-btn ${(!isEnabled || isDefault) ? 'opacity-30 cursor-not-allowed' : ''}`}
            >
              {isDefault ? '默认 ✓' : '设默认'}
            </button>

            {allowDelete && (
              <button
                aria-label={`删除${provider.label}`}
                onClick={() => handleDelete(provider)}
                disabled={isDefault || !deletable || busy}
                className={`table-action-btn table-action-btn-danger ${(isDefault || !deletable) ? 'opacity-30 cursor-not-allowed' : ''}`}
              >
                <Trash2 className="h-3 w-3 mr-1" /> 删除
              </button>
            )}

            <Toggle
              label={provider.label + '启用状态'} checked={isEnabled}
              onChange={v => handleToggle(provider, v)}
              disabled={busy || isDefault}
            />
          </div>
        </div>
        {actionErrors[key] && <p role="alert" className="mt-1 text-sm text-red-400">{actionErrors[key]}</p>}
        {/* Inline test result */}
        {testResults[key] && (
          <div className={`mt-1 rounded-lg px-3 py-2 text-xs ${
            testResults[key].ok
              ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
              : 'border border-red-500/20 bg-red-500/10 text-red-600'
          }`}>
            {testResults[key].ok ? testResults[key].message : testResults[key].error}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="space-y-6">
        {CATEGORY_GROUPS.map(({ key: cat, label, desc }) => {
          const providers = grouped[cat] || []
          if (providers.length === 0 && cat !== 'custom') return null

          // Hide "通用 HTTP 邮箱" from the list — it's the engine behind custom providers
          const visible = cat === 'custom'
            ? providers.filter(p => p.value !== 'generic_http_mailbox')
            : providers

          return (
            <div key={cat}>
              <div className="mb-2">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{label}</h3>
                <p className="text-xs text-[var(--text-muted)]">{desc}</p>
              </div>
              <div className="space-y-1.5">
                {visible.map(p => renderCard(p, cat === 'custom'))}
                {cat === 'custom' && (
                  <button
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    onClick={() => onCreateCustom?.()}
                  >
                    <Plus className="h-4 w-4" />
                    添加自定义{providerType === 'mailbox' ? '邮箱' : providerType === 'captcha' ? '验证' : providerType === 'sms' ? '接码' : ''}服务
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {editTarget && (
        <EditModal
          provider={editTarget.provider}
          setting={editTarget.setting}
          providerType={providerType}
          onClose={() => setEditTarget(null)}
          onSaved={onReload}
        />
      )}
    </>
  )
}
