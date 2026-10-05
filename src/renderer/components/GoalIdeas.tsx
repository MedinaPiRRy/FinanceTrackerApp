import { useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, Icon } from './ui'
import { formatCents, monthLabel } from '../format'
import type { GoalIdeas as Ideas } from '../../db/goalIdeas'

/**
 * "Get goal ideas": realistic goals worked out from the person's own income, spending, savings, cards and loans.
 * Each idea says why it is suggested. The monthly amount can be changed before adding, and nothing is created until then.
 */
export function GoalIdeas({ profileId, onAdded, hint }: { profileId: number; onAdded: () => void; hint?: boolean }) {
  const [data, setData] = useState<Ideas | null>(null)
  const [open, setOpen] = useState(false)
  const [planned, setPlanned] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setBusy(true); setError(null)
    try {
      const d = await api('goalIdeas', profileId)
      setData(d)
      setPlanned(Object.fromEntries(d.ideas.map((i) => [i.key, i.plannedMonthlyCents === null ? '' : (i.plannedMonthlyCents / 100).toFixed(0)])))
      setOpen(true)
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }
  const add = async (key: string, original: number | null) => {
    const raw = planned[key] ?? ''
    const cents = raw === '' ? null : Math.round(Number(raw) * 100)
    if (cents !== null && (Number.isNaN(cents) || cents < 0)) return setError('Enter the monthly amount as a number, e.g. 200')
    setBusy(true); setError(null)
    try {
      await api('goalCreateFromIdeas', profileId, [{ key, plannedMonthlyCents: cents === original ? undefined : cents }])
      onAdded()
      await load()
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn" disabled={busy} onClick={() => void load()}><Icon name="idea" />Get goal ideas</button>
        {hint && !open && <span className="muted">Not sure what to aim for? The app can suggest realistic goals from your numbers.</span>}
      </div>
      <ErrorBox error={error} />
      {open && data && (
        <Card>
          <div className="card-head"><h2>Goal ideas</h2><button className="btn small" onClick={() => setOpen(false)}>Close</button></div>
          {data.months.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>There is not enough history yet to suggest realistic amounts. Import at least one complete month of transactions, then come back.</p>
          ) : (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Based on {data.months.length === 1 ? 'one complete month' : `${data.months.length} complete months`}: about {formatCents(data.avgMonthlyIncomeCents ?? 0)} coming in and {formatCents(data.avgMonthlySpendCents ?? 0)} going out each month.
                Monthly amounts never use more than 60% of what is left over. Change any amount before adding.
              </p>
              {data.ideas.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>Nothing to suggest: your cards and loans are covered by goals, and you already have a cushion.</p>}
              <div className="grid two">
                {data.ideas.map((i) => (
                  <div key={i.key} className="card" style={{ boxShadow: 'none', display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <b>{i.title}</b>
                      {i.tone !== 'unknown' && <span className={`badge ${i.tone === 'stretch' ? 'warn' : 'good'}`}>{i.tone === 'stretch' ? 'A stretch' : 'Comfortable'}</span>}
                    </div>
                    <div className="muted" style={{ lineHeight: 1.5 }}>{i.why}</div>
                    <div className="kv">
                      {i.targetCents !== undefined && <div><div className="k">Target</div><div className="v num">{formatCents(i.targetCents)}</div></div>}
                      <div><div className="k">Finish around</div><div className="v">{i.deadline && planned[i.key] === (i.plannedMonthlyCents === null ? '' : (i.plannedMonthlyCents / 100).toFixed(0)) ? monthLabel(i.deadline.slice(0, 7)) : '—'}</div></div>
                    </div>
                    <label className="field">Per month ($)
                      <input type="number" min="0" step="5" value={planned[i.key] ?? ''} placeholder="Set an amount" onChange={(e) => setPlanned({ ...planned, [i.key]: e.target.value })} style={{ width: 130 }} />
                    </label>
                    <div><button className="btn primary" disabled={busy} onClick={() => void add(i.key, i.plannedMonthlyCents)}>Add this goal</button></div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}
      {open && <div style={{ height: 16 }} />}
    </>
  )
}
