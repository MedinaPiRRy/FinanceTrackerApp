import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, Segmented } from '../components/ui'
import { useTheme, type ThemeSetting } from '../theme'

function formatBytes(n: number) {
  return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

export function Settings({ profile, partner, sample, onLeaveSample }: {
  profile: { id: number; name: string; kind: 'person' | 'household' }
  partner: { id: number; name: string } | null
  sample: boolean
  onLeaveSample: () => void
}) {
  const { setting, setSetting } = useTheme()
  const [diag, setDiag] = useState<Awaited<ReturnType<typeof api<'diagnostics'>>> | null>(null)
  const [backup, setBackup] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void api('diagnostics').then(setDiag).catch((e: Error) => setError(e.message)) }, [])
  const [aliases, setAliases] = useState('')
  const [aliasMsg, setAliasMsg] = useState<string | null>(null)
  useEffect(() => { if (profile.kind === 'person') void api('partnerAliases', profile.id).then((a) => setAliases(a.join('\n'))) }, [profile.id, profile.kind])

  const saveAliases = async () => {
    try { const saved = await api('setPartnerAliases', profile.id, aliases.split('\n')); setAliases(saved.join('\n')); setAliasMsg('Saved.') } catch (e) { setError((e as Error).message) }
  }
  const backUp = async () => {
    setError(null)
    try { const r = await api('backupNow'); setBackup(`Saved ${formatBytes(r.sizeBytes)} to ${r.file}`) } catch (e) { setError((e as Error).message) }
  }
  const leaveSample = async () => {
    if (!confirm('Remove the sample data and go back to setting up your own? Your own data (if any) is not affected.')) return
    try { await api('endSample'); onLeaveSample() } catch (e) { setError((e as Error).message) }
  }

  return (
    <>
      <div className="page-head"><div><h1>Settings</h1></div></div>
      <ErrorBox error={error} />
      <div className="grid" style={{ gap: 16, maxWidth: 760 }}>
        <Card>
          <div className="card-head"><h2>Appearance</h2></div>
          <Segmented<ThemeSetting> label="Theme" value={setting} onChange={setSetting} options={[{ value: 'system', label: 'Match system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </Card>
        <Card>
          <div className="card-head"><h2>Your data</h2></div>
          <p className="sub" style={{ marginTop: 0 }}>Everything is stored on this computer in a single database file. Nothing is sent over the internet, and there is no analytics or account.</p>
          {sample && (
            <div className="notice" style={{ marginBottom: 12 }}>
              You are looking at <b>sample data</b>. It is stored separately and never mixes with real data.
              <div style={{ marginTop: 8 }}><button className="btn" onClick={() => void leaveSample()}>Remove sample data and start with my own</button></div>
            </div>
          )}
          <div className="muted">Database location</div>
          <code style={{ wordBreak: 'break-all' }}>{diag?.dbPath ?? '…'}</code>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
            <button className="btn primary" onClick={() => void backUp()}>Back up my data now</button>
            <span className="muted">Saves a copy of the whole database. Worth doing before reinstalling your computer or moving to a new one.</span>
          </div>
          {backup && <p className="pos" role="status" style={{ marginBottom: 0, wordBreak: 'break-all' }}>{backup}</p>}
        </Card>
        {partner && profile.kind === 'person' && (
          <Card>
            <div className="card-head"><h2>Between {profile.name} and {partner.name}</h2></div>
            <p className="sub" style={{ marginTop: 0 }}>Money sent between the two of you is movement, not income or spending for either (one of you has spent it or will). Type the names that show up on e-transfers between you, one per line, and imports will recognise them automatically. The app also learns a name the first time you mark an e-transfer "Between us".</p>
            <textarea value={aliases} onChange={(e) => { setAliases(e.target.value); setAliasMsg(null) }} rows={4} style={{ width: '100%', maxWidth: 420 }} aria-label={`Names that mean ${partner.name} on e-transfers`} placeholder="e.g. Sam Rivera" />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}><button className="btn primary" onClick={() => void saveAliases()}>Save names</button>{aliasMsg && <span className="pos" role="status">{aliasMsg}</span>}</div>
          </Card>
        )}
        <Card>
          <div className="card-head"><h2>About</h2></div>
          {!diag ? <p className="muted">Loading…</p> : (
            <div className="kv">
              <div><div className="k">Version</div><div className="v">{diag.version}</div></div>
              <div><div className="k">Transactions stored</div><div className="v num">{diag.transactions.toLocaleString()}</div></div>
              <div><div className="k">Database size</div><div className="v">{formatBytes(diag.dbSizeBytes)} · schema v{diag.schemaVersion}</div></div>
              <div><div className="k">Backups folder</div><div className="v" style={{ wordBreak: 'break-all', fontWeight: 500 }}>{diag.backupDir}</div></div>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
