import { useState } from 'react'
import { Card, ErrorBox, Icon } from './ui'
import { formatCents, monthLabel } from '../format'

export interface Suggestion { key: string; name: string; averageCents: number; suggestedCents: number; highestCents: number; monthsWithSpending: number }

/**
 * "Suggest budgets from my last 3 months": shows what was actually spent per category, proposes a budget for each,
 * and lets the person untick or edit anything before a single budget is created. Nothing is saved until they confirm.
 */
export function SuggestBudgets({ load, create, onCreated, hint }: {
  load: () => Promise<{ months: string[]; suggestions: Suggestion[] }>
  create: (items: { key: string; name: string; monthlyCents: number }[]) => Promise<unknown>
  onCreated: () => void
  hint?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ months: string[]; suggestions: Suggestion[] } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [limits, setLimits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setBusy(true); setError(null)
    try {
      const d = await load()
      setData(d)
      setPicked(new Set(d.suggestions.map((s) => s.key)))
      setLimits(Object.fromEntries(d.suggestions.map((s) => [s.key, (s.suggestedCents / 100).toFixed(0)])))
      setOpen(true)
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }
  const cents = (key: string) => Math.round(Number(limits[key]) * 100)
  const valid = (key: string) => limits[key] !== undefined && limits[key] !== '' && !Number.isNaN(Number(limits[key])) && Number(limits[key]) >= 0
  const chosen = data?.suggestions.filter((s) => picked.has(s.key)) ?? []
  const totalCents = chosen.reduce((a, s) => a + (valid(s.key) ? cents(s.key) : 0), 0)

  const submit = async () => {
    if (chosen.some((s) => !valid(s.key))) return setError('Every selected budget needs to be a number, e.g. 250')
    setBusy(true); setError(null)
    try {
      await create(chosen.map((s) => ({ key: s.key, name: s.name, monthlyCents: cents(s.key) })))
      setOpen(false); setData(null)
      onCreated()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn" disabled={busy} onClick={() => void start()}><Icon name="wand" />Suggest budgets from my last 3 months</button>
        {hint && !open && <span className="muted">Not sure where to start? The app can propose budgets from what you actually spent.</span>}
      </div>
      <ErrorBox error={error} />
      {open && data && (
        <Card>
          <div className="card-head"><h2>Suggested budgets</h2><button className="btn small" onClick={() => setOpen(false)}>Close</button></div>
          {data.months.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>There is not enough history yet. This needs at least one complete past month with spending recorded. Import a statement first, then come back.</p>
          ) : data.suggestions.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>Everything you spent regularly is already in a budget.</p>
          ) : (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Based on {data.months.length === 1 ? 'one complete month' : `${data.months.length} complete months`} ({data.months.map(monthLabel).join(', ')}).
                Each suggestion is the monthly average rounded up to the next $5, so a normal month stays inside it. Untick or change anything, then create. Nothing is saved until you do.
              </p>
              <div className="table-wrap"><table>
                <thead><tr><th></th><th>Category</th><th className="r">Average / month</th><th className="r">Highest month</th><th className="r">Monthly budget ($)</th></tr></thead>
                <tbody>
                  {data.suggestions.map((s) => (
                    <tr key={s.key}>
                      <td><input type="checkbox" aria-label={`Include ${s.name}`} checked={picked.has(s.key)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(s.key); else n.delete(s.key); return n })} /></td>
                      <td>{s.name}{s.monthsWithSpending < data.months.length && <span className="muted"> · spent in {s.monthsWithSpending} of {data.months.length} months</span>}</td>
                      <td className="r num">{formatCents(s.averageCents)}</td>
                      <td className="r num">{formatCents(s.highestCents)}</td>
                      <td className="r"><input type="number" min="0" step="5" aria-label={`Budget for ${s.name}`} value={limits[s.key] ?? ''} disabled={!picked.has(s.key)} onChange={(e) => setLimits({ ...limits, [s.key]: e.target.value })} style={{ width: 100, textAlign: 'right' }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
                <button className="btn primary" disabled={busy || chosen.length === 0} onClick={() => void submit()}>Create {chosen.length} budget{chosen.length === 1 ? '' : 's'}</button>
                <span className="muted">Together {formatCents(totalCents)} a month.</span>
              </div>
            </>
          )}
        </Card>
      )}
      {open && <div style={{ height: 16 }} />}
    </>
  )
}
