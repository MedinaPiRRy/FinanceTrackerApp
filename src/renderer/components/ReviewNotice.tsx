import { useEffect, useState } from 'react'
import { api } from '../api'
import { monthLabel } from '../format'
import type { Page, TxnPreset } from '../App'

/**
 * A warning on a page that shows one month's figures: some of that month's transactions are older than the "older" cut-off and
 * were never reviewed, so they are not counted and the figures may not match the statements. Shown only for a month that has
 * such transactions (nothing appears for months without any, or for the current month), and never nags about other months.
 * `profileId` null is the household view, which covers everyone's.
 */
export function ReviewNotice({ profileId, month, goto }: { profileId: number | null; month: string | undefined; goto: (p: Page, pre?: TxnPreset) => void }) {
  const [n, setN] = useState<{ older: number; days: number } | null>(null)
  useEffect(() => {
    if (!month) { setN(null); return }
    api('reviewNotice', profileId, month).then(setN).catch(() => setN(null))
  }, [profileId, month])
  if (!month || !n || n.older === 0) return null
  return (
    <div className="notice review-notice" role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
      <span><b>⚑ {n.older.toLocaleString()} transaction{n.older === 1 ? '' : 's'} from {monthLabel(month)}</b> {n.older === 1 ? 'is' : 'are'} still waiting for review (older than {n.days} days), so {n.older === 1 ? 'it is' : 'they are'} not counted. This month's figures may not match your bank statements.</span>
      {profileId !== null && <button className="btn small" onClick={() => goto('review', { reviewTab: 'older' })}>Review them</button>}
      {profileId === null && <button className="btn small" onClick={() => goto('review')}>Open review</button>}
    </div>
  )
}
