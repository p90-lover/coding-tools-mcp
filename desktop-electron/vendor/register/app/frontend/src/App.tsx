import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { getPlatforms } from '@/lib/app-data'
import { getAuthToken, setAuthToken, API, cn } from '@/lib/utils'
import Dashboard from '@/pages/Dashboard'
import Accounts from '@/pages/Accounts'
import Authenticator from '@/pages/Authenticator'
import Register from '@/pages/Register'
import Proxies from '@/pages/Proxies'
import SettingsPage from '@/pages/SettingsPage'
import TaskHistory from '@/pages/TaskHistory'
import UpdateBanner from '@/components/UpdateBanner'
import {
  ChevronRight,
  History,
  ShieldCheck,
  Play,
  LayoutDashboard,
  Moon,
  Settings as SettingsIcon,
  Sun,
  Monitor,
  Users,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react'

/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */

type NavItem = { path: string; label: string; icon: any; exact?: boolean }

const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '总览', icon: LayoutDashboard, exact: true },
  { path: '/register', label: '注册', icon: Play },
  { path: '/history', label: '任务', icon: History },
  { path: '/authenticator', label: '2FA 验证器', icon: ShieldCheck },
]

function Sidebar({
  theme,
  toggleTheme,
  collapsed,
  setCollapsed,
  onNavigate,
}: {
  theme: string
  toggleTheme: () => void
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  onNavigate?: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [platforms, setPlatforms] = useState<{ key: string; label: string }[]>([])
  const [accountsOpen, setAccountsOpen] = useState(location.pathname.startsWith('/accounts'))

  useEffect(() => {
    getPlatforms()
      .then((data) => setPlatforms((data || []).map((p: any) => ({ key: p.name, label: p.display_name }))))
      .catch(() => setPlatforms([]))
  }, [])

  useEffect(() => {
    if (location.pathname.startsWith('/accounts')) setAccountsOpen(true)
  }, [location.pathname])

  const isAccounts = location.pathname.startsWith('/accounts')
  const isSettings = location.pathname === '/settings'

  const navLinkClass = (active: boolean) =>
    cn(
      'group flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
      active
        ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      collapsed && 'justify-center px-0'
    )

  const iconClass = (active: boolean) =>
    cn('h-[18px] w-[18px] shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]')

  return (
    <aside
      className={cn(
        'flex h-dvh shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-surface)] transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-[220px]'
      )}
    >
      {/* Header */}
      <div className={cn('flex h-12 shrink-0 items-center border-b border-[var(--border)] px-3', collapsed && 'justify-center')}>
        {!collapsed && (
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-[11px] font-bold text-white">
              A
            </div>
            <span className="truncate text-sm font-semibold text-[var(--text-primary)]">Auto Register</span>
          </div>
        )}
        {collapsed && (
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-[11px] font-bold text-white">
            A
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map(({ path, label, icon: Icon, exact }) => {
          const active = exact ? location.pathname === path : location.pathname.startsWith(path)
          return (
            <NavLink onClick={onNavigate} key={path} to={path} end={exact} className={navLinkClass(active)} title={collapsed ? label : undefined}>
              <Icon className={iconClass(active)} />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          )
        })}

        {/* Accounts with sub-items */}
        <div>
          <button
            onClick={() => {
              if (collapsed) {
                navigate('/accounts')
              } else {
                setAccountsOpen(!accountsOpen)
              }
            }}
            className={cn(navLinkClass(isAccounts), 'w-full')}
            title={collapsed ? '账号' : undefined}
          >
            <Users className={iconClass(isAccounts)} />
            {!collapsed && (
              <>
                <span className="flex-1 text-left">账号</span>
                <ChevronRight className={cn('h-3 w-3 text-[var(--text-muted)] transition-transform duration-150', accountsOpen && 'rotate-90')} />
              </>
            )}
          </button>
          {!collapsed && accountsOpen && (
            <div className="ml-[21px] mt-0.5 space-y-px border-l border-[var(--border)] pl-3">
              {platforms.map((p) => (
                <NavLink onClick={onNavigate}
                  key={p.key}
                  to={`/accounts/${p.key}`}
                  className={({ isActive }) =>
                    cn(
                      'block rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                      isActive
                        ? 'text-[var(--text-primary)] font-medium bg-[var(--bg-hover)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    )
                  }
                >
                  {p.label}
                </NavLink>
              ))}
            </div>
          )}
        </div>

        {/* Divider */}
        {!collapsed && <div className="!my-2 mx-1 border-t border-[var(--border)]" />}

        {/* Settings with sub-items */}
        <div>
          <button
            onClick={() => {
              navigate('/settings')
              onNavigate?.()
            }}
            className={cn(navLinkClass(isSettings), 'w-full')}
            title={collapsed ? '设置' : undefined}
          >
            <SettingsIcon className={iconClass(isSettings)} />
            {!collapsed && <span>设置</span>}
          </button>
          {!collapsed && isSettings && (
            <div className="ml-[21px] mt-0.5 space-y-px border-l border-[var(--border)] pl-3">
              {[
                { label: '通用', hash: 'general' },
                { label: '注册策略', hash: 'register' },
                { label: '邮箱服务', hash: 'mailbox' },
                { label: '验证服务', hash: 'captcha' },
                { label: '接码服务', hash: 'sms' },
                { label: '代理资源', hash: 'proxies' },
                { label: 'ChatGPT', hash: 'chatgpt' },
                { label: '高级', hash: 'advanced' },
                { label: '关于', hash: 'about' },
              ].map((item) => {
                const params = new URLSearchParams(location.search)
                const currentTab = params.get('tab') || 'general'
                const active = currentTab === item.hash
                return (
                  <NavLink onClick={onNavigate}
                    key={item.hash}
                    to={`/settings?tab=${item.hash}`}
                    className={cn(
                      'relative block rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                      active
                        ? 'text-[var(--accent)] font-medium bg-[var(--accent-soft)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    )}
                  >
                    {active && <span className="absolute -left-[13.5px] top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-full bg-[var(--accent)]" />}
                    {item.label}
                  </NavLink>
                )
              })}
            </div>
          )}
        </div>
      </nav>

      {/* Footer */}
      <div className="shrink-0 border-t border-[var(--border)] px-2 py-1.5 flex items-center gap-1">
        <button
          onClick={toggleTheme}
          className={cn(
            'flex items-center justify-center rounded-md p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
          )}
          title={theme === 'dark' ? '切换到浅色' : theme === 'light' ? '切换到跟随系统' : '切换到深色'}
        >
          {theme === 'light' ? <Moon className="h-4 w-4" /> : theme === 'system' ? <Monitor className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </button>
        {!collapsed && (
          <span className="flex-1 text-[12px] text-[var(--text-muted)]">
            {theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '系统'}
          </span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center rounded-md p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
          title={collapsed ? '展开侧栏' : '收起侧栏'}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/*  Shell                                                              */
/* ------------------------------------------------------------------ */

function Shell({
  theme,
  setTheme,
  toggleTheme,
}: {
  theme: string
  setTheme: (t: string) => void
  toggleTheme: () => void
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(collapsed))
  }, [collapsed])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => { setMobile(query.matches); setMobileOpen(false) }
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--bg-base)]">
      {!mobile && <Sidebar theme={theme} toggleTheme={toggleTheme} collapsed={collapsed} setCollapsed={setCollapsed} />}
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {mobile && (
          <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
            <header className="sticky top-0 z-40 flex h-12 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-surface)] px-3">
              <Dialog.Trigger asChild>
                <button type="button" aria-label="打开导航" className="rounded-md p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
                  <PanelLeft className="h-5 w-5" />
                </button>
              </Dialog.Trigger>
              <span className="text-sm font-semibold text-[var(--text-primary)]">Auto Register</span>
            </header>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
              <Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-[220px] outline-none">
                <Dialog.Title className="sr-only">导航</Dialog.Title>
                <Sidebar theme={theme} toggleTheme={toggleTheme} collapsed={false}
                  setCollapsed={() => setMobileOpen(false)} onNavigate={() => setMobileOpen(false)} />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
        <div className="mx-auto max-w-6xl px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
          <UpdateBanner />
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/accounts/:platform" element={<Accounts />} />
            <Route path="/register" element={<Register />} />
            <Route path="/history" element={<TaskHistory />} />
            <Route path="/tasks" element={<TaskHistory />} />
            <Route path="/authenticator" element={<Authenticator />} />
            <Route path="/proxies" element={<Proxies />} />
            <Route path="/settings" element={<SettingsPage theme={theme} setTheme={setTheme} />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Login                                                              */
/* ------------------------------------------------------------------ */

function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const loginPendingRef = useRef(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (loginPendingRef.current || !pw) return
    loginPendingRef.current = true
    setLoading(true)
    setError('')
    try {
      const res = await fetch(API + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      })
      if (!res.ok) throw new Error('Login request failed')
      const data = await res.json()
      if (typeof data?.ok !== 'boolean') throw new Error('Invalid login response')
      if (data.ok) {
        const token = data.token === undefined ? '' : data.token
        if (typeof token !== 'string') throw new Error('Invalid login token')
        if (token) {
          if (!token.trim()) throw new Error('Empty login token')
          new Headers({ Authorization: `Bearer ${token}` })
        } else {
          const access = await fetch(API + '/auth/check')
          if (!access.ok || (await access.json())?.required !== false) throw new Error('Missing login token')
        }
        setAuthToken(token)
        onLogin(token)
      } else {
        setError(typeof data.error === 'string' && data.error ? data.error : '密码错误')
      }
    } catch {
      setError('请求失败')
    } finally {
      loginPendingRef.current = false
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--bg-base)]">
      <form onSubmit={submit} aria-busy={loading} className="w-80 space-y-4 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-white">A</div>
          <h1 className="text-base font-semibold text-[var(--text-primary)]">Any Auto Register</h1>
        </div>
        <p className="text-sm text-[var(--text-muted)]">请输入访问密码</p>
        <input
          type="password"
          aria-label="访问密码"
          autoComplete="current-password"
          readOnly={loading}
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="密码"
          autoFocus
          className="control-surface w-full"
        />
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={!pw}
          aria-disabled={loading}
          className="w-full rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50 aria-disabled:opacity-50"
        >
          {loading ? '验证中...' : '登 录'}
        </button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  App root                                                           */
/* ------------------------------------------------------------------ */

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark')
  const [authState, setAuthState] = useState<'loading' | 'open' | 'locked' | 'authed' | 'error'>('loading')
  const [authAttempt, setAuthAttempt] = useState(0)

  useEffect(() => {
    const applyTheme = () => {
      let effective = theme
      if (theme === 'system') {
        effective = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
      }
      document.documentElement.classList.toggle('light', effective === 'light')
    }
    applyTheme()
    localStorage.setItem('theme', theme)
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => { if (theme === 'system') applyTheme() }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  useEffect(() => {
    let active = true
    setAuthState('loading')
    fetch(API + '/auth/check')
      .then((response) => {
        if (!response.ok) throw new Error('Access check failed')
        return response.json()
      })
      .then((data) => {
        if (typeof data.required !== 'boolean') throw new Error('Invalid access check')
        if (!active) return
        if (!data.required) setAuthState('open')
        else if (getAuthToken()) setAuthState('authed')
        else setAuthState('locked')
      })
      .catch(() => { if (active) setAuthState('error') })
    return () => { active = false }
  }, [authAttempt])

  const toggleTheme = () =>
    setTheme((c) => (c === 'dark' ? 'light' : c === 'light' ? 'system' : 'dark'))

  if (authState === 'error') {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg-base)] px-6">
        <div className="space-y-4 text-center">
          <p role="alert" className="text-sm text-[var(--text-secondary)]">无法连接服务，请稍后重试。</p>
          <button onClick={() => setAuthAttempt((attempt) => attempt + 1)}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">
            重试
          </button>
        </div>
      </div>
    )
  }

  if (authState === 'loading') {
    return <div className="flex h-screen items-center justify-center bg-[var(--bg-base)] text-[var(--text-muted)] text-sm">加载中...</div>
  }
  if (authState === 'locked') {
    return <LoginScreen onLogin={() => setAuthState('authed')} />
  }

  return (
    <BrowserRouter>
      <Shell theme={theme} setTheme={setTheme} toggleTheme={toggleTheme} />
    </BrowserRouter>
  )
}
