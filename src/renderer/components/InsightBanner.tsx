import { useEffect, useState } from 'react'
import { api } from '../api'
import { pickBannerTip, type Insight } from '../../core/insights'
import type { Page } from '../App'

const KEY = 'insightBannerSeen' // JSON { date, ids } in localStorage: tips already dismissed today
const todayKey = () => new Date().toLocaleDateString('en-CA')
const readSeen = (): string[] => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { date: string; ids: string[] } | null; return v && v.date === todayKey() ? v.ids : [] } catch { return [] } }
const writeSeen = (ids: string[]) => { try { localStorage.setItem(KEY, JSON.stringify({ date: todayKey(), ids })) } catch { /* not remembered */ } }

/** One tip when the app opens. Dismissing it hides it for the rest of the day; "Another tip" shows the next one. */
export function InsightBanner({ profileId, goto }: { profileId: number; goto: (p: Page, preset?: { insightId?: string }) => void }) {
  const [tips, setTips] = useState<Insight[]>([])
  const [seen, setSeen] = useState<string[]>(readSeen)

  useEffect(() => { void api('insights', profileId).then((d) => setTips(d.insights)).catch(() => setTips([])) }, [profileId])
  const tip = pickBannerTip(tips, seen)
  if (!tip) return null

  const hide = (next: string[]) => { setSeen(next); writeSeen(next) }
  const more = pickBannerTip(tips, [...seen, tip.id!]) !== null
  return (
    <div className="top-banner" role="status" style={{ background: tip.tone === 'warn' ? 'var(--warn-soft)' : tip.tone === 'good' ? 'var(--pos-soft)' : undefined }}>
      <span><b>{tip.title}</b>{tip.detail ? <span className="muted"> {tip.detail}</span> : null}</span>
      <span style={{ display: 'flex', gap: 8 }}>
        <button className="btn small primary" onClick={() => goto('insights', { insightId: tip.id })}>What does this mean?</button>
        {more && <button className="btn small" onClick={() => hide([...seen, tip.id!])}>Another tip</button>}
        <button className="btn small" aria-label="Dismiss for today" onClick={() => hide([...seen, ...tips.map((t) => t.id!)])}>✕</button>
      </span>
    </div>
  )
}
