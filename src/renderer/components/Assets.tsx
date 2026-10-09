import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'
import { Chart, type ChartColors } from './Chart'
import { formatCents, shortMonth, today } from '../format'
import type { AssetKind, AssetRow, NetWorth } from '../../db/assets'
import type { Owner } from '../../db/household'

const KIND_LABEL: Record<AssetKind, string> = { property: 'House or property', vehicle: 'Car or vehicle', investment: 'Stocks or investments', other: 'Something else' }
const toCents = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100))

function History({ asset }: { asset: AssetRow }) {
  const [pts, setPts] = useState<{ asOf: string; valueCents: number }[] | null>(null)
  useEffect(() => { void api('assetHistory', asset.profileId, asset.id).then(setPts) }, [asset.id, asset.profileId, asset.valueCents])
  const option = useMemo(() => (c: ChartColors) => ({
    grid: { left: 70, right: 16, top: 12, bottom: 28 },
    tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text }, valueFormatter: (v: number) => formatCents(Math.round(v * 100)) },
    xAxis: { type: 'category', data: (pts ?? []).map((x) => x.asOf), axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted, formatter: (v: string) => shortMonth(v.slice(0, 7)) } },
    yAxis: { type: 'value', axisLabel: { color: c.muted, formatter: (v: number) => `$${v.toLocaleString('en-CA')}` }, splitLine: { lineStyle: { color: c.grid } } },
    series: [{ type: 'line', data: (pts ?? []).map((x) => x.valueCents / 100), lineStyle: { width: 2, color: c.s1 }, itemStyle: { color: c.s1, borderColor: c.surface, borderWidth: 2 }, symbolSize: 8, areaStyle: { color: c.s1, opacity: 0.08 } }]
  }), [pts])
  if (!pts) return <span className="muted">Loading…</span>
  if (pts.length < 2) return <span className="muted">Only one value is recorded so far. Use “Update value” now and then and the history appears here.</span>
  return <Chart build={option} height={170} label={`Line chart of the value of ${asset.name} over time`} />
}

function AssetItem({ a, showOwner, reload }: { a: AssetRow; showOwner: boolean; reload: () => void }) {
  const [mode, setMode] = useState<'none' | 'value' | 'history' | 'rename'>('none')
  const [value, setValue] = useState((a.valueCents / 100).toFixed(2))
  const [asOf, setAsOf] = useState(today())
  const [name, setName] = useState(a.name)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setError(null); setMode('none'); reload() } catch (e) { setError((e as Error).message) } }
  return (
    <>
      <tr>
        <td>{mode === 'rename'
          ? <span style={{ display: 'flex', gap: 6 }}><input value={name} maxLength={60} autoFocus aria-label={`New name for ${a.name}`} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(() => api('assetUpdate', a.profileId, a.id, { name })) }} /><button className="btn small primary" onClick={() => void run(() => api('assetUpdate', a.profileId, a.id, { name }))}>Save</button></span>
          : <>{a.name}<div className="muted" style={{ fontSize: 12 }}>{KIND_LABEL[a.kind]}{showOwner ? ` · ${a.owner}` : ''}</div></>}</td>
        <td className="r num">{mode === 'value'
          ? <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}><input type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} className="inline-input" aria-label={`New value of ${a.name}`} /><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label="Value date" /></span>
          : <>{formatCents(a.valueCents)}<div className="muted" style={{ fontSize: 12 }}>as of {a.asOf}{a.changeCents !== null && a.changeCents !== 0 && <span className={a.changeCents > 0 ? 'pos' : 'neg'}> · {formatCents(a.changeCents, { sign: true })}</span>}</div></>}
          {error && <div className="neg" style={{ fontSize: 12 }}>{error}</div>}</td>
        <td className="r" style={{ whiteSpace: 'nowrap' }}>
          {mode === 'value' ? <><button className="btn small primary" onClick={() => { const c = toCents(value); if (c === null || c < 0) return setError('Enter the value as a number'); void run(() => api('assetUpdateValue', a.profileId, a.id, c, asOf)) }}>Save</button> <button className="btn small" onClick={() => setMode('none')}>Cancel</button></>
            : <>
              <button className="btn small" onClick={() => { setMode('value'); setValue((a.valueCents / 100).toFixed(2)) }}>Update value</button>{' '}
              <button className="btn small" aria-expanded={mode === 'history'} onClick={() => setMode(mode === 'history' ? 'none' : 'history')}>History</button>{' '}
              <button className="btn small" onClick={() => { setMode('rename'); setName(a.name) }}>Rename</button>{' '}
              <button className="btn small danger" aria-label={`Remove ${a.name}`} onClick={() => { if (confirm(`Remove “${a.name}” and its value history? Your accounts and transactions are not affected.`)) void run(() => api('assetDelete', a.profileId, a.id)) }}>Remove</button>
            </>}
        </td>
      </tr>
      {mode === 'history' && <tr><td colSpan={3}><History asset={a} /></td></tr>}
    </>
  )
}

/** Net worth: what the accounts hold plus the house, car and investments added here, minus cards, loans and debts. */
export function Assets({ profileId, version, onChanged }: { profileId: number | null; version: number; onChanged: () => void }) {
  const [list, setList] = useState<AssetRow[] | null>(null)
  const [nw, setNw] = useState<NetWorth | null>(null)
  const [owners, setOwners] = useState<Owner[]>([])
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ name: '', kind: 'property' as AssetKind, value: '', asOf: today(), owner: '' })

  const load = useCallback(() => {
    void api('assets', profileId).then(setList).catch((e: Error) => setError(e.message))
    void api('netWorth', profileId).then(setNw).catch(() => setNw(null))
    if (profileId === null) void api('owners').then(setOwners)
  }, [profileId])
  useEffect(load, [load, version])
  const reload = () => { load(); onChanged() }

  const owner = profileId ?? (f.owner ? Number(f.owner) : owners[0]?.profileId)
  const add = async () => {
    const cents = toCents(f.value)
    if (cents === null) return setError('Enter what it is worth as a number, e.g. 350000')
    if (owner === undefined) return setError('Choose who owns it.')
    try { await api('assetCreate', owner, { name: f.name, kind: f.kind, valueCents: cents, asOf: f.asOf }); setF({ ...f, name: '', value: '' }); setAdding(false); setError(null); reload() } catch (e) { setError((e as Error).message) }
  }

  return (
    <Card>
      <div className="card-head"><h2>Net worth and what you own</h2><span className="muted">Add your house, car, stocks or anything else that counts toward what you are worth.</span></div>
      <ErrorBox error={error} />
      {nw && (
        <div className="grid stats" style={{ marginBottom: 12 }}>
          <div><div className="muted">Net worth</div><b className={`num ${nw.netWorthCents < 0 ? 'neg' : ''}`} style={{ fontSize: 22 }}>{formatCents(nw.netWorthCents)}</b></div>
          <div><div className="muted">In accounts</div><b className="num">{formatCents(nw.accountsCents)}</b></div>
          <div><div className="muted">Houses, cars, investments</div><b className="num">{formatCents(nw.assetsCents)}</b></div>
          <div><div className="muted">Owed (cards, loans, debts)</div><b className="num">{formatCents(nw.cardsOwedCents + nw.debtsCents)}</b></div>
        </div>
      )}
      {list && list.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Item</th><th className="r">Worth</th><th></th></tr></thead>
          <tbody>{list.map((a) => <AssetItem key={a.id} a={a} showOwner={profileId === null} reload={reload} />)}</tbody>
        </table></div>
      )}
      {list && list.length === 0 && !adding && <p className="muted">Nothing added yet.</p>}
      {adding ? (
        <div className="review-card" role="group" aria-label="Add something you own">
          <div className="filters" style={{ marginBottom: 0 }}>
            <label className="field">What is it<input value={f.name} maxLength={60} placeholder="e.g. House" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">Kind<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as AssetKind })}>{(Object.keys(KIND_LABEL) as AssetKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
            <label className="field">Worth ($)<input type="number" min="0" step="0.01" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} style={{ width: 140 }} /></label>
            <label className="field">As of<input type="date" value={f.asOf} onChange={(e) => setF({ ...f, asOf: e.target.value })} /></label>
            {profileId === null && <label className="field">Owner<select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>{owners.map((o) => <option key={o.profileId} value={o.profileId}>{o.kind === 'household' ? 'Shared (both of us)' : o.name}</option>)}</select></label>}
            <button className="btn primary" disabled={!f.name.trim() || !f.value.trim()} onClick={() => void add()}>Add</button>
            <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : <div><button className="btn small" onClick={() => setAdding(true)}>Add a house, car or investment</button></div>}
    </Card>
  )
}
