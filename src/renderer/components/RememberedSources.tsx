import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'
import type { SourceRule } from '../../db/sourceRules'

const KIND: Record<string, string> = { income: 'Income', expense: 'Expense', refund: 'Refund or reimbursement', transfer: 'Transfer' }

/** Sources the person chose to always file the same way (the "Always do this for…" tick-box in Review). They can forget any of them. */
export function RememberedSources({ profileId }: { profileId: number }) {
  const [rules, setRules] = useState<SourceRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => { api('sourceRules', profileId).then((r) => { setRules(r); setError(null) }).catch((e: Error) => setError(e.message)) }, [profileId])
  useEffect(load, [load])
  const forget = async (r: SourceRule) => {
    try { await api('sourceRuleDelete', profileId, r.id); load() } catch (e) { setError((e as Error).message) }
  }
  return (
    <Card>
      <div className="card-head"><h2>Remembered sources</h2></div>
      <p className="sub" style={{ marginTop: 0 }}>Sources you told the app to always file the same way when you reviewed them. Forgetting one only affects future imports and reviews: transactions already filed stay as they are.</p>
      <ErrorBox error={error} />
      {rules === null ? <p className="muted">Loading…</p> : rules.length === 0 ? <p className="muted">None yet. Tick “Always do this for…” while reviewing a transaction to add one.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Source</th><th>Money</th><th>Filed as</th><th></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.direction === 'in' ? 'coming in' : 'going out'}</td>
                <td>{KIND[r.kind] ?? r.kind}{r.categoryName ? ` · ${r.categoryName}` : ''}{r.debtName ? ` · counts toward ${r.debtName}` : ''}</td>
                <td className="r"><button className="btn small danger" aria-label={`Forget ${r.name}`} onClick={() => void forget(r)}>Forget</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Card>
  )
}
