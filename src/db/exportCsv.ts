// "Export my transactions": one CSV file the person can open in a spreadsheet. Read-only.
import type { Db } from './open'

const HEADER = ['Date', 'Person', 'Account', 'Description', 'Category', 'Type', 'Amount', 'Notes', 'Needs review']

/** Quotes a field for CSV. Text starting with = + - @ is prefixed so a spreadsheet never runs it as a formula. */
export function csvField(v: string | number | null): string {
  if (v === null) return ''
  if (typeof v === 'number') return String(v)
  // a plain number such as -12.50 is data, not a formula
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export const csvRow = (cols: (string | number | null)[]): string => cols.map(csvField).join(',')

/** Every transaction of one person (or of everyone when `profileId` is null), oldest first. Amounts are dollars with a minus for money out. */
export function exportTransactionsCsv(db: Db, profileId: number | null): { fileName: string; csv: string; count: number } {
  const rows = db.prepare(`SELECT t.posted_date AS date, p.name AS person, a.name AS account, t.description, c.name AS category, t.kind, t.amount_cents AS cents, t.notes, t.review_reason AS reason
    FROM txn t JOIN account a ON a.id = t.account_id JOIN profile p ON p.id = t.profile_id LEFT JOIN category c ON c.id = t.category_id
    ${profileId === null ? '' : 'WHERE t.profile_id = ?'} ORDER BY t.posted_date, t.id`).all(...(profileId === null ? [] : [profileId])) as
    { date: string; person: string; account: string; description: string; category: string | null; kind: string; cents: number; notes: string | null; reason: string | null }[]
  const lines = [csvRow(HEADER)]
  for (const r of rows) lines.push(csvRow([r.date, r.person, r.account, r.description, r.category, r.kind, (r.cents / 100).toFixed(2), r.notes, r.reason ? 'yes' : '']))
  const who = profileId === null ? 'everyone' : (db.prepare('SELECT name FROM profile WHERE id = ?').get(profileId) as { name: string } | undefined)?.name ?? 'transactions'
  const stamp = new Date().toLocaleDateString('en-CA')
  return { fileName: `transactions-${who.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}.csv`, csv: lines.join('\r\n') + '\r\n', count: rows.length }
}
