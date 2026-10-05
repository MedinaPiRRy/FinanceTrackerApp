import crypto from 'node:crypto'
import type { Db } from './open'
import { monthKey } from '../core/dates'

const fingerprint = () => `cash-${crypto.randomUUID()}`
const iso = /^\d{4}-\d{2}-\d{2}$/

function cashAccountId(db: Db, profileId: number): number {
  const a = db.prepare("SELECT id FROM account WHERE profile_id = ? AND type = 'cash' ORDER BY id LIMIT 1").get(profileId) as { id: number } | undefined
  if (a) return a.id
  return Number(db.prepare("INSERT INTO account (profile_id, name, type) VALUES (?, 'Cash', 'cash')").run(profileId).lastInsertRowid)
}

function categoryId(db: Db, profileId: number, name: string, kind: 'income' | 'expense'): number {
  const c = db.prepare('SELECT id FROM category WHERE profile_id = ? AND kind = ? AND name = ?').get(profileId, kind, name) as { id: number } | undefined
  if (c) return c.id
  return Number(db.prepare('INSERT INTO category (profile_id, name, kind) VALUES (?,?,?)').run(profileId, name, kind).lastInsertRowid)
}

export function cashBalanceCents(db: Db, profileId: number): number {
  const id = cashAccountId(db, profileId)
  const a = db.prepare('SELECT opening_balance_cents o FROM account WHERE id = ?').get(id) as { o: number }
  const s = db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM txn WHERE account_id = ?').get(id) as { s: number }
  return a.o + s.s
}

export const HOME_CURRENCY = 'CAD'
export interface ForeignAmount { currency: string; /** In the foreign currency's cents. */ cents: number; /** Home currency per 1 unit of the foreign one. */ rate: number }

/** Value in home-currency cents, rounded to the nearest cent. */
export const convertCents = (foreignCents: number, rate: number) => Math.round(foreignCents * rate)

const fxKey = (currency: string) => `fx_rate_${currency}`
/** The last rate the person used for each foreign currency, so the next entry starts from it. */
export function lastRates(db: Db): Record<string, number> {
  const rows = db.prepare("SELECT key, value FROM setting WHERE key LIKE 'fx_rate_%'").all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map((r) => [r.key.slice(8), Number(r.value)]).filter(([, v]) => Number.isFinite(v) && (v as number) > 0))
}

/**
 * Record cash tips for a day. Goes into the Cash wallet as income (category "Tips"), never into a bank balance.
 * Tips received in another currency are converted at the rate the person typed (the app is offline, so it never looks
 * rates up). The converted amount is what counts everywhere; the original amount and rate are kept for display.
 * Bank transactions are not handled here: banks convert foreign purchases themselves.
 */
export function addTip(db: Db, profileId: number, date: string, cents: number, note?: string, foreign?: ForeignAmount): number {
  if (!iso.test(date)) throw new Error('Date must be YYYY-MM-DD')
  let home = cents
  let currency: string | null = null
  let original: number | null = null
  let rate: number | null = null
  if (foreign) {
    const cur = foreign.currency.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(cur)) throw new Error('A currency code has three letters, e.g. USD')
    if (cur === HOME_CURRENCY) throw new Error(`That is the home currency (${HOME_CURRENCY}). Leave the currency on the default instead.`)
    if (!Number.isInteger(foreign.cents) || foreign.cents <= 0) throw new Error('Tip amount must be greater than zero')
    if (!Number.isFinite(foreign.rate) || foreign.rate <= 0 || foreign.rate > 10000) throw new Error('Enter the exchange rate as a positive number, e.g. 1.37')
    home = convertCents(foreign.cents, foreign.rate)
    if (home <= 0) throw new Error('That amount converts to less than one cent')
    currency = cur; original = foreign.cents; rate = foreign.rate
  }
  if (!Number.isInteger(home) || home <= 0) throw new Error('Tip amount must be greater than zero')
  return db.transaction(() => {
    const id = Number(
      db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, category_id, kind, notes, source, fingerprint, currency, original_cents, fx_rate) VALUES (?,?,?,?,?,?,'income',?,'cash_entry',?,?,?,?)`)
        .run(profileId, cashAccountId(db, profileId), date, home, 'Tips', categoryId(db, profileId, 'Tips', 'income'), note ?? null, fingerprint(), currency, original, rate).lastInsertRowid
    )
    if (currency && rate) db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(fxKey(currency), String(rate))
    return id
  })()
}

/**
 * Cash spent on something (lunch, parking, a gift...). A real expense that shows in spending even though it never
 * appears on a bank statement. The balance may go below zero if tips were not logged yet; the UI explains that.
 */
export function addCashSpend(db: Db, profileId: number, date: string, cents: number, description: string, expenseCategoryId: number, note?: string): { id: number; balanceCents: number } {
  if (!iso.test(date)) throw new Error('Date must be YYYY-MM-DD')
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('The amount spent must be greater than zero')
  const what = description.trim()
  if (!what) throw new Error('Say what the cash was spent on')
  const cat = db.prepare('SELECT profile_id p, kind FROM category WHERE id = ?').get(expenseCategoryId) as { p: number; kind: string } | undefined
  if (!cat || cat.p !== profileId || cat.kind !== 'expense') throw new Error('Pick one of your spending categories')
  const id = Number(
    db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, category_id, kind, notes, source, fingerprint) VALUES (?,?,?,?,?,?,'expense',?,'cash_entry',?)`)
      .run(profileId, cashAccountId(db, profileId), date, -cents, what, expenseCategoryId, note?.trim() || null, fingerprint()).lastInsertRowid
  )
  return { id, balanceCents: cashBalanceCents(db, profileId) }
}

/**
 * Pay a recurring bill from cash (e.g. a phone plan paid with tips). Creates a real expense that shows in
 * spending even though it never appears on a bank statement. One payment per bill per month.
 */
export function recordCashBill(db: Db, profileId: number, recurringId: number, date: string, expenseCategoryId: number): number {
  if (!iso.test(date)) throw new Error('Date must be YYYY-MM-DD')
  const r = db.prepare('SELECT name, amount_cents a FROM recurring WHERE id = ? AND profile_id = ?').get(recurringId, profileId) as { name: string; a: number } | undefined
  if (!r) throw new Error('That recurring item no longer exists. Reload the page.')
  const cat = db.prepare('SELECT profile_id, kind FROM category WHERE id = ?').get(expenseCategoryId) as { profile_id: number; kind: string } | undefined
  if (!cat || cat.profile_id !== profileId || cat.kind !== 'expense') throw new Error('Pick one of your expense categories')
  const dup = db.prepare(`SELECT 1 FROM txn WHERE profile_id = ? AND source = 'cash_entry' AND description = ? AND substr(posted_date,1,7) = ?`).get(profileId, r.name, monthKey(date))
  if (dup) throw new Error(`${r.name} is already recorded for ${monthKey(date)}`)
  return Number(
    db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, category_id, kind, notes, source, fingerprint) VALUES (?,?,?,?,?,?,'expense','Paid in cash','cash_entry',?)`)
      .run(profileId, cashAccountId(db, profileId), date, -r.a, r.name, expenseCategoryId, fingerprint()).lastInsertRowid
  )
}

/** Deposit cash into a bank account. A transfer (two linked legs), so deposited tips are not counted as income twice. */
export function depositCash(db: Db, profileId: number, date: string, cents: number, toAccountId: number): { groupId: string } {
  if (!iso.test(date)) throw new Error('Date must be YYYY-MM-DD')
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('Deposit must be greater than zero')
  const to = db.prepare('SELECT type, profile_id p FROM account WHERE id = ?').get(toAccountId) as { type: string; p: number } | undefined
  if (!to || to.p !== profileId) throw new Error('Pick one of your own accounts')
  if (to.type !== 'chequing' && to.type !== 'savings') throw new Error('Cash can be deposited into a chequing or savings account')
  const cash = cashAccountId(db, profileId)
  const group = `deposit-${crypto.randomUUID()}`
  db.transaction(() => {
    const ins = db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, transfer_group, source, fingerprint) VALUES (?,?,?,?,?,'transfer',?,'cash_entry',?)`)
    ins.run(profileId, cash, date, -cents, 'Cash deposited to bank', group, fingerprint())
    ins.run(profileId, toAccountId, date, cents, 'Cash deposit (from cash on hand)', group, fingerprint())
  })()
  return { groupId: group }
}

/** Removes an entry made through the Cash page (and its other leg for deposits). Rows that came from a bank statement can never be deleted here. */
export function deleteCashEntry(db: Db, profileId: number, txnId: number): number {
  const t = db.prepare('SELECT source, transfer_group g FROM txn WHERE id = ? AND profile_id = ?').get(txnId, profileId) as { source: string; g: string | null } | undefined
  if (!t) throw new Error('That cash entry no longer exists.')
  if (t.source !== 'cash_entry') throw new Error('Only entries made on the Cash page can be deleted here')
  return db.transaction(() => (t.g ? db.prepare('DELETE FROM txn WHERE transfer_group = ? AND source = ?').run(t.g, 'cash_entry').changes : db.prepare('DELETE FROM txn WHERE id = ?').run(txnId).changes))()
}
