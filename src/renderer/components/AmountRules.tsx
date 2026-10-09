import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'
import { formatCents } from '../format'
import type { AmountRule } from '../../db/amountRules'
import type { CategoryInfo } from '../../db/queries'

interface Form { id: number | null; name: string; words: string; limit: string; low: string; high: string }
const BLANK: Form = { id: null, name: '', words: '', limit: '30', low: '', high: '' }

/** "At gas stations, up to $30 is snacks and drinks, more than that is gas": a category that depends on how much was spent. */
export function AmountRules({ profileId, onChanged }: { profileId: number; onChanged: () => void }) {
  const [rules, setRules] = useState<AmountRule[] | null>(null)
  const [cats, setCats] = useState<CategoryInfo[]>([])
  const [form, setForm] = useState<Form | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [refile, setRefile] = useState(false)
  const [preview, setPreview] = useState<{ id: number; matched: number; changed: number } | null>(null)

  const load = useCallback(() => {
    void api('amountRules', profileId).then((r) => { setRules(r); setError(null) }).catch((e: Error) => setError(e.message))
    void api('categories', profileId).then((c) => setCats(c.filter((x) => x.kind === 'expense'))).catch(() => setCats([]))
  }, [profileId])
  useEffect(load, [load])

  const run = async (fn: () => Promise<unknown>, note?: string) => {
    try { await fn(); setError(null); if (note) { setMsg(note); setTimeout(() => setMsg(null), 5000) }; load(); onChanged() } catch (e) { setError((e as Error).message) }
  }
  const save = () => {
    if (!form) return
    const limit = Math.round(Number(form.limit) * 100)
    if (!form.limit.trim() || Number.isNaN(limit)) return setError('Enter the amount as a number, e.g. 30')
    const input = { name: form.name, words: form.words.split(/[,\n]/), limitCents: limit, lowCategoryId: Number(form.low), highCategoryId: Number(form.high) }
    void run(async () => { if (form.id === null) await api('amountRuleCreate', profileId, input); else await api('amountRuleUpdate', profileId, form.id, input); setForm(null) }, 'Rule saved. Use “Apply” to file purchases already waiting for a category.')
  }
  const check = async (id: number) => {
    try { const r = await api('amountRuleApply', profileId, id, { includeCategorised: refile }); setPreview({ id, ...r }); setError(null) } catch (e) { setError((e as Error).message) }
  }

  return (
    <Card>
      <div className="card-head"><h2>Rules by amount</h2></div>
      <p className="sub" style={{ marginTop: 0 }}>For places where the amount tells you what was bought. For example, a gas station purchase up to $30 is probably a snack or a drink, and more than that is gas. New imports follow these rules, and a purchase you categorise yourself is never changed.</p>
      <ErrorBox error={error} />
      {msg && <div className="notice" role="status">{msg}</div>}
      {rules && rules.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Rule</th><th>Up to the amount</th><th>More than the amount</th><th></th></tr></thead>
          <tbody>{rules.map((r) => (
            <tr key={r.id}>
              <td>{r.name}<div className="muted" style={{ fontSize: 12 }}>{r.words.join(', ')}</div></td>
              <td>{formatCents(r.limitCents)} or less → {r.lowCategory}</td>
              <td>over {formatCents(r.limitCents)} → {r.highCategory}</td>
              <td className="r" style={{ whiteSpace: 'nowrap' }}>
                <button className="btn small" onClick={() => void check(r.id)}>Apply…</button>{' '}
                <button className="btn small" onClick={() => setForm({ id: r.id, name: r.name, words: r.words.join(', '), limit: (r.limitCents / 100).toString(), low: String(r.lowCategoryId), high: String(r.highCategoryId) })}>Edit</button>{' '}
                <button className="btn small danger" aria-label={`Delete the rule ${r.name}`} onClick={() => { if (confirm(`Delete the rule “${r.name}”? Purchases already filed stay where they are.`)) void run(() => api('amountRuleDelete', profileId, r.id)) }}>Delete</button>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {preview && (
        <div className="review-card" role="group" aria-label="Apply this rule to existing purchases">
          <p className="sub" style={{ margin: 0 }}>{preview.changed === 0 ? 'Nothing needs changing.' : `${preview.changed.toLocaleString()} purchase${preview.changed === 1 ? '' : 's'} would be filed by this rule.`} {refile ? '' : 'Only purchases still waiting for a category are looked at.'}</p>
          <label className="check"><input type="checkbox" checked={refile} onChange={(e) => { setRefile(e.target.checked); setPreview(null) }} /> Also re-file bank purchases the app already categorised on its own (anything you filed yourself stays)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={preview.changed === 0} onClick={() => void run(async () => { const r = await api('amountRuleApply', profileId, preview.id, { includeCategorised: refile, apply: true }); setPreview(null); setMsg(`${r.changed.toLocaleString()} purchase${r.changed === 1 ? '' : 's'} filed.`) })}>Apply</button>
            <button className="btn" onClick={() => setPreview(null)}>Close</button>
          </div>
        </div>
      )}
      {form ? (
        <div className="review-card" role="group" aria-label={form.id === null ? 'New rule' : 'Edit rule'}>
          <div className="filters" style={{ marginBottom: 0 }}>
            <label className="field">Name<input value={form.name} maxLength={60} placeholder="e.g. Gas stations" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field">Words in the merchant’s name<input value={form.words} placeholder="PETRO, SHELL, ESSO" style={{ width: 260 }} onChange={(e) => setForm({ ...form, words: e.target.value })} /></label>
            <label className="field">Amount ($)<input type="number" min="1" step="0.01" value={form.limit} style={{ width: 100 }} onChange={(e) => setForm({ ...form, limit: e.target.value })} /></label>
            <label className="field">That much or less is<select value={form.low} onChange={(e) => setForm({ ...form, low: e.target.value })}><option value="">Choose…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
            <label className="field">More than that is<select value={form.high} onChange={(e) => setForm({ ...form, high: e.target.value })}><option value="">Choose…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
            <button className="btn primary" disabled={!form.name.trim() || !form.words.trim() || !form.low || !form.high} onClick={save}>Save</button>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      ) : <div><button className="btn small" onClick={() => setForm({ ...BLANK })}>Add a rule</button></div>}
    </Card>
  )
}
