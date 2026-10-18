import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { VerificationHold } from '@/lib/tasks'
import { getConfig, getConfigOptions, getPlatforms } from '@/lib/app-data'
import type { ConfigOptionsResponse, ProviderField, ProviderSetting } from '@/lib/config-options'
import { getCaptchaStrategyLabel, getProviderFieldOptions, getProviderSelectOptions, listProviderFieldKeys } from '@/lib/config-options'
import { apiFetch } from '@/lib/utils'
import { buildExecutorOptions, buildRegistrationOptions, hasReusableOAuthBrowser, pickOAuthExecutor, pickRegistrationPlatform } from '@/lib/registration'
import { TaskLogPanel } from '@/components/tasks/TaskLogPanel'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Play, CheckCircle, XCircle, Loader2, Orbit, Mail, ScanText, ShieldCheck, Workflow } from 'lucide-react'
import { getTaskStatusText, isTerminalTaskStatus, TASK_STATUS_VARIANTS } from '@/lib/tasks'

const DEFAULT_FORM: Record<string, any> = {
  platform: '',
  email: '',
  password: '',
  count: 1,
  concurrency: 1,
  proxy: '',
  executor_type: '',
  captcha_solver: 'auto',
  identity_provider: '',
  oauth_provider: '',
  oauth_email_hint: '',
  chrome_user_data_dir: '',
  chrome_cdp_url: '',
  mail_provider: '',
  sms_provider: '',
}

function getProviderSetting(settings: ProviderSetting[] = [], providerKey: string) {
  return settings.find(item => item.provider_key === providerKey) || null
}

function getProviderMergedValues(setting: ProviderSetting | null) {
  return {
    ...(setting?.config || {}),
    ...(setting?.auth || {}),
  }
}

function getDefaultProviderKey(settings: ProviderSetting[] = []) {
  return settings.find(item => item.is_default)?.provider_key || settings[0]?.provider_key || ''
}

function Input({ label, k, form, set, type = 'text', placeholder = '', list, max }: any) {
  return (
    <div>
      <label className="block text-xs text-[var(--text-muted)] mb-1">{label}</label>
      <input
        aria-label={label}
        list={list}
        type={type}
        value={form[k] ?? ''}
        min={type === 'number' ? 1 : undefined}
        max={max}
        step={type === 'number' ? 1 : undefined}
        onChange={e => set(k, type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
        placeholder={placeholder}
        className="control-surface"
      />
    </div>
  )
}

function Select({ label, k, form, set, options }: any) {
  return (
    <div>
      <label className="block text-xs text-[var(--text-muted)] mb-1">{label}</label>
      <select aria-label={label} value={form[k] ?? ''} onChange={e => set(k, e.target.value)}
        className="control-surface appearance-none">
        {!form[k] && <option value="">请选择{label}</option>}
        {options.map(([value, text]: any) => <option key={value} value={value}>{text}</option>)}
      </select>
    </div>
  )
}

function ProviderInput({ field, form, set }: { field: ProviderField; form: Record<string, any>; set: (key: string, value: any) => void }) {
  const choiceId = useId()
  const [choices, setChoices] = useState<Array<{ value: string; label: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (field.type !== 'async-select' || !field.asyncUrl) return
    let active = true
    setLoading(true)
    setError('')
    apiFetch(field.asyncUrl).then(data => {
      if (active) setChoices(getProviderFieldOptions(data, field))
    }).catch(() => {
      if (active) setError('无法加载选项，可直接填写服务代码或国家 ID')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [field.type, field.asyncUrl, field.asyncValueKey, field.asyncLabelKey])

  const value = form[field.key] ?? ''
  const options = field.type === 'async-select' ? choices : field.options || []
  const selectOptions = options.map(option => [option.value, option.label])
  if (value !== '' && !options.some(option => option.value === String(value))) {
    selectOptions.unshift([String(value), String(value)])
  }
  return (
    <div className="space-y-1">
      {field.type === 'toggle' ? (
        <label className="flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
          {field.label}
          <input type="checkbox" role="switch" aria-label={field.label}
            checked={['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())}
            onChange={event => set(field.key, event.target.checked ? 'true' : 'false')} />
        </label>
      ) : field.type === 'textarea' ? (
        <label className="block text-xs text-[var(--text-muted)]">
          {field.label}
          <textarea aria-label={field.label} className="control-surface mt-1" rows={3}
            value={value} placeholder={field.placeholder} onChange={event => set(field.key, event.target.value)} />
        </label>
      ) : field.type === 'async-select' ? (
        <>
          <Input label={field.label} k={field.key} form={form} set={set}
            list={choiceId} placeholder={field.placeholder || ''} />
          <datalist id={choiceId}>
            {choices.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </datalist>
        </>
      ) : field.type === 'select' && selectOptions.length > 0 ? (
        <Select label={field.label} k={field.key} form={form} set={set} options={selectOptions} />
      ) : (
        <Input label={field.label} k={field.key} form={form} set={set}
          type={field.secret ? 'password' : 'text'} placeholder={field.placeholder || ''} />
      )}
      {loading && <p role="status" className="text-xs text-[var(--text-muted)]">加载选项中...</p>}
      {error && <p role="status" className="text-xs text-amber-400">{error}</p>}
      {field.hint && <p className="text-xs text-[var(--text-muted)]">{field.hint}</p>}
    </div>
  )
}

export default function Register() {
  const [searchParams] = useSearchParams()
  const requestedPlatform = searchParams.get('platform') || ''
  const [form, setForm] = useState<Record<string, any>>(() => ({ ...DEFAULT_FORM, platform: requestedPlatform }))
  const [platforms, setPlatforms] = useState<any[]>([])
  const [configOptions, setConfigOptions] = useState<ConfigOptionsResponse>({
    mailbox_providers: [],
    captcha_providers: [],
    sms_providers: [],
    mailbox_settings: [],
    captcha_settings: [],
    sms_settings: [],
    captcha_policy: {},
    executor_options: [],
    identity_mode_options: [],
    oauth_provider_options: [],
  })
  const [optionsError, setOptionsError] = useState('')
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [restoreError, setRestoreError] = useState('')
  const editedFieldsRef = useRef<Set<string>>(new Set(requestedPlatform ? ['platform'] : []))
  const [task, setTask] = useState<any>(null)
  const [polling, setPolling] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [verificationHold, setVerificationHold] = useState<VerificationHold | null>(null)
  const [verificationHoldLoading, setVerificationHoldLoading] = useState(true)
  const [verificationHoldError, setVerificationHoldError] = useState('')
  const submitPendingRef = useRef(false)
  const activeTaskIdRef = useRef('')
  const handledTerminalTaskIdsRef = useRef<Set<string>>(new Set())
  const openedCashierTaskIdsRef = useRef<Set<string>>(new Set())

  const set = (k: string, v: any) => {
    editedFieldsRef.current.add(k)
    if (k === 'mail_provider' || k === 'sms_provider') {
      const providers = k === 'mail_provider' ? configOptions.mailbox_providers : configOptions.sms_providers
      providers?.find(provider => provider.value === v)?.fields?.forEach(field => editedFieldsRef.current.delete(field.key))
    }
    setForm(f => ({ ...f, [k]: v }))
  }

  useEffect(() => {
    let active = true
    const refreshVerificationHold = async () => {
      try {
        const data = await apiFetch('/tasks/verification-hold')
        if (active) {
          setVerificationHold(data.verification_hold || null)
          setVerificationHoldError('')
        }
      } catch {
        if (active) setVerificationHoldError('无法加载手机验证暂停状态，请刷新页面')
      } finally {
        if (active) setVerificationHoldLoading(false)
      }
    }
    void refreshVerificationHold()
    const holdInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshVerificationHold()
    }, 5000)
    return () => { active = false; window.clearInterval(holdInterval) }
  }, [])

  const applyTerminalTask = useCallback((latest: any, statusHint?: string) => {
    const latestId = String(latest?.task_id || latest?.id || task?.task_id || '')
    if (activeTaskIdRef.current && latestId !== activeTaskIdRef.current) return
    setTask(latest)
    if (latest?.result?.verification_hold?.active) setVerificationHold(latest.result.verification_hold)
    const taskKey = String(latest?.task_id || latest?.id || task?.task_id || '')
    if (!taskKey) return
    handledTerminalTaskIdsRef.current.add(taskKey)
    const resolvedStatus = statusHint || latest?.status || ''
    if (
      resolvedStatus === 'succeeded'
      && latest?.cashier_urls
      && latest.cashier_urls.length > 0
      && !openedCashierTaskIdsRef.current.has(taskKey)
    ) {
      openedCashierTaskIdsRef.current.add(taskKey)
      latest.cashier_urls.forEach((url: string) => window.open(url, '_blank'))
    }
  }, [task?.task_id])

  useEffect(() => {
    let active = true
    const force = loadAttempt > 0
    setOptionsLoading(true)
    setOptionsError('')
    Promise.all([
      getConfig({ force }),
      getPlatforms({ force }),
      getConfigOptions({ force }),
      apiFetch('/proxies'),
    ]).then(([cfg, ps, options, proxies]) => {
      if (!active) return
      if (!options || !Array.isArray(ps) || !Array.isArray(proxies)) {
        throw new Error('注册配置响应不完整')
      }
      setPlatforms(ps)
      setConfigOptions(options)
      setForm(f => {
        const defaultValue = (key: string, fallback: any) =>
          editedFieldsRef.current.has(key) ? f[key] : f[key] || fallback
        const nextForm: Record<string, any> = {
          ...f,
          proxy: defaultValue('proxy', proxies.find((proxy: any) => proxy.is_active)?.url || ''),
          executor_type: defaultValue('executor_type', cfg.default_executor || ''),
          captcha_solver: 'auto',
          identity_provider: defaultValue('identity_provider', cfg.default_identity_provider || ''),
          oauth_provider: defaultValue('oauth_provider', cfg.default_oauth_provider || ''),
          oauth_email_hint: defaultValue('oauth_email_hint', cfg.oauth_email_hint || ''),
          chrome_user_data_dir: defaultValue('chrome_user_data_dir', cfg.chrome_user_data_dir || ''),
          chrome_cdp_url: defaultValue('chrome_cdp_url', cfg.chrome_cdp_url || ''),
          mail_provider: defaultValue('mail_provider', getDefaultProviderKey(options.mailbox_settings || [])),
          sms_provider: defaultValue('sms_provider', getDefaultProviderKey(options.sms_settings || [])),
        }
        const providerFieldKeys = listProviderFieldKeys([
          ...(options.mailbox_providers || []),
          ...(options.captcha_providers || []),
          ...(options.sms_providers || []),
        ])
        providerFieldKeys.forEach(fieldKey => {
          nextForm[fieldKey] = f[fieldKey] ?? cfg[fieldKey] ?? ''
        })
        return nextForm
      })
    }).catch(error => {
      if (active) setOptionsError(`无法加载注册配置：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      if (active) setOptionsLoading(false)
    })
    return () => { active = false }
  }, [loadAttempt])

  useEffect(() => {
    let active = true
    const restoreTask = async () => {
      setRestoring(true)
      setRestoreError('')
      try {
        const savedId = sessionStorage.getItem('register-task-id')
        let restored: any = null
        if (savedId) {
          try {
            restored = await apiFetch(`/tasks/${savedId}`)
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('任务不存在')) throw error
            if (active) sessionStorage.removeItem('register-task-id')
          }
        }
        if (!restored || isTerminalTaskStatus(restored.status)) {
          const params = new URLSearchParams({
            task_type: 'register', status: 'pending,claimed,running,cancel_requested,paused',
            page: '1', page_size: '1',
          })
          const data = await apiFetch(`/tasks?${params}`)
          restored = (data.items || []).find((item: any) => item.type === 'register') || restored
        }
        if (!active) return
        activeTaskIdRef.current = String(restored?.task_id || restored?.id || '')
        setTask(restored)
        if (restored?.platform) {
          const restoredForm = { ...(restored.result?.registration_config || {}), platform: restored.platform }
          setForm(current => {
            const next = { ...current }
            Object.entries(restoredForm).forEach(([key, value]) => {
              if (!editedFieldsRef.current.has(key)) next[key] = value
            })
            return next
          })
        }
        setPolling(Boolean(restored && !isTerminalTaskStatus(restored.status)))
        if (restored) sessionStorage.setItem('register-task-id', restored.task_id || restored.id)
      } catch (error) {
        if (active) setRestoreError(`恢复注册任务失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (active) setRestoring(false)
      }
    }
    void restoreTask()
    return () => { active = false }
  }, [loadAttempt])

  const currentPlatform = platforms.find((p: any) => p.name === form.platform) || null
  const platformOptions = platforms.map((p: any) => [p.name, p.display_name])
  const supportedExecutors = currentPlatform?.supported_executors || []
  const registrationOptions = buildRegistrationOptions(currentPlatform)
  const executorOptions = buildExecutorOptions(
    form.identity_provider,
    supportedExecutors,
    hasReusableOAuthBrowser(form),
    currentPlatform?.supported_executor_options || [],
  )
  const mailboxProviderOptions = getProviderSelectOptions(configOptions.mailbox_providers || [])
  const currentMailboxProvider = (configOptions.mailbox_providers || []).find(provider => provider.value === form.mail_provider) || null
  const currentMailboxSetting = getProviderSetting(configOptions.mailbox_settings || [], form.mail_provider)
  const smsProviderOptions = getProviderSelectOptions(configOptions.sms_providers || [])
  const currentSmsProvider = (configOptions.sms_providers || []).find(provider => provider.value === form.sms_provider) || null
  const currentSmsSetting = getProviderSetting(configOptions.sms_settings || [], form.sms_provider)
  const allProviderFieldKeys = listProviderFieldKeys([
    ...(form.identity_provider === 'mailbox' && currentMailboxProvider ? [currentMailboxProvider] : []),
    ...(currentSmsProvider ? [currentSmsProvider] : []),
  ])

  useEffect(() => {
    const defaultProviderKey = getDefaultProviderKey(configOptions.mailbox_settings || [])
    if (form.identity_provider === 'mailbox' && !form.mail_provider && defaultProviderKey) {
      set('mail_provider', defaultProviderKey)
    }
  }, [form.identity_provider, form.mail_provider, configOptions.mailbox_settings])

  useEffect(() => {
    if (!currentMailboxProvider) return
    const values = getProviderMergedValues(currentMailboxSetting)
    const fields = currentMailboxProvider.fields || []
    if (fields.length === 0) return
    setForm(current => {
      const next = { ...current }
      let changed = false
      fields.forEach(field => {
        if (editedFieldsRef.current.has(field.key)) return
        const nextValue = values[field.key] ?? current[field.key] ?? ''
        if ((next[field.key] ?? '') !== nextValue) {
          next[field.key] = nextValue
          changed = true
        }
      })
      return changed ? next : current
    })
  }, [form.mail_provider, currentMailboxProvider, currentMailboxSetting])

  useEffect(() => {
    const defaultProviderKey = getDefaultProviderKey(configOptions.sms_settings || [])
    if (!form.sms_provider && defaultProviderKey) {
      set('sms_provider', defaultProviderKey)
    }
  }, [form.sms_provider, configOptions.sms_settings])

  useEffect(() => {
    if (!currentSmsProvider) return
    const values = getProviderMergedValues(currentSmsSetting)
    const fields = currentSmsProvider.fields || []
    if (fields.length === 0) return
    setForm(current => {
      const next = { ...current }
      let changed = false
      fields.forEach(field => {
        if (editedFieldsRef.current.has(field.key)) return
        const nextValue = values[field.key] ?? current[field.key] ?? ''
        if ((next[field.key] ?? '') !== nextValue) {
          next[field.key] = nextValue
          changed = true
        }
      })
      return changed ? next : current
    })
  }, [form.sms_provider, currentSmsProvider, currentSmsSetting])

  useEffect(() => {
    if (restoring || platforms.length === 0) return
    if (!platforms.some((p: any) => p.name === form.platform)) {
      const fallback = pickRegistrationPlatform(platforms, localStorage.getItem('register-platform') || '')
      if (fallback !== form.platform) {
        set('platform', fallback)
      }
    } else {
      localStorage.setItem('register-platform', form.platform)
    }
  }, [form.platform, platforms, restoring])

  useEffect(() => {
    if (registrationOptions.length === 0) return
    const currentRegistration = registrationOptions.find(option =>
      option.identityProvider === form.identity_provider &&
      option.oauthProvider === form.oauth_provider,
    )
    if (!currentRegistration) {
      const preferred = registrationOptions.find(option =>
        option.identityProvider === form.identity_provider,
      ) || registrationOptions[0]
      set('identity_provider', preferred.identityProvider)
      set('oauth_provider', preferred.oauthProvider)
    }
  }, [registrationOptions, form.identity_provider, form.oauth_provider, form.platform])

  useEffect(() => {
    const validExecutors = executorOptions.filter(option => !option.disabled)
    if (validExecutors.length === 0) return
    if (!validExecutors.some(option => option.value === form.executor_type)) {
      const nextExecutor = form.identity_provider === 'oauth_browser'
        ? pickOAuthExecutor(supportedExecutors, form.executor_type, hasReusableOAuthBrowser(form))
        : ((supportedExecutors.includes(form.executor_type) && form.executor_type) ? form.executor_type : supportedExecutors[0] || '')
      set('executor_type', validExecutors.find(option => option.value === nextExecutor)?.value || validExecutors[0].value)
    }
  }, [executorOptions, supportedExecutors, form.executor_type, form.identity_provider, form.chrome_user_data_dir, form.chrome_cdp_url])

  const submit = async () => {
    if (submitPendingRef.current) return
    if (optionsLoading || optionsError || restoreError) {
      setSubmitError(optionsError || restoreError || '注册配置正在加载，请稍候')
      return
    }
    if (form.platform === 'chatgpt' && (verificationHold?.active || verificationHoldLoading || verificationHoldError)) {
      setSubmitError(verificationHoldError || '手机验证已暂停，请到账号页手动恢复原账号')
      return
    }
    setSubmitError('')
    if (!Number.isInteger(form.count) || form.count < 1) {
      setSubmitError('批量数量必须是大于 0 的整数')
      return
    }
    const concurrency = form.concurrency ?? 1
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
      setSubmitError('并发数必须是 1 到 5 的整数')
      return
    }
    if (form.identity_provider === 'mailbox' && !form.mail_provider) {
      setSubmitError('请选择邮箱服务，或到设置页配置并启用默认邮箱 provider')
      return
    }
    const extra: Record<string, any> = {
      identity_provider: form.identity_provider,
      oauth_provider: form.oauth_provider,
      oauth_email_hint: form.oauth_email_hint,
      chrome_user_data_dir: form.chrome_user_data_dir || undefined,
      chrome_cdp_url: form.chrome_cdp_url || undefined,
    }
    if (form.mail_provider) {
      extra.mail_provider = form.mail_provider
    }
    if (form.sms_provider) {
      extra.sms_provider = form.sms_provider
    }
    allProviderFieldKeys.forEach(fieldKey => {
      if (form[fieldKey] !== undefined) {
        extra[fieldKey] = form[fieldKey]
      }
    })
    submitPendingRef.current = true
    setSubmitting(true)
    try {
      const res = await apiFetch('/tasks/register', {
        method: 'POST',
        body: JSON.stringify({
          platform: form.platform,
          email: form.email || null,
          password: form.password || null,
          count: form.count,
          concurrency,
          proxy: form.proxy || null,
          executor_type: form.executor_type,
          captcha_solver: 'auto',
          extra,
        }),
      })
      const taskId = res?.task_id || res?.id
      if (typeof taskId !== 'string' || !taskId) {
        throw new Error('创建注册任务失败：服务器未返回任务 ID')
      }
      activeTaskIdRef.current = taskId
      sessionStorage.setItem('register-task-id', taskId)
      setTask({ ...res, id: taskId, task_id: taskId })
      setPolling(!isTerminalTaskStatus(res.status))
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      submitPendingRef.current = false
      setSubmitting(false)
    }
  }

  const handleTaskDone = useCallback(async (status: string) => {
    if (!task?.task_id) return
    if (handledTerminalTaskIdsRef.current.has(String(task.task_id))) {
      setPolling(false)
      return
    }
    const completingTaskId = String(task.task_id)
    try {
      const latest = await apiFetch(`/tasks/${task.task_id}`)
      if (activeTaskIdRef.current !== completingTaskId) return
      applyTerminalTask(latest, status)
    } catch (error) {
      if (activeTaskIdRef.current !== completingTaskId) return
      if (error instanceof Error && error.message.includes('任务不存在')) {
        setTask(null)
        sessionStorage.removeItem('register-task-id')
        setSubmitError('原注册任务已不存在，可以重新开始注册')
      } else {
        applyTerminalTask({ ...task, status }, status)
      }
    } finally {
      if (activeTaskIdRef.current === completingTaskId) setPolling(false)
    }
  }, [applyTerminalTask, task?.task_id])

  useEffect(() => {
    if (!task?.task_id || isTerminalTaskStatus(task.status)) {
      if (task?.status) {
        setPolling(false)
      }
      return
    }
    let active = true
    const interval = window.setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const latest = await apiFetch(`/tasks/${task.task_id}`)
        if (!active || activeTaskIdRef.current !== String(task.task_id)) return
        setTask(latest)
        if (isTerminalTaskStatus(latest.status)) {
          window.clearInterval(interval)
          setPolling(false)
          applyTerminalTask(latest)
        }
      } catch (error) {
        if (active && error instanceof Error && error.message.includes('任务不存在')) {
          window.clearInterval(interval)
          setTask(null)
          setPolling(false)
          sessionStorage.removeItem('register-task-id')
          setSubmitError('原注册任务已不存在，可以重新开始注册')
        }
      }
    }, 5000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [applyTerminalTask, task?.task_id, task?.status])

  const renderProviderField = (field: ProviderField) => (
    <ProviderInput key={field.key} field={field} form={form} set={set} />
  )

  const registrationReady = registrationOptions.some(option =>
    option.identityProvider === form.identity_provider && option.oauthProvider === form.oauth_provider,
  ) && executorOptions.some(option => option.value === form.executor_type && !option.disabled)
  const displayedHold = verificationHold?.active ? verificationHold : verificationHoldLoading || verificationHoldError ? task?.result?.verification_hold : null
  const registrationHeld = form.platform === 'chatgpt' && Boolean(verificationHold?.active || verificationHoldLoading || verificationHoldError)
  const activeRegistration = task && (!isTerminalTaskStatus(task.status) || task.status === 'paused')
  const summaryConfig = activeRegistration ? task.result?.registration_config || {} : form
  const summaryPlatform = platforms.find(platform => platform.name === (activeRegistration ? task.platform : form.platform))
  const summaryRegistration = buildRegistrationOptions(summaryPlatform).find(option =>
    option.identityProvider === summaryConfig.identity_provider && option.oauthProvider === summaryConfig.oauth_provider,
  )?.label || (activeRegistration ? '未知' : '-')
  const summaryExecutor = summaryPlatform?.supported_executor_options?.find((option: any) =>
    option.value === summaryConfig.executor_type,
  )?.label || summaryConfig.executor_type || (activeRegistration ? '未知' : '-')
  const summaryVerification = summaryConfig.executor_type
    ? getCaptchaStrategyLabel(summaryConfig.executor_type, configOptions.captcha_policy, configOptions.captcha_providers)
    : (activeRegistration ? '未知' : '-')
  const activeTaskStats = task ? [
    { label: '状态', value: getTaskStatusText(task.status), icon: Orbit },
    { label: '进度', value: task.progress || '0/0', icon: Workflow },
    { label: '成功', value: String(task.success ?? 0), icon: CheckCircle },
    { label: '失败', value: String(task.error_count ?? task.errors?.length ?? 0), icon: XCircle },
  ] : []

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_340px]">
        <div className="space-y-4">
          {(optionsLoading || optionsError || restoreError) && (
            <div role={optionsError || restoreError ? 'alert' : 'status'} className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-200">
              {optionsError || restoreError || '正在加载注册配置...'}
              {(optionsError || restoreError) && (
                <Button variant="outline" className="mt-3 block" disabled={optionsLoading || restoring}
                  onClick={() => setLoadAttempt(attempt => attempt + 1)}>重新加载注册状态</Button>
              )}
            </div>
          )}
          <fieldset disabled={optionsLoading || restoring} className="min-w-0 space-y-4">
          <Card>
            <CardHeader><CardTitle>基本配置</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Select form={form} set={set} label="平台" k="platform" options={platformOptions} />
              <div className="grid gap-4 md:grid-cols-2">
                <Input form={form} set={set} label="批量数量" k="count" type="number" />
                <Input form={form} set={set} label="并发数" k="concurrency" type="number" max={5} />
                <div className="md:col-span-2">
                  <Input form={form} set={set} label="代理 (可选)" k="proxy" placeholder="http://user:pass@host:port" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Step 1 · 注册身份</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {registrationOptions.length === 0 && (
                <p role="status" className="text-sm text-amber-400">
                  {currentPlatform
                    ? '当前平台未提供自动注册身份，请选择 ChatGPT 或其他支持注册的平台；如应支持注册，请检查后端平台能力声明。'
                    : '未加载到平台注册选项，请刷新页面；仍无选项时请检查后端 /api/platforms。'}
                </p>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                {registrationOptions.map((option) => {
                  const active = form.identity_provider === option.identityProvider && form.oauth_provider === option.oauthProvider
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => {
                        set('identity_provider', option.identityProvider)
                        set('oauth_provider', option.oauthProvider)
                      }}
                      className={`rounded-lg border px-4 py-4 text-left transition-colors ${
                        active
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'border-[var(--border)] bg-[var(--bg-pane)]/45 hover:border-[var(--accent)]/60'
                      }`}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                        {option.identityProvider === 'mailbox' ? <Mail className="h-4 w-4 text-[var(--accent)]" /> : <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />}
                        {option.label}
                      </div>
                      <div className="mt-2 text-xs leading-5 text-[var(--text-muted)]">{option.description}</div>
                    </button>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Step 2 · 执行通道</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {executorOptions.length === 0 && (
                <p role="status" className="text-sm text-amber-400">
                  当前平台未提供注册执行通道，请选择支持自动注册的平台，或检查后端 supported_executors 配置。
                </p>
              )}
              <div className="grid gap-3 md:grid-cols-3">
                {executorOptions.map((option) => {
                  const active = form.executor_type === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={option.disabled}
                      onClick={() => !option.disabled && set('executor_type', option.value)}
                      className={`rounded-lg border px-4 py-4 text-left transition-colors ${
                        option.disabled
                          ? 'cursor-not-allowed border-[var(--border)] bg-[var(--bg-hover)] opacity-50'
                          : active
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                            : 'border-[var(--border)] bg-[var(--bg-pane)]/45 hover:border-[var(--accent)]/60'
                      }`}
                    >
                      <div className="text-sm font-medium text-[var(--text-primary)]">{option.label}</div>
                      <div className="mt-2 text-xs leading-5 text-[var(--text-muted)]">{option.description}</div>
                      {option.reason ? (
                        <div className="mt-2 text-xs text-amber-400">{option.reason}</div>
                      ) : null}
                    </button>
                  )
                })}
              </div>
              {form.identity_provider === 'oauth_browser' && (
                <>
                  <Input form={form} set={set} label="预期登录邮箱 (可选)" k="oauth_email_hint" placeholder="your-account@example.com" />
                  <Input form={form} set={set} label="Chrome Profile 路径" k="chrome_user_data_dir" placeholder="~/Library/Application Support/Google/Chrome" />
                  <Input form={form} set={set} label="Chrome CDP 地址" k="chrome_cdp_url" placeholder="http://localhost:9222" />
                  <p className="text-xs text-[var(--text-muted)]">
                    第三方账号走后台浏览器自动时，建议先配置 Chrome Profile 或 Chrome CDP，以便复用本机已登录的浏览器会话。
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {form.identity_provider === 'mailbox' && (
            <Card>
              <CardHeader><CardTitle>系统邮箱配置</CardTitle></CardHeader>
              <CardContent className="space-y-4">

                {mailboxProviderOptions.length > 0 ? (
                  <Select form={form} set={set} label="邮箱服务" k="mail_provider" options={mailboxProviderOptions} />
                ) : (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                    当前没有已启用的邮箱 provider，请先到设置页新增并启用一个默认邮箱 provider。
                  </div>
                )}
                {currentMailboxProvider?.description ? (
                  <p className="text-xs leading-5 text-[var(--text-muted)]">{currentMailboxProvider.description}</p>
                ) : null}
                {(currentMailboxProvider?.fields || []).map(renderProviderField)}
              </CardContent>
            </Card>
          )}

          {smsProviderOptions.length > 0 && (
            <Card>
              <CardHeader><CardTitle>短信接码配置</CardTitle></CardHeader>
              <CardContent className="space-y-4">

                <Select form={form} set={set} label="短信服务" k="sms_provider" options={smsProviderOptions} />
                {currentSmsProvider?.description ? (
                  <p className="text-xs leading-5 text-[var(--text-muted)]">{currentSmsProvider.description}</p>
                ) : null}
                {(currentSmsProvider?.fields || []).map(renderProviderField)}
              </CardContent>
            </Card>
          )}
          </fieldset>
        </div>

        <div className="space-y-5 xl:sticky xl:top-4 xl:self-start">
          <Card className="bg-[var(--bg-pane)]/62">
            <CardHeader>
              <CardTitle>{activeRegistration ? '当前任务摘要' : '当前编排摘要'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--chip-bg)] p-4">
                  <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]"><Mail className="h-3.5 w-3.5" /> Platform</div>
                  <div className="mt-2 text-base font-medium text-[var(--text-primary)]">{summaryPlatform?.display_name || (activeRegistration ? task.platform : form.platform)}</div>
                </div>
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--chip-bg)] p-4">
                  <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]"><ShieldCheck className="h-3.5 w-3.5" /> Identity</div>
                  <div className="mt-2 text-base font-medium text-[var(--text-primary)]">{summaryRegistration}</div>
                </div>
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--chip-bg)] p-4">
                  <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]"><Workflow className="h-3.5 w-3.5" /> Executor</div>
                  <div className="mt-2 text-base font-medium text-[var(--text-primary)]">{summaryExecutor}</div>
                </div>
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--chip-bg)] p-4">
                  <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]"><ScanText className="h-3.5 w-3.5" /> Verification</div>
                  <div className="mt-2 text-base font-medium text-[var(--text-primary)]">{summaryVerification}</div>
                </div>
              </div>
              {submitError && <p role="alert" className="break-all text-sm text-red-400">{submitError}</p>}
              {form.platform === 'chatgpt' && displayedHold?.active && (
                <div role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-3 text-sm text-amber-200">
                  <div className="font-semibold">手机验证暂停 · 暂停原因</div>
                  <div className="mt-1 break-words">{displayedHold.reason}</div>
                  <p className="mt-2 text-xs">{displayedHold.account_exists === false
                    ? '关联账号已删除；保存的手机验证限制仍有效，浏览器不会自动启动。'
                    : '账号及原会话已保留；不会自动重试。请手动恢复同一账号的手机验证。'}</p>
                  {displayedHold.retry_after_until && <p className="mt-1 text-xs">服务端重试提示：{displayedHold.retry_after_until}</p>}
                  {displayedHold.account_exists !== false && <Link className="mt-2 inline-block underline" to="/accounts/chatgpt">前往账号页恢复{displayedHold.account_id ? `（账号 ID ${displayedHold.account_id}）` : ''}</Link>}
                </div>
              )}
              {form.platform === 'chatgpt' && verificationHoldError && <p role="alert" className="text-sm text-amber-400">{verificationHoldError}</p>}
              <Button onClick={submit} disabled={restoring || optionsLoading || Boolean(optionsError || restoreError) || polling || submitting || registrationHeld || !form.platform || !registrationReady} className="w-full">
                {optionsLoading || restoring || submitting || polling ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{optionsLoading ? '正在加载配置...' : restoring ? '正在恢复任务...' : submitting ? '正在创建任务...' : '注册中...'}</> : <><Play className="mr-2 h-4 w-4" />开始注册</>}
              </Button>
            </CardContent>
          </Card>

          {task ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    执行状态
                    <Badge variant={TASK_STATUS_VARIANTS[task.status] || 'secondary'}>
                      {getTaskStatusText(task.status)}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-2">
                    {activeTaskStats.map(({ label, value, icon: Icon }) => (
                      <div key={label} className="rounded-lg border border-[var(--border-soft)] bg-[var(--chip-bg)] p-3">
                        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                          <Icon className="h-3.5 w-3.5" />
                          {label}
                        </div>
                        <div className="mt-2 text-sm font-medium text-[var(--text-primary)]">{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--chip-bg)] p-3 text-xs text-[var(--text-secondary)]">
                    <div>任务 ID</div>
                    <div className="mt-1 break-all font-mono text-[var(--text-primary)]">{task.id}</div>
                  </div>
                  {task.errors?.length > 0 && (
                    <div className="space-y-1">
                      {task.errors.map((e: string, i: number) => (
                        <div key={i} className="flex items-center gap-2 text-red-400">
                          <XCircle className="h-4 w-4" />
                          <span className="text-xs">{e}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {task.error && (
                    <div className="flex items-center gap-2 text-red-400">
                      <XCircle className="h-4 w-4" />
                      <span className="text-xs">{task.error}</span>
                    </div>
                  )}
                  {task.status === 'interrupted' && !task.error && (
                    <div className="flex items-center gap-2 text-amber-400">
                      <XCircle className="h-4 w-4" />
                      <span className="text-xs">任务在服务重启后被中断</span>
                    </div>
                  )}
                  {task.status === 'cancelled' && !task.error && (
                    <div className="flex items-center gap-2 text-amber-400">
                      <XCircle className="h-4 w-4" />
                      <span className="text-xs">任务已取消</span>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>实时日志</CardTitle></CardHeader>
                <CardContent>
                  <TaskLogPanel taskId={task.id} onDone={handleTaskDone} />
                </CardContent>
              </Card>
            </>
          ) : (
            <Card className="bg-[var(--bg-pane)]/55">
              <CardHeader><CardTitle>等待执行</CardTitle></CardHeader>
              <CardContent className="text-sm text-[var(--text-secondary)]">创建后显示状态与日志。</CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
