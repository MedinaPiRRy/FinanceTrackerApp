// Adding, editing and deleting recurring items by hand (the app also finds them from transactions, see recurringDetect).
import type { Db } from './open'

export const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly', 'irregular'] as const
export type RecurringFrequency = (typeof FREQUENCIES)[number]

export interface RecurringInput {
  name: string
  direction: 'income' | 'expense'
  /** The account it is paid from or into. Null when it never touches an account the app knows. */
  accountId: number | null
  amountCents: number
  frequency: RecurringFrequency
  countsInBudget?: boolean
  notes?: string | null
  status?: 'active' | 'cancelled'
}

function check(db: Db, profileId: number, i: RecurringInput) {
  const name = i.name.trim()
  if (!name) throw new Error('Give the item a name.')
  if (name.length > 80) throw new Error('Keep the name under 80 characters.')
  if (i.direction !== 'income' && i.direction !== 'expense') throw new Error('Choose whether it is income or a bill.')
  if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) throw new Error('Enter an amount greater than zero.')
  if (!FREQUENCIES.includes(i.frequency)) throw new Error('Choose how often it happens.')
  if (i.status !== undefined && i.status !== 'active' && i.status !== 'cancelled') throw new Error('Status must be active or cancelled.')
  if (i.accountId !== null) {
    const a = db.prepare('SELECT profile_id p FROM account WHERE id = ?').get(i.accountId) as { p: number } | undefined
    if (!a || a.p !== profileId) throw new Error('Pick one of your own accounts, or leave it as "not in an account".')
  }
  return name
}

export function createRecurring(db: Db, profileId: number, i: RecurringInput): number {
  const name = check(db, profileId, i)
  return Number(db.prepare(`INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, status, counts_in_budget, notes, source) VALUES (?,?,?,?,?,?,?,?,?, 'manual')`)
    .run(profileId, name, i.direction, i.accountId, i.amountCents, i.frequency, i.status ?? 'active', i.direction === 'expense' && i.countsInBudget !== false ? 1 : 0, i.notes?.trim() || null).lastInsertRowid)
}

export function updateRecurring(db: Db, profileId: number, id: number, i: RecurringInput): void {
  if (!db.prepare('SELECT 1 FROM recurring WHERE id = ? AND profile_id = ?').get(id, profileId)) throw new Error('That item no longer exists. Reload the page.')
  const name = check(db, profileId, i)
  db.prepare(`UPDATE recurring SET name = ?, direction = ?, account_id = ?, amount_cents = ?, frequency = ?, status = COALESCE(?, status), counts_in_budget = ?, notes = ? WHERE id = ?`)
    .run(name, i.direction, i.accountId, i.amountCents, i.frequency, i.status ?? null, i.direction === 'expense' && i.countsInBudget !== false ? 1 : 0, i.notes?.trim() || null, id)
}

/** Removes the item. If the app found it from transactions it is also remembered as "not recurring", so it is not suggested straight back. */
export function deleteRecurring(db: Db, profileId: number, id: number): void {
  const r = db.prepare('SELECT match_key k, direction d FROM recurring WHERE id = ? AND profile_id = ?').get(id, profileId) as { k: string | null; d: string } | undefined
  if (!r) throw new Error('That item no longer exists. Reload the page.')
  db.transaction(() => {
    if (r.k) db.prepare('INSERT OR IGNORE INTO recurring_dismissed (profile_id, key, direction) VALUES (?,?,?)').run(profileId, r.k, r.d)
    db.prepare('DELETE FROM recurring WHERE id = ?').run(id)
  })()
}
