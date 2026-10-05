import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ProgressBar } from '../components/ui'
import { formatCents, pct } from '../format'
import { Goals } from './Goals'
import type { AccountInfo, CategoryInfo, Profile } from '../../db/queries'
import type { HouseholdGoal } from '../../db/household'
import type { Page } from '../App'

/** Household goals (owned together) first, then each person's own goals, read-only and labelled by owner. */
export function HouseholdGoals({ profile, accounts, categories, goto }: { profile: Profile; accounts: AccountInfo[]; categories: CategoryInfo[]; goto: (p: Page) => void }) {
  const [others, setOthers] = useState<HouseholdGoal[]>([])
  useEffect(() => { void api('householdGoals').then((g) => setOthers(g.filter((x) => x.ownerKind === 'person'))) }, [])
  return (
    <>
      <Goals profile={profile} accounts={accounts} categories={categories} goto={goto} householdMode />
      <div style={{ height: 20 }} />
      <Card>
        <div className="card-head"><h2>Each person's goals</h2></div>
        <p className="sub" style={{ marginTop: 0 }}>Read-only here, including the wedding goal. Edit them from that person's own Goals page.</p>
        {others.length === 0 ? <p className="muted">No personal goals yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Goal</th><th>Whose</th><th className="r">Progress</th><th className="r">Remaining</th></tr></thead>
            <tbody>
              {others.map((g) => (
                <tr key={`${g.ownerId}-${g.id}`}>
                  <td>{g.name}</td>
                  <td><span className="badge">{g.owner}</span></td>
                  <td className="r"><div style={{ minWidth: 120 }}><ProgressBar value={g.progress.progress} tone="goal" label={`${g.name} progress`} /><span className="muted" style={{ fontSize: 12 }}>{pct(g.progress.progress)}</span></div></td>
                  <td className="r num">{formatCents(g.progress.remainingCents)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </>
  )
}
