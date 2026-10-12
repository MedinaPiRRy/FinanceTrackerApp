import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, Segmented } from '../components/ui'
import { Chart, type ChartColors } from '../components/Chart'
import { Pager, PAGE_SIZE } from '../components/Pager'
import { formatCents, monthLabel, shortMonth, KIND_LABEL } from '../format'
import { txnPreset } from '../txnLink'
import { useKept } from '../nav'
import type { CostsReport, CostLine, CostGroup, CostKindName } from '../../db/costsReport'
import type { TxnRow, Profile } from '../../db/queries'
import type { Purpose } from '../../core/costs'
import type { Page, TxnPreset } from '../App'

/** What is open in the list under the figures: taxes or interest (optionally one side, one category, one account), or the payments left out. */
interface View { kind: CostKindName | 'removed'; side?: 'paid' | 'received'; categoryId?: number | null; accountId?: number; label: string }
const NAME: Record<CostKindName, string> = { tax: 'Taxes', interest: 'Interest' }
const WHY: Record<CostLine['why'], string> = { marked: 'You marked it', category: 'Its category', wording: 'Its wording says interest' }

/** Taxes and interest, paid and received: totals by month and year, and every transaction behind them, which can be counted or left out one at a time. */
export function Costs({ profile, household, goto }: { profile: Profile; household?: boolean; goto: (p: Page, preset?: TxnPreset) => void }) {
  const [year, setYear] = useKept<number>('year', new Date().getFullYear())
  const [view, setView] = useKept<View | null>('view', null)
  const [adding, setAdding] = useKept('adding', false)
  const [by, setBy] = useKept<'category' | 'account'>('by', 'category')
  const [data, setData] = useState<CostsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const owner = household ? null : profile.id

  useEffect(() => { void api('costsReport', owner, year).then((r) => { setData(r); setError(null) }).catch((e: Error) => setError(e.message)) }, [owner, year, tick])
  const refresh = () => setTick((t) => t + 1)
  const run = async (fn: () => Promise<unknown>, note: string) => {
    try { await fn(); setError(null); setMsg(note); setTimeout(() => setMsg(null), 4000); refresh() } catch (e) { setError((e as Error).message) }
  }

  const option = useMemo(() => (c: ChartColors) => ({
    grid: { left: 56, right: 12, top: 32, bottom: 28 },
    legend: { top: 0, textStyle: { color: c.text2 } },
    tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text }, valueFormatter: (v: number) => formatCents(Math.round(v * 100)) },
    xAxis: { type: 'category', data: (data?.months ?? []).map((m) => shortMonth(m.month)), axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted } },
    yAxis: { type: 'value', axisLabel: { color: c.muted, formatter: (v: number) => `$${v.toLocaleString('en-CA')}` }, splitLine: { lineStyle: { color: c.grid } } },
    series: [
      { name: 'Taxes paid', type: 'bar', data: (data?.months ?? []).map((m) => m.taxCents / 100), itemStyle: { color: c.s1, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 14 },
      { name: 'Taxes received', type: 'bar', data: (data?.months ?? []).map((m) => m.taxReceivedCents / 100), itemStyle: { color: c.s3, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 14 },
      { name: 'Interest paid', type: 'bar', data: (data?.months ?? []).map((m) => m.interestCents / 100), itemStyle: { color: c.s2, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 14 },
      { name: 'Interest received', type: 'bar', data: (data?.months ?? []).map((m) => m.interestReceivedCents / 100), itemStyle: { color: c.muted, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 14 }
    ]
  }), [data])

  const years = data ? (data.years.includes(year) ? data.years : [year, ...data.years]) : [year]
  const open = (v: View) => { setView(v); setAdding(false); setTimeout(() => document.getElementById('cost-detail')?.scrollIntoView({ block: 'start' }), 50) }

  const figureCard = (kind: CostKindName) => {
    const f = data![kind]
    return (
      <Card className="stat" key={kind}>
        <div className="label">{NAME[kind]} in {year}</div>
        <div className="value num">{formatCents(f.paidCents - f.receivedCents)}</div>
        <div className="hint">net: <button className="txn-link" title={`See what was paid in ${NAME[kind].toLowerCase()}`} onClick={() => open({ kind, side: 'paid', label: `${NAME[kind]} paid` })}>{formatCents(f.paidCents)} paid</button> · <button className="txn-link" title="See what was received" onClick={() => open({ kind, side: 'received', label: `${NAME[kind]} received` })}>{formatCents(f.receivedCents)} received</button></div>
      </Card>
    )
  }

  const groupTable = (kind: CostKindName) => {
    const groups: CostGroup[] = data![kind][by === 'category' ? 'byCategory' : 'byAccount']
    if (groups.length === 0) return <p className="muted">Nothing counted.</p>
    return (
      <div className="table-wrap"><table>
        <thead><tr><th>{by === 'category' ? 'Category' : 'Account'}</th><th className="r">Paid</th><th className="r">Received</th><th></th></tr></thead>
        <tbody>{groups.map((g) => (
          <tr key={`${g.id}`}>
            <td><button className="txn-link" title="See the transactions" onClick={() => open(by === 'category' ? { kind, categoryId: g.id, label: `${NAME[kind]} · ${g.name}` } : { kind, accountId: g.id ?? undefined, label: `${NAME[kind]} · ${g.name}` })}>{g.name}</button></td>
            <td className="r num">{g.paidCents ? formatCents(g.paidCents) : '—'}</td><td className="r num">{g.receivedCents ? formatCents(g.receivedCents) : '—'}</td>
            <td className="r">{g.id !== null && <button className="btn small" title={by === 'category' ? 'Stop counting this whole category' : 'Take this whole account out of this page'} onClick={() => { if (confirm(by === 'category' ? `Stop counting “${g.name}” as ${NAME[kind].toLowerCase()}? You can count it again from Settings → Categories.` : `Take “${g.name}” out of the Taxes & interest page? You can put it back from “Left out” below.`)) void (by === 'category' ? run(() => api('costCategorySet', g.id!, 'none'), `${g.name} is no longer counted.`) : run(() => api('costAccountExclude', g.id!, true), `${g.name} is no longer counted.`)) }}>Stop counting</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    )
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Taxes &amp; interest</h1><p>What {household ? 'you have' : `${profile.name} has`} paid and received in taxes and in interest. Click any figure to see the payments behind it; any payment, category or account can be counted or left out.</p></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <button className="btn" onClick={() => { setAdding(!adding); setView(null) }}>{adding ? 'Close' : 'Add payments…'}</button>
          <label className="field">Year<select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Select year">{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
        </div>
      </div>
      <ErrorBox error={error} />
      {msg && <div className="notice" role="status">{msg}</div>}
      {!data ? <p className="muted">Loading…</p> : (
        <>
          <div className="grid stats">{figureCard('tax')}{figureCard('interest')}</div>
          <p className="muted" style={{ margin: '0 0 12px' }}>Something counted that should not be? Click a figure, then take out one payment (<b>Remove</b>), a whole category, or a whole account. Nothing is deleted from your transactions, and everything you take out is listed under <b>Left out</b> at the bottom, where you can count it again.</p>
          <Card>
            <div className="card-head"><h2>By month</h2></div>
            {data.tax.paidCents + data.tax.receivedCents + data.interest.paidCents + data.interest.receivedCents === 0 ? <p className="muted">Nothing counted as taxes or interest in {year}. Use “Add payments…”, or mark a category as Taxes or Interest in Settings → Categories.</p> : (
              <>
                <Chart build={option} height={230} label={`Bar chart of taxes and interest, paid and received, each month of ${year}`} />
                <div className="table-wrap"><table>
                  <thead><tr><th>Month</th><th className="r">Taxes paid</th><th className="r">Taxes received</th><th className="r">Interest paid</th><th className="r">Interest received</th></tr></thead>
                  <tbody>{data.months.filter((m) => m.taxCents || m.taxReceivedCents || m.interestCents || m.interestReceivedCents).map((m) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td className="r num">{formatCents(m.taxCents)}</td><td className="r num">{formatCents(m.taxReceivedCents)}</td><td className="r num">{formatCents(m.interestCents)}</td><td className="r num">{formatCents(m.interestReceivedCents)}</td></tr>)}</tbody>
                </table></div>
              </>
            )}
          </Card>

          <div className="grid two">
            {(['tax', 'interest'] as const).map((k) => (
              <Card key={k}>
                <div className="card-head"><h2>{NAME[k]}</h2><Segmented<'category' | 'account'> small label={`Group ${NAME[k].toLowerCase()} by`} value={by} onChange={setBy} options={[{ value: 'category', label: 'By category' }, { value: 'account', label: 'By account' }]} /></div>
                {groupTable(k)}
                <div><button className="btn small" onClick={() => open({ kind: k, label: `All ${NAME[k].toLowerCase()}` })}>See every payment</button></div>
              </Card>
            ))}
          </div>

          {(data.removed.payments > 0 || data.removed.accounts.length > 0) && (
            <Card>
              <div className="card-head"><h2>Left out</h2></div>
              <p className="sub" style={{ marginTop: 0 }}>You took these out of the page. They are not counted until you put them back.</p>
              {data.removed.payments > 0 && <p style={{ margin: '0 0 8px' }}><b>{data.removed.payments.toLocaleString()}</b> payment{data.removed.payments === 1 ? '' : 's'} <button className="btn small" onClick={() => open({ kind: 'removed', label: 'Payments left out' })}>See them</button></p>}
              {data.removed.accounts.map((a) => <p key={a.id} style={{ margin: '0 0 8px' }}>Account <b>{a.name}</b> <button className="btn small" onClick={() => void run(() => api('costAccountExclude', a.id, false), `${a.name} counts again.`)}>Count it again</button></p>)}
            </Card>
          )}

          {view && <Detail key={JSON.stringify(view) + year + tick} owner={owner} year={year} view={view} goto={goto} onClose={() => setView(null)} onChanged={refresh} setError={setError} setMsg={setMsg} />}
          {adding && <Adder profile={profile} household={!!household} year={year} onChanged={refresh} setError={setError} />}
        </>
      )}
    </>
  )
}

/** The payments behind a figure, 50 at a time. Each can be left out (or counted again); several can be chosen at once. */
function Detail({ owner, year, view, goto, onClose, onChanged, setError, setMsg }: { owner: number | null; year: number; view: View; goto: (p: Page, preset?: TxnPreset) => void; onClose: () => void; onChanged: () => void; setError: (e: string | null) => void; setMsg: (m: string | null) => void }) {
  const [page, setPage] = useState(0)
  const [res, setRes] = useState<{ total: number; paidCents: number; receivedCents: number; rows: CostLine[] } | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  useEffect(() => {
    void api('costLines', owner, year, { kind: view.kind, side: view.side, categoryId: view.categoryId, accountId: view.accountId, offset: page * PAGE_SIZE, limit: PAGE_SIZE }).then(setRes).catch((e: Error) => setError(e.message))
  }, [owner, year, view, page, setError])
  const mark = async (ids: number[], purpose: Purpose | null, note: string) => {
    try { await api('costMark', ids, purpose); setMsg(note); setTimeout(() => setMsg(null), 4000); setPicked(new Set()); onChanged() } catch (e) { setError((e as Error).message) }
  }
  const ids = [...picked]
  const removed = view.kind === 'removed'
  return (
    <div id="cost-detail"><Card>
      <div className="card-head"><h2>{view.label}</h2><button className="btn small" onClick={onClose}>Close</button></div>
      {!res ? <p className="muted">Loading…</p> : (
        <>
          <p className="sub" style={{ marginTop: 0 }}>{res.total.toLocaleString()} payment{res.total === 1 ? '' : 's'} in {year}{!removed && <> · {formatCents(res.paidCents)} paid · {formatCents(res.receivedCents)} received</>}</p>
          {res.total === 0 ? <p className="muted">Nothing here.</p> : (
            <>
              {picked.size > 0 && (
                <div className="bulk-bar" role="region" aria-label="Selected payments"><div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b>{picked.size} selected</b>
                  {removed ? <button className="btn small primary" onClick={() => void mark(ids, null, 'Counted again.')}>Count again</button> : (
                    <>
                      <button className="btn small danger" onClick={() => { if (confirm(`Stop counting ${picked.size} payment${picked.size === 1 ? '' : 's'} on this page? They stay in your transactions.`)) void mark(ids, 'none', 'No longer counted.') }}>Stop counting</button>
                      <button className="btn small" onClick={() => void mark(ids, view.kind === 'tax' ? 'interest' : 'tax', `Now counted as ${view.kind === 'tax' ? 'interest' : 'taxes'}.`)}>Count as {view.kind === 'tax' ? 'interest' : 'taxes'} instead</button>
                    </>
                  )}
                  <button className="btn small" onClick={() => setPicked(new Set())}>Clear</button>
                </div></div>
              )}
              <div className="table-wrap"><table>
                <caption className="sr-only">{view.label}</caption>
                <thead><tr><th style={{ width: 28 }}><input type="checkbox" aria-label="Select every payment on this page" checked={res.rows.length > 0 && res.rows.every((r) => picked.has(r.id))} onChange={(e) => setPicked(e.target.checked ? new Set(res.rows.map((r) => r.id)) : new Set())} /></th><th>Date</th><th>Payment</th><th>Account</th><th>Why it counts</th><th className="r">Amount</th><th></th></tr></thead>
                <tbody>{res.rows.map((l) => (
                  <tr key={l.id}>
                    <td><input type="checkbox" aria-label={`Select ${l.description}`} checked={picked.has(l.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n })} /></td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{l.date}</td>
                    <td><button className="txn-link" title="Show this transaction in its account" onClick={() => goto('transactions', txnPreset({ id: l.id, accountId: l.accountId, date: l.date }))}>{l.description}</button>{l.category && <div className="muted" style={{ fontSize: 12 }}>{l.category}</div>}</td>
                    <td>{l.account}</td>
                    <td>{removed ? <span className="muted">Left out by you</span> : <span className={`badge ${l.why === 'marked' ? 'accent' : ''}`}>{WHY[l.why]}</span>}{!removed && <div className="muted" style={{ fontSize: 12 }}>{l.side === 'received' ? 'received' : l.cents < 0 ? 'paid back' : 'paid'}</div>}</td>
                    <td className={`r num ${l.side === 'received' || l.cents < 0 ? 'pos' : ''}`}>{formatCents(l.cents)}</td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>{removed ? <button className="btn small" onClick={() => void mark([l.id], null, 'Counted again.')}>Count again</button> : <button className="btn small" aria-label={`Stop counting ${l.description}`} onClick={() => void mark([l.id], 'none', 'No longer counted.')}>Remove</button>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              <Pager page={page} total={res.total} pageSize={PAGE_SIZE} onPage={setPage} noun="Payments" />
            </>
          )}
          {!removed && view.categoryId !== undefined && view.categoryId !== null && <div style={{ marginTop: 8 }}><button className="btn small" onClick={() => { if (confirm('Stop counting this whole category? You can count it again from Settings → Categories.')) void api('costCategorySet', view.categoryId!, 'none').then(() => { onChanged(); onClose() }).catch((e: Error) => setError(e.message)) }}>Stop counting this whole category</button></div>}
          {!removed && view.accountId !== undefined && <div style={{ marginTop: 8 }}><button className="btn small" onClick={() => { if (confirm('Take this whole account out of the Taxes & interest page? You can put it back from “Left out”.')) void api('costAccountExclude', view.accountId!, true).then(() => { onChanged(); onClose() }).catch((e: Error) => setError(e.message)) }}>Stop counting this whole account</button></div>}
        </>
      )}
    </Card></div>
  )
}

/** Finds any payment (by what it says) and counts it as taxes or as interest, like choosing a category for it. */
function Adder({ profile, household, year, onChanged, setError }: { profile: Profile; household: boolean; year: number; onChanged: () => void; setError: (e: string | null) => void }) {
  const [text, setText] = useState('')
  const [page, setPage] = useState(0)
  const [res, setRes] = useState<{ rows: TxnRow[]; total: number } | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const load = useCallback(() => {
    const filter = { text: text || undefined, from: `${year}-01-01`, to: `${year}-12-31`, limit: PAGE_SIZE, offset: page * PAGE_SIZE, kind: 'income,expense,refund' }
    void (household ? api('householdTxns', filter) : api('txns', profile.id, filter)).then(setRes).catch((e: Error) => setError(e.message))
  }, [text, page, year, household, profile.id, setError])
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])
  const mark = async (purpose: Purpose | null) => { try { await api('costMark', [...picked], purpose); setPicked(new Set()); load(); onChanged() } catch (e) { setError((e as Error).message) } }
  return (
    <Card>
      <div className="card-head"><h2>Add payments to taxes or interest</h2></div>
      <p className="sub" style={{ marginTop: 0 }}>Search for the payments (for example “CRA”, “GST credit” or “mortgage interest”), tick them, and choose what they count as. Money you paid counts as paid and money you received counts as received.</p>
      <div className="filters"><label className="field">Search<input type="search" value={text} placeholder="What the payment says" onChange={(e) => { setText(e.target.value); setPage(0) }} style={{ width: 280 }} /></label></div>
      {picked.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Selected payments"><div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>{picked.size} selected</b>
          <button className="btn small primary" onClick={() => void mark('tax')}>Count as taxes</button>
          <button className="btn small primary" onClick={() => void mark('interest')}>Count as interest</button>
          <button className="btn small" onClick={() => void mark(null)}>Back to automatic</button>
          <button className="btn small" onClick={() => setPicked(new Set())}>Clear</button>
        </div></div>
      )}
      {!res ? <p className="muted">Loading…</p> : res.rows.length === 0 ? <p className="muted">No payments match.</p> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th style={{ width: 28 }}></th><th>Date</th><th>Payment</th><th>Account</th><th>Counts now as</th><th className="r">Amount</th></tr></thead>
            <tbody>{res.rows.map((r) => {
              const ok = r.kind === 'income' || r.kind === 'expense' || r.kind === 'refund'
              return (
                <tr key={r.id}>
                  <td><input type="checkbox" aria-label={`Select ${r.description}`} disabled={!ok} checked={picked.has(r.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n })} /></td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{r.date}</td>
                  <td>{r.description}<div className="muted" style={{ fontSize: 12 }}>{r.category ?? KIND_LABEL[r.kind] ?? r.kind}</div></td>
                  <td>{r.account}</td>
                  <td>{r.costPurpose === 'tax' ? <span className="badge accent">Taxes</span> : r.costPurpose === 'interest' ? <span className="badge accent">Interest</span> : r.costPurpose === 'none' ? <span className="badge">Left out</span> : <span className="muted">automatic</span>}</td>
                  <td className={`r num ${r.amountCents > 0 ? 'pos' : ''}`}>{formatCents(r.amountCents, { sign: true })}</td>
                </tr>
              )
            })}</tbody>
          </table></div>
          <Pager page={page} total={res.total} pageSize={PAGE_SIZE} onPage={setPage} noun="Payments" />
        </>
      )}
    </Card>
  )
}
