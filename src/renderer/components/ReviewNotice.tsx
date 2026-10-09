import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Page, TxnPreset } from '../App'

/**
 * A small sign on pages that show figures: older transactions (more than 90 days) are still waiting for review and are not counted.
 * They are not pushed at the person; this just says they exist, and opens them. Shows nothing when there are none.
 * `profileId` null is the household view, which covers everyone's.
 */
export function ReviewNotice({ profileId, goto }: { profileId: number | null; goto: (p: Page, pre?: TxnPreset) => void }) {
  const [n, setN] = useState<{ recent: number; older: number; days: number } | null>(null)
  useEffect(() => { api('reviewNotice', profileId).then(setN).catch(() => setN(null)) }, [profileId])
  if (!n || n.older === 0) return null
  const older = n.older.toLocaleString()
  return (
    <div className="notice review-notice" role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
      <span><b>⚑ {older} older transaction{n.older === 1 ? '' : 's'}</b> (more than {n.days} days old) {n.older === 1 ? 'is' : 'are'} still waiting for review, so {n.older === 1 ? 'it is' : 'they are'} not counted in these figures.</span>
      {profileId !== null && <button className="btn small" onClick={() => goto('review', { reviewTab: 'older' })}>Review them</button>}
      {profileId === null && <button className="btn small" onClick={() => goto('review')}>Open review</button>}
    </div>
  )
}
