import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'
import { START_PAGES, OLDER_CHOICES, BACKUP_CHOICES, type AppSettings } from '../../db/appSettings'
import type { Profile } from '../../db/queries'

const PAGE_LABEL: Record<(typeof START_PAGES)[number], string> = {
  dashboard: 'Dashboard', monthly: 'Monthly review', transactions: 'Transactions', review: 'Review queue', accounts: 'Accounts', budget: 'Budget', forecast: 'Forecast'
}
const DAYS_LABEL: Record<number, string> = { 30: '30 days', 90: '90 days (default)', 180: '6 months (180 days)', 365: '12 months (365 days)' }

/** Names of the people, the page the app opens on, when waiting transactions count as older, and automatic backups. */
export function GeneralSettings({ onRenamed }: { onRenamed: () => void }) {
  const [people, setPeople] = useState<Profile[]>([])
  const [names, setNames] = useState<Record<number, string>>({})
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void api('profiles').then((ps) => { const persons = ps; setPeople(persons); setNames(Object.fromEntries(persons.map((p) => [p.id, p.name]))) }).catch((e: Error) => setError(e.message))
    void api('appSettings').then(setSettings).catch((e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])

  const say = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3000) }
  const rename = async (p: Profile) => {
    try { await api('renameProfile', p.id, names[p.id] ?? ''); say(`Saved. ${p.name} is now ${(names[p.id] ?? '').trim()}.`); setError(null); load(); onRenamed() } catch (e) { setError((e as Error).message) }
  }
  const set = async <K extends keyof AppSettings>(key: K, value: AppSettings[K], note: string) => {
    try { setSettings(await api('setAppSetting', key, value)); say(note); setError(null) } catch (e) { setError((e as Error).message) }
  }

  return (
    <Card>
      <div className="card-head"><h2>General</h2></div>
      <ErrorBox error={error} />
      {msg && <div className="notice" role="status">{msg}</div>}

      <h3 style={{ fontSize: 14, margin: '4px 0' }}>Names</h3>
      <p className="sub" style={{ marginTop: 0 }}>Shown everywhere in the app. Changing a name never changes your data.</p>
      {people.map((p) => (
        <div key={p.id} className="filters" style={{ marginBottom: 6 }}>
          <label className="field">Name<input value={names[p.id] ?? ''} maxLength={40} onChange={(e) => setNames({ ...names, [p.id]: e.target.value })} aria-label={`Name of ${p.name}`} style={{ width: 220 }} /></label>
          <button className="btn" disabled={(names[p.id] ?? '').trim() === p.name || !(names[p.id] ?? '').trim()} onClick={() => void rename(p)}>Save name</button>
        </div>
      ))}

      {settings && (
        <div className="filters" style={{ marginTop: 14, marginBottom: 0 }}>
          <label className="field">Open the app on
            <select value={settings.startPage} onChange={(e) => void set('startPage', e.target.value as AppSettings['startPage'], 'Saved. The app will open on that page.')}>
              {START_PAGES.map((p) => <option key={p} value={p}>{PAGE_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="field">Waiting transactions count as “older” after
            <select value={settings.olderAfterDays} onChange={(e) => void set('olderAfterDays', Number(e.target.value), 'Saved. Review and the notices now use this.')}>
              {OLDER_CHOICES.map((d) => <option key={d} value={d}>{DAYS_LABEL[d]}</option>)}
            </select>
          </label>
          <label className="field">Automatic backup
            <select value={settings.autoBackupKeep} onChange={(e) => void set('autoBackupKeep', Number(e.target.value), 'Saved.')}>
              {BACKUP_CHOICES.map((k) => <option key={k} value={k}>{k === 0 ? 'Off' : `Keep the last ${k}`}</option>)}
            </select>
          </label>
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Older transactions stay out of the badge and banners (they have their own tab in Review). An automatic backup is made the first time the app opens each day, in the backups folder shown under About.</p>
    </Card>
  )
}
