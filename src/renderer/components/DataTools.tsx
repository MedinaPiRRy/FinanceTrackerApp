import { useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'

/** Export every transaction to a CSV file (one person, or everyone). */
export function ExportCard({ profileId, ownLabel, everyone }: { profileId: number; ownLabel: string; everyone: boolean }) {
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (id: number | null) => {
    setError(null); setMsg(null)
    try {
      const r = await api('exportCsv', id)
      if (r.csv) { // the browser-based development server: hand the file to the browser
        const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }))
        const a = document.createElement('a'); a.href = url; a.download = r.fileName; a.click(); URL.revokeObjectURL(url)
        setMsg(`Downloaded ${r.count.toLocaleString()} transactions.`)
      } else if (!r.cancelled) setMsg(`Saved ${r.count.toLocaleString()} transactions to ${r.savedTo}`)
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Card>
      <div className="card-head"><h2>Export</h2></div>
      <p className="sub" style={{ marginTop: 0 }}>Save every transaction (date, account, description, category, type, amount) as a CSV file you can open in a spreadsheet. The file is saved on this computer only.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void run(profileId)}>{ownLabel}</button>
        {everyone && <button className="btn" onClick={() => void run(null)}>Export everyone’s transactions</button>}
      </div>
      <ErrorBox error={error} />
      {msg && <p className="pos" role="status" style={{ wordBreak: 'break-all', marginBottom: 0 }}>{msg}</p>}
    </Card>
  )
}

/** Erase all data, or erase it and uninstall the app. Both need a typed word, and a backup copy can be kept. */
export function DangerZone({ sample, onErased }: { sample: boolean; onErased: () => void }) {
  const [open, setOpen] = useState<'erase' | 'app' | null>(null)
  const [typed, setTyped] = useState('')
  const [keep, setKeep] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const word = open === 'app' ? 'DELETE' : 'ERASE'
  const go = async () => {
    setBusy(true); setError(null)
    try {
      if (open === 'app') {
        const r = await api('deleteApp', typed, keep)
        setDone(`${r.message}${r.backupFile ? ` A backup copy was kept at ${r.backupFile}.` : ''}`)
        if (!r.uninstallerStarted) setTimeout(onErased, 4000)
      } else {
        const r = await api('eraseAll', typed, keep)
        setDone(`Everything was erased.${r.backupFile ? ` A backup copy was kept at ${r.backupFile}.` : ''}`)
        setTimeout(onErased, 2500)
      }
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  return (
    <Card className="danger-zone">
      <div className="card-head"><h2>Erase and uninstall</h2></div>
      {sample ? <p className="sub" style={{ margin: 0 }}>You are looking at sample data, which holds nothing real. Remove it above, then these options apply to your own data.</p> : done ? <div className="notice" role="status">{done}</div> : (
        <>
          <p className="sub" style={{ marginTop: 0 }}>These cannot be undone. Your data lives only on this computer, so unless you keep a backup copy, it is gone for good.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn danger" aria-expanded={open === 'erase'} onClick={() => { setOpen(open === 'erase' ? null : 'erase'); setTyped(''); setError(null) }}>Erase all my data</button>
            <button className="btn danger" aria-expanded={open === 'app'} onClick={() => { setOpen(open === 'app' ? null : 'app'); setTyped(''); setError(null) }}>Delete the app and its data</button>
          </div>
          {open && (
            <div className="review-card" style={{ marginTop: 12 }} role="group" aria-label={open === 'app' ? 'Delete the app and its data' : 'Erase all my data'}>
              <b>{open === 'app' ? 'Delete the app and everything in it' : 'Erase every transaction, account, budget, goal and setting'}</b>
              <p className="sub" style={{ margin: 0 }}>{open === 'app' ? 'Your data is erased first, then the uninstaller starts and the app closes. On Mac and Linux you are told how to remove the app itself.' : 'The app goes back to the welcome screen, as if it were new.'}</p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />Keep one backup copy of my data first (in the backups folder)</label>
              <label className="field">Type {word} to confirm<input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={word} style={{ width: 200 }} autoComplete="off" /></label>
              <ErrorBox error={error} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn danger" disabled={typed.trim() !== word || busy} onClick={() => void go()}>{open === 'app' ? 'Erase data and uninstall' : 'Erase everything'}</button>
                <button className="btn" onClick={() => setOpen(null)}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
