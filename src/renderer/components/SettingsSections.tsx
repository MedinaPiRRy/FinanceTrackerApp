import type { ReactNode } from 'react'
import { Card } from './ui'
import type { Page, TxnPreset } from '../App'

export interface SettingsSection { id: string; label: string; blurb: string; body: ReactNode }

/**
 * Settings as a list of sections. With no section chosen, a list to pick from; with one, just that section and a link back.
 * The chosen section lives in the page's history entry, so the Back button goes from a section to the list and on to the page before.
 */
export function SettingsSections({ sections, section, goto }: { sections: SettingsSection[]; section?: string; goto: (p: Page, preset?: TxnPreset) => void }) {
  const current = sections.find((s) => s.id === section)
  if (current) {
    return (
      <>
        <div className="page-head">
          <div>
            <button className="btn small" onClick={() => goto('settings')} aria-label="Back to Settings">← Back to Settings</button>
            <p className="muted" style={{ margin: '8px 0 0' }}>Settings › {current.label}</p>
          </div>
        </div>
        <div className="grid" style={{ gap: 16, maxWidth: 760 }}>{current.body}</div>
      </>
    )
  }
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><p>Choose a section.</p></div></div>
      <nav aria-label="Settings sections" className="grid two" style={{ maxWidth: 900 }}>
        {sections.map((s) => (
          <Card key={s.id} className="settings-tile" onClick={() => goto('settings', { section: s.id })}>
            <button className="txn-link" style={{ textAlign: 'left', fontSize: 16, fontWeight: 650 }} onClick={(e) => { e.stopPropagation(); goto('settings', { section: s.id }) }}>{s.label} →</button>
            <p className="sub" style={{ margin: '4px 0 0' }}>{s.blurb}</p>
          </Card>
        ))}
      </nav>
    </>
  )
}
