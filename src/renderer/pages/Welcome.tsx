import brandLogo from '../assets/brand.png'
import { useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from '../components/ui'
import type { AppMode, NewPerson } from '../../db/defaults'
import type { Page } from '../App'

const MODES: { mode: AppMode; title: string; blurb: string }[] = [
  { mode: 'single', title: 'Just me', blurb: 'One person tracking their own money: accounts, spending, budgets and goals.' },
  { mode: 'couple', title: 'Me and my partner', blurb: 'Two people, each with their own private finances, side by side. Money you send each other is treated as movement between you, not income or spending.' },
  { mode: 'couple_household', title: 'Me, my partner and a shared household', blurb: 'Everything in "me and my partner", plus shared accounts (a joint account or card), a household budget and goals you work toward together. Each person\'s share stays visible.' }
]

const ACCOUNT_TYPES: { value: NewPerson['accounts'][number]['type']; label: string }[] = [
  { value: 'chequing', label: 'Chequing' }, { value: 'savings', label: 'Savings' }, { value: 'credit_card', label: 'Credit card' }, { value: 'investment', label: 'Investment' }, { value: 'other', label: 'Other' }
]
const startingAccounts = (): NewPerson['accounts'] => [{ name: 'Chequing', type: 'chequing' }, { name: 'Credit card', type: 'credit_card' }]

type Step = 'start' | 'mode' | 'people'

export function Welcome({ onDone }: { onDone: (goto?: Page) => void }) {
  const [step, setStep] = useState<Step>('start')
  const [sample, setSample] = useState(false)
  const [mode, setMode] = useState<AppMode>('single')
  const [people, setPeople] = useState<NewPerson[]>([{ name: '', accounts: startingAccounts() }, { name: '', accounts: startingAccounts() }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const count = mode === 'single' ? 1 : 2

  const choose = async (m: AppMode) => {
    setMode(m)
    setError(null)
    if (!sample) { setStep('people'); return }
    setBusy(true)
    try { await api('startSample', m); onDone('dashboard') } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  const create = async () => {
    setBusy(true)
    setError(null)
    try { await api('setupOwn', mode, people.slice(0, count)); onDone('import') } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  const setPerson = (i: number, patch: Partial<NewPerson>) => setPeople((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  return (
    <div className="welcome">
      <div>
        <Card>
          <div className="brand" style={{ padding: 0, marginBottom: 12 }}><img className="brand-logo" src={brandLogo} alt="" /><span>Welcome to FinanceTracker</span></div>

          {step === 'start' && (
            <>
              <p className="sub">A private finance tracker that runs entirely on this computer. There is no account, no cloud and no bank login. How would you like to begin?</p>
              <div className="choices">
                <button className="choice" onClick={() => { setSample(true); setStep('mode') }}>
                  <b>Explore with sample data</b>
                  <span>Fills the app with made-up people and about six months of transactions so you can look around. Kept separate from real data, and you can clear it at any time.</span>
                </button>
                <button className="choice" onClick={() => { setSample(false); setStep('mode') }}>
                  <b>Use my own data</b>
                  <span>Set up your people and accounts, then import statements from your bank as CSV or Excel files.</span>
                </button>
              </div>
            </>
          )}

          {step === 'mode' && (
            <>
              <h2 style={{ marginTop: 0 }}>{sample ? 'What should the sample show?' : 'Who is this for?'}</h2>
              <div className="choices">
                {MODES.map((m) => <button key={m.mode} className="choice" disabled={busy} onClick={() => void choose(m.mode)}><b>{m.title}</b><span>{m.blurb}</span></button>)}
              </div>
              {busy && <p className="muted" role="status">Creating sample data…</p>}
              <ErrorBox error={error} />
              <p><button className="btn" disabled={busy} onClick={() => setStep('start')}>Back</button></p>
            </>
          )}

          {step === 'people' && (
            <>
              <h2 style={{ marginTop: 0 }}>{count === 1 ? 'Your name and accounts' : 'Your names and accounts'}</h2>
              <p className="sub" style={{ marginTop: 0 }}>Balances come from the transactions you import, so you only need names here. Accounts can be added or changed later{mode === 'couple_household' ? ', and shared accounts are added later from Accounts → Add account' : ''}. A Cash wallet is created automatically.</p>
              {people.slice(0, count).map((p, i) => (
                <div key={i} className="card" style={{ marginBottom: 12, boxShadow: 'none' }}>
                  <label className="field">{count === 1 ? 'Your name' : i === 0 ? 'Your name' : "Your partner's name"}
                    <input value={p.name} onChange={(e) => setPerson(i, { name: e.target.value })} maxLength={40} style={{ maxWidth: 280 }} autoFocus={i === 0} />
                  </label>
                  <div className="muted" style={{ margin: '10px 0 4px' }}>Accounts</div>
                  {p.accounts.map((a, k) => (
                    <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <input aria-label="Account name" value={a.name} onChange={(e) => setPerson(i, { accounts: p.accounts.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })} style={{ width: 220 }} />
                      <select aria-label="Account type" value={a.type} onChange={(e) => setPerson(i, { accounts: p.accounts.map((x, j) => (j === k ? { ...x, type: e.target.value as typeof a.type } : x)) })}>
                        {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <button className="btn small" onClick={() => setPerson(i, { accounts: p.accounts.filter((_, j) => j !== k) })}>Remove</button>
                    </div>
                  ))}
                  <button className="btn small" onClick={() => setPerson(i, { accounts: [...p.accounts, { name: '', type: 'chequing' }] })}>Add an account</button>
                </div>
              ))}
              <ErrorBox error={error} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" disabled={busy} onClick={() => setStep('mode')}>Back</button>
                <button className="btn primary" disabled={busy || people.slice(0, count).some((p) => !p.name.trim())} onClick={() => void create()}>{busy ? 'Setting up…' : 'Continue to import'}</button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
