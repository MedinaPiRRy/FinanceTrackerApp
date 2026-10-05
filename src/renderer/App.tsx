import brandLogo from './assets/brand.png'
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { ThemeProvider, useTheme } from './theme'
import { Segmented } from './components/ui'
import { profileLabel } from './format'
import { Dashboard } from './pages/Dashboard'
import { Transactions } from './pages/Transactions'
import { Review } from './pages/Review'
import { Import } from './pages/Import'
import { Budget } from './pages/Budget'
import { Goals } from './pages/Goals'
import { MonthlyReview } from './pages/MonthlyReview'
import { Accounts } from './pages/Accounts'
import { Cash } from './pages/Cash'
import { Recurring } from './pages/Recurring'
import { Settings } from './pages/Misc'
import { Welcome } from './pages/Welcome'
import { Insights } from './pages/Insights'
import { Forecast } from './pages/Forecast'
import { InsightBanner } from './components/InsightBanner'
import { HouseholdDashboard } from './pages/HouseholdDashboard'
import { HouseholdBudget } from './pages/HouseholdBudget'
import { HouseholdGoals } from './pages/HouseholdGoals'
import { ErrorBoundary } from './components/ErrorBoundary'
import type { AccountInfo, CategoryInfo, Profile } from '../db/queries'
import type { Owner } from '../db/household'

export type Page = 'dashboard' | 'monthly' | 'transactions' | 'import' | 'review' | 'accounts' | 'cash' | 'recurring' | 'insights' | 'forecast' | 'budget' | 'goals' | 'settings'
export interface TxnPreset { insightId?: string; text?: string; accountId?: number; categoryId?: number; from?: string; to?: string; reviewOnly?: boolean }

const NAV: { page: Page; label: string; icon: string }[][] = [
  [
    { page: 'dashboard', label: 'Dashboard', icon: '▦' },
    { page: 'insights', label: 'Insights', icon: '✦' },
    { page: 'monthly', label: 'Monthly review', icon: '◷' },
    { page: 'transactions', label: 'Transactions', icon: '☰' },
    { page: 'import', label: 'Import', icon: '⇪' },
    { page: 'review', label: 'Review', icon: '✓' },
    { page: 'accounts', label: 'Accounts', icon: '▣' },
    { page: 'cash', label: 'Cash & tips', icon: '$' },
    { page: 'recurring', label: 'Recurring', icon: '↻' }
  ],
  [
    { page: 'budget', label: 'Budget', icon: '◔' },
    { page: 'goals', label: 'Goals', icon: '◎' },
    { page: 'forecast', label: 'Forecast', icon: '↗' },
    { page: 'settings', label: 'Settings', icon: '⚙' }
  ]
]

const HOUSEHOLD_NAV: { page: Page; label: string; icon: string }[][] = [
  [
    { page: 'dashboard', label: 'Overview', icon: '▦' },
    { page: 'transactions', label: 'Transactions', icon: '☰' },
    { page: 'import', label: 'Import (shared)', icon: '⇪' },
    { page: 'review', label: 'Review (shared)', icon: '✓' },
    { page: 'accounts', label: 'Accounts', icon: '▣' }
  ],
  [
    { page: 'budget', label: 'Budget', icon: '◔' },
    { page: 'goals', label: 'Goals', icon: '◎' },
    { page: 'forecast', label: 'Forecast', icon: '↗' },
    { page: 'settings', label: 'Settings', icon: '⚙' }
  ]
]

function Shell() {
  const { resolved, setSetting } = useTheme()
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api<'status'>>> | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profileId, setProfileId] = useState<number | null>(null)
  const [householdMode, setHouseholdMode] = useState(false)
  const [household, setHousehold] = useState<Profile | null>(null)
  const [owners, setOwners] = useState<Owner[]>([])
  const [partner, setPartner] = useState<{ id: number; name: string } | null>(null)
  const [sharedAccounts, setSharedAccounts] = useState<AccountInfo[]>([])
  const [allAccounts, setAllAccounts] = useState<AccountInfo[]>([])
  const [page, setPage] = useState<Page>('dashboard')
  const [preset, setPreset] = useState<TxnPreset>({})
  const [accounts, setAccounts] = useState<AccountInfo[]>([])
  const [categories, setCategories] = useState<CategoryInfo[]>([])
  const [reviewCount, setReviewCount] = useState(0)
  const [recurringCount, setRecurringCount] = useState(0) // stopped payments + newly found ones
  const [rev, setRev] = useState(0) // bump to refresh shared data after a change
  const [fatal, setFatal] = useState<string | null>(null)

  const init = useCallback(async () => {
    try {
      const s = await api('status')
      setStatus(s)
      if (!s.hasData) return
      const ps = await api('profiles')
      setProfiles(ps)
      const saved = Number(localStorage.getItem('profileId'))
      setProfileId(ps.find((p) => p.id === saved)?.id ?? ps[0]?.id ?? null)
      setHousehold(s.mode === 'couple_household' ? await api('household') : null)
      try { setHouseholdMode(s.mode === 'couple_household' && localStorage.getItem('householdMode') === '1') } catch { /* default */ }
    } catch (e) {
      setFatal((e as Error).message)
    }
  }, [])
  useEffect(() => { void init() }, [init])

  // In household mode the "current profile" is the household pseudo-profile, which owns the shared accounts.
  const activeId = householdMode && household ? household.id : profileId
  useEffect(() => {
    if (activeId === null) return
    void api('accounts', activeId).then(setAccounts)
    void api('categories', activeId).then(setCategories)
    void api('reviewQueue', activeId).then((q) => setReviewCount(q.length))
    if (!householdMode) void Promise.all([api('recurringStopped', activeId), api('recurringSuggest', activeId)]).then(([a, b]) => setRecurringCount(a.length + b.length)).catch(() => setRecurringCount(0))
    void api('owners').then(setOwners)
    if (household) void api('accounts', household.id).then(setSharedAccounts)
    void api('householdAccounts').then((r) => setAllAccounts(r))
    if (profileId !== null && !householdMode) void api('partner', profileId).then(setPartner)
    else setPartner(null)
  }, [activeId, profileId, household, householdMode, rev])

  const goto = useCallback((p: Page, pre: TxnPreset = {}) => { setPage(p); setPreset(pre) }, [])
  const changed = useCallback(() => setRev((r) => r + 1), [])
  const person = profiles.find((p) => p.id === profileId)
  const profile = householdMode && household ? household : person

  if (fatal) return <div className="center"><div className="error">Could not start: {fatal}</div></div>
  if (!status) return <p className="muted" style={{ padding: 24 }}>Starting…</p>
  if (!status.hasData) return <Welcome onDone={(p) => { try { localStorage.setItem('householdMode', '0'); localStorage.removeItem('profileId') } catch { /* not persisted */ }
    setHouseholdMode(false); setPage(p ?? 'dashboard'); setStatus(null); setProfiles([]); setProfileId(null); void init() }} />
  if (!profile) return <p className="muted" style={{ padding: 24 }}>Loading…</p>

  const switchProfile = (id: number) => {
    setHouseholdMode(false)
    try { localStorage.setItem('householdMode', '0') } catch { /* not persisted */ }
    setPage((pg) => pg)
    setProfileId(id)
    try { localStorage.setItem('profileId', String(id)) } catch { /* not persisted */ }
    setPreset({})
  }
  const openHousehold = () => {
    setHouseholdMode(true)
    try { localStorage.setItem('householdMode', '1') } catch { /* not persisted */ }
    setPreset({})
    if (page === 'monthly' || page === 'cash' || page === 'recurring') setPage('dashboard')
  }
  const leftSample = () => { try { localStorage.setItem('householdMode', '0'); localStorage.removeItem('profileId') } catch { /* not persisted */ }
    setStatus(null); setProfiles([]); setProfileId(null); setHouseholdMode(false); setPage('dashboard'); void init() }
  const navGroups = householdMode ? HOUSEHOLD_NAV : NAV
  const isHousehold = householdMode && !!household

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><img className="brand-logo" src={brandLogo} alt="" /><span className="t">FinanceTracker</span></div>
        {navGroups.map((group, gi) => (
          <div key={gi}>
            {gi === 1 && <div className="nav-section">More</div>}
            {group.map((n) => (
              <button key={n.page} className="nav-item" aria-current={page === n.page ? 'page' : undefined} onClick={() => goto(n.page)} title={n.label}>
                <span><span aria-hidden="true" style={{ display: 'inline-block', width: 22 }}>{n.icon}</span><span className="t">{n.label}</span></span>
                {n.page === 'recurring' && recurringCount > 0 && <span className="badge accent" aria-label={`${recurringCount} to look at`}>{recurringCount}</span>}
                {n.page === 'review' && reviewCount > 0 && <span className="badge warn" aria-label={`${reviewCount} to review`}>{reviewCount}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">Local and offline.<br />Your data stays on this computer.</div>
      </nav>
      <div className="main">
        {status.sample && (
          <div className="top-banner" role="status">
            <span>You are exploring <b>sample data</b>. Everything here is made up and stored separately from real data.</span>
            <button className="btn small" onClick={() => { void api('endSample').then(() => leftSample()) }}>Start with my own data</button>
          </div>
        )}
        {!isHousehold && <InsightBanner key={profile.id} profileId={profile.id} goto={goto} />}
        <header className="topbar">
          {profiles.length > 1 ? <Segmented
            label="Whose finances"
            value={isHousehold ? 'household' : String(profile.id)}
            onChange={(v) => (v === 'household' ? openHousehold() : switchProfile(Number(v)))}
            options={[...profiles.map((p) => ({ value: String(p.id), label: profileLabel(p) })), ...(status.mode === 'couple_household' ? [{ value: 'household', label: 'Household' }] : [])]}
          /> : <span className="muted" style={{ fontWeight: 600 }}>{profile.name}</span>}
          <button className="btn" onClick={() => setSetting(resolved === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}>{resolved === 'dark' ? '☀ Light' : '☾ Dark'}</button>
        </header>
        <main className="content" key={`${profile.id}-${page}`}>
          <ErrorBoundary resetKey={`${profile.id}-${page}`}>
          {isHousehold ? (
            <>
              {page === 'dashboard' && <HouseholdDashboard goto={goto} />}
              {page === 'transactions' && <Transactions profile={profile} accounts={allAccounts} categories={categories} preset={preset} goto={goto} household={{ owners }} />}
              {page === 'import' && <Import profile={profile} accounts={accounts} categories={categories} onChanged={changed} goto={goto} partner={null} />}
              {page === 'review' && <Review profile={profile} accounts={accounts} categories={categories} onChanged={changed} partner={null} />}
              {page === 'accounts' && <Accounts profile={profile} household goto={goto} onChanged={changed} />}
              {page === 'budget' && <HouseholdBudget onChanged={changed} />}
              {page === 'forecast' && <Forecast profile={profile} goto={goto} />}
              {page === 'goals' && <HouseholdGoals profile={profile} accounts={allAccounts} categories={categories} goto={goto} />}
              {page === 'settings' && <Settings profile={{ ...profile, kind: 'household' }} partner={null} sample={status.sample} onLeaveSample={leftSample} />}
            </>
          ) : (
            <>
              {page === 'dashboard' && <Dashboard profile={profile} categories={categories} goto={goto} />}
              {page === 'transactions' && <Transactions profile={profile} accounts={accounts} categories={categories} preset={preset} goto={goto} />}
              {page === 'import' && <Import profile={profile} accounts={accounts} categories={categories} onChanged={changed} goto={goto} partner={partner} />}
              {page === 'review' && <Review profile={profile} accounts={[...accounts, ...sharedAccounts]} categories={categories} onChanged={changed} partner={partner} />}
              {page === 'accounts' && <Accounts profile={profile} goto={goto} onChanged={changed} />}
              {page === 'cash' && <Cash profile={profile} accounts={accounts} categories={categories} onChanged={changed} />}
              {page === 'insights' && <Insights profile={profile} categories={categories} goto={goto} openId={preset.insightId} />}
              {page === 'recurring' && <Recurring profile={profile} accounts={accounts} onChanged={changed} />}
              {page === 'monthly' && <MonthlyReview profile={profile} goto={goto} />}
              {page === 'budget' && <Budget profile={profile} categories={categories} goto={goto} onChanged={changed} />}
              {page === 'forecast' && <Forecast profile={profile} goto={goto} />}
              {page === 'goals' && <Goals profile={profile} accounts={accounts} categories={categories} goto={goto} />}
              {page === 'settings' && <Settings profile={{ ...profile, kind: 'person' }} partner={partner} sample={status.sample} onLeaveSample={leftSample} />}
            </>
          )}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  )
}
