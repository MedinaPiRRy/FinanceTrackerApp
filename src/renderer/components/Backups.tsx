import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'
import { PagedItems } from './Pager'
import type { BackupInfo } from '../../main/maintenance'

const size = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** The backups the app can restore, and a way to put one back. Restoring saves the current data first, so it can be undone. */
export function Backups({ sample = false, folder }: { sample?: boolean; folder?: string }) {
  const [list, setList] = useState<BackupInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const load = useCallback(() => { void api('backupList').then((l) => { setList(l); setError(null) }).catch((e: Error) => setError(e.message)) }, [])
  useEffect(load, [load])

  const restore = async () => {
    if (!pick) return
    try {
      const r = await api('backupRestore', pick, typed)
      setDone(`Restored ${r.restored}. Your data from just before is saved as ${r.safetyBackup}. The app is reloading.`)
      setPick(null); setTyped('')
      setTimeout(() => window.location.reload(), 1500)
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <Card>
      <div className="card-head"><h2>Restore from a backup</h2></div>
      <p className="sub" style={{ marginTop: 0 }}>Put your data back the way it was in one of the backups below. The data you have now is saved first as a “before a restore” backup, so you can come back to it.</p>
      {folder && <p className="muted" style={{ marginTop: 0, wordBreak: 'break-all' }}>Backups are kept in <code>{folder}</code></p>}
      <ErrorBox error={error} />
      {done && <div className="notice" role="status">{done}</div>}
      {sample ? <p className="muted">Restoring is not available while you are looking at sample data. Start with your own data first, then come back here.</p> : list === null ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">There are no backups yet. Use “Back up my data now”, or turn on automatic backups under General.</p> : (
        <PagedItems items={list} name="backups" noun="Backups">{(pg) => (
          <div className="table-wrap"><table>
            <thead><tr><th>Made</th><th>Kind</th><th className="r">Size</th><th></th></tr></thead>
            <tbody>{pg.map((b) => (
              <tr key={b.name}>
                <td className="num">{b.madeAt.slice(0, 16).replace('T', ' ')}</td><td>{b.kind}</td><td className="r num">{size(b.sizeBytes)}</td>
                <td className="r"><button className="btn small" onClick={() => { setPick(b.name); setTyped(''); setError(null) }}>Restore…</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}</PagedItems>
      )}
      {pick && (
        <div className="review-card" role="group" aria-label="Confirm restore" style={{ marginTop: 12 }}>
          <b>Restore {pick}?</b>
          <p className="sub" style={{ margin: 0 }}>Everything you entered since that backup was made will be missing afterwards (it stays in the “before a restore” backup). Type RESTORE to continue.</p>
          <div className="filters" style={{ marginBottom: 0 }}>
            <label className="field">Type RESTORE<input value={typed} onChange={(e) => setTyped(e.target.value)} style={{ width: 140 }} /></label>
            <button className="btn danger" disabled={typed.trim() !== 'RESTORE'} onClick={() => void restore()}>Restore</button>
            <button className="btn" onClick={() => setPick(null)}>Cancel</button>
          </div>
        </div>
      )}
    </Card>
  )
}
