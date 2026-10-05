// Recurring payments found in the person's own transactions: suggestions to add, and questions about ones that stopped.
import type { Db } from './open'
import { normalizeKey } from '../core/normalize'
import { addDays } from '../core/dates'
import { pairReversals, reversedIds, REFUNDED_SHARE } from '../core/offsets'
import { detectRecurring, findStopped, sameMerchant, nameKeys, type Detected, type DetectTxn, type Direction, type Stopped, type TrackedItem } from '../core/recurringDetect'

/** Only the last ~14 months matter for spotting a pattern. */
const LOOKBACK_DAYS = 430

export interface RecurringSuggestion extends Detected { accountName: string | null; monthlyCents: number }

/** The person's regular-looking transactions, split into real ones and charges the bank reversed (a fee and its same-day rebate). */
function loadTxns(db: Db, profileId: number, today: string): { live: DetectTxn[]; reversed: DetectTxn[] } {
  // Cash entries never appear on a statement, and transfers (card payments, savings moves) are not bills.
  const rows = db.prepare(`SELECT t.id, t.account_id AS accountId, t.category_id AS categoryId, t.posted_date AS date, t.amount_cents AS amountCents, t.kind, COALESCE(t.description_raw, t.description) AS text
    FROM txn t JOIN account a ON a.id = t.account_id
    WHERE t.profile_id = ? AND t.kind IN ('income','expense','refund') AND a.type != 'cash' AND t.source != 'cash_entry' AND t.review_reason IS NULL AND t.posted_date >= ? AND t.posted_date <= ?`)
    .all(profileId, addDays(today, -LOOKBACK_DAYS), today) as { id: number; accountId: number; categoryId: number | null; date: string; amountCents: number; kind: string; text: string }[]
  const pairs = pairReversals(rows.map((r) => ({ id: r.id, date: r.date, amountCents: r.amountCents, kind: r.kind, category: r.categoryId === null ? null : String(r.categoryId), accountId: r.accountId })))
  const gone = reversedIds(pairs)
  const live: DetectTxn[] = []
  const reversed: DetectTxn[] = []
  for (const r of rows) {
    if (r.kind === 'refund') continue
    const t: DetectTxn = { key: normalizeKey(r.text), date: r.date, amountCents: r.amountCents, direction: r.kind as Direction, accountId: r.accountId }
    ;(gone.has(r.id) ? reversed : live).push(t)
  }
  return { live, reversed }
}

const perMonth = (cents: number, f: string) => Math.round(cents * ({ weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3 } as Record<string, number>)[f]!)

interface Existing { id: number; name: string; direction: string; match_key: string | null; account_id: number | null; amount_cents: number; frequency: string }
const existingItems = (db: Db, profileId: number) => db.prepare('SELECT id, name, direction, match_key, account_id, amount_cents, frequency FROM recurring WHERE profile_id = ?').all(profileId) as Existing[]

/** Is this detected payment already one of the tracked items? By merchant name, or (for items entered by hand under another name) by account, schedule and amount. */
function isTracked(h: Existing, d: Detected): boolean {
  if (h.match_key === d.key || nameKeys(h.name, normalizeKey).some((k) => sameMerchant(k, d.key))) return true
  if (h.match_key !== null && sameMerchant(h.match_key, d.key)) return true
  // "Phone plan" for ROGERS WIRELESS: same account, same schedule, same amount
  return h.account_id === d.accountId && h.frequency === d.frequency && Math.abs(h.amount_cents - d.amountCents) <= Math.max(100, d.amountCents * 0.02)
}

/** Regular payments the app can see but that are not tracked yet (and were not dismissed). */
export function suggestRecurring(db: Db, profileId: number, today: string): RecurringSuggestion[] {
  const detected = detectRecurring(loadTxns(db, profileId, today).live, today)
  const have = existingItems(db, profileId)
  const dismissed = new Set((db.prepare('SELECT key, direction FROM recurring_dismissed WHERE profile_id = ?').all(profileId) as { key: string; direction: string }[]).map((d) => `${d.direction}|${d.key}`))
  const accounts = new Map((db.prepare('SELECT id, name FROM account WHERE profile_id = ?').all(profileId) as { id: number; name: string }[]).map((a) => [a.id, a.name]))
  return detected
    .filter((d) => !dismissed.has(`${d.direction}|${d.key}`))
    .filter((d) => !have.some((h) => h.direction === d.direction && isTracked(h, d)))
    .map((d) => ({ ...d, accountName: accounts.get(d.accountId) ?? null, monthlyCents: perMonth(d.amountCents, d.frequency) }))
}

/**
 * Payments that repeat but that the bank always pays back (a monthly fee with a matching rebate). They cost nothing, so they are not suggested as bills;
 * the person can still track one anyway, or hide it. Already tracked or hidden ones are left out.
 */
export function refundedCharges(db: Db, profileId: number, today: string): RecurringSuggestion[] {
  const { live, reversed } = loadTxns(db, profileId, today)
  const have = existingItems(db, profileId)
  const dismissed = new Set((db.prepare('SELECT key, direction FROM recurring_dismissed WHERE profile_id = ?').all(profileId) as { key: string; direction: string }[]).map((d) => `${d.direction}|${d.key}`))
  const accounts = new Map((db.prepare('SELECT id, name FROM account WHERE profile_id = ?').all(profileId) as { id: number; name: string }[]).map((a) => [a.id, a.name]))
  return mostlyReversed(reversed, live, today)
    .filter((d) => !dismissed.has(`${d.direction}|${d.key}`))
    .filter((d) => !have.some((h) => h.direction === d.direction && isTracked(h, d)))
    .map((d) => ({ ...d, accountName: accounts.get(d.accountId) ?? null, monthlyCents: perMonth(d.amountCents, d.frequency) }))
}

/** Detected groups among the reversed charges where most occurrences were reversed (a few unreversed ones do not change the picture). */
function mostlyReversed(reversed: DetectTxn[], live: DetectTxn[], today: string): Detected[] {
  const liveGroups = detectRecurring(live, today)
  return detectRecurring(reversed, today).filter((d) => {
    const kept = liveGroups.find((g) => g.direction === d.direction && g.key === d.key && g.accountId === d.accountId)
    const left = live.filter((t) => t.direction === d.direction && t.key === d.key && t.accountId === d.accountId).length
    return !kept && d.occurrences / (d.occurrences + left) >= REFUNDED_SHARE
  })
}

/** Ids of tracked recurring items whose charges the bank keeps reversing. Items the person chose to keep ("Track anyway") are never in this set. */
export function refundedItemIds(db: Db, profileId: number, today: string): Set<number> {
  const { live, reversed } = loadTxns(db, profileId, today)
  const groups = mostlyReversed(reversed, live, today)
  if (groups.length === 0) return new Set()
  const items = db.prepare("SELECT id, name, direction, match_key, account_id, amount_cents, frequency FROM recurring WHERE profile_id = ? AND source != 'detected_kept'").all(profileId) as Existing[]
  return new Set(items.filter((h) => groups.some((d) => h.direction === d.direction && isTracked(h, d))).map((h) => h.id))
}

/** Tracks the chosen suggestions. Facts are re-derived here from the transactions; only the key and an optional new name come from the UI. */
export function addDetected(db: Db, profileId: number, items: { key: string; direction: Direction; name?: string; keepRefunded?: boolean }[], today: string): number[] {
  const found = new Map(suggestRecurring(db, profileId, today).map((s) => [`${s.direction}|${s.key}`, s]))
  for (const s of refundedCharges(db, profileId, today)) found.set(`${s.direction}|${s.key}`, s)
  const kept = new Set(items.filter((i) => i.keepRefunded).map((i) => `${i.direction}|${i.key}`))
  return db.transaction(() => items.map((i) => {
    const s = found.get(`${i.direction}|${i.key}`)
    if (!s) throw new Error('That payment is no longer a suggestion (it may already be tracked).')
    const name = (i.name ?? s.name).trim()
    if (!name) throw new Error('Give the item a name')
    return Number(db.prepare(`INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status, counts_in_budget, match_key, source, notes)
      VALUES (?,?,?,?,?,?,?, 'active', ?, ?, ?, ?)`)
      .run(profileId, name, s.direction, s.accountId, s.amountCents, s.frequency, s.lastDate, s.direction === 'expense' ? 1 : 0, s.key, kept.has(`${i.direction}|${i.key}`) ? 'detected_kept' : 'detected', `Found from ${s.occurrences} transactions since ${s.firstDate}.`).lastInsertRowid)
  }))()
}

export function dismissSuggestion(db: Db, profileId: number, key: string, direction: Direction): void {
  db.prepare('INSERT OR IGNORE INTO recurring_dismissed (profile_id, key, direction) VALUES (?,?,?)').run(profileId, key, direction)
}

export interface StoppedItem extends Stopped { amountCents: number; frequency: string; direction: string; accountName: string | null }

/** Tracked items that stopped showing up in the data. Cash bills and items with no way to be checked are never asked about. */
export function stoppedItems(db: Db, profileId: number): StoppedItem[] {
  const rows = db.prepare(`SELECT r.id, r.name, r.direction, r.frequency, r.amount_cents AS amountCents, r.account_id AS accountId, r.match_key AS matchKey, r.last_charged AS lastCharged, r.checked_at AS checkedAt, a.name AS accountName, a.type AS accountType
    FROM recurring r LEFT JOIN account a ON a.id = r.account_id WHERE r.profile_id = ? AND r.status IN ('active','new','updated')`).all(profileId) as
    { id: number; name: string; direction: Direction; frequency: string; amountCents: number; accountId: number | null; matchKey: string | null; lastCharged: string | null; checkedAt: string | null; accountName: string | null; accountType: string | null }[]
  const latestIn = db.prepare("SELECT MAX(posted_date) d FROM txn WHERE account_id = ? AND source != 'cash_entry'")
  const latestAny = (db.prepare("SELECT MAX(t.posted_date) d FROM txn t JOIN account a ON a.id = t.account_id WHERE t.profile_id = ? AND a.type != 'cash'").get(profileId) as { d: string | null }).d
  const txns = db.prepare(`SELECT t.posted_date AS date, t.amount_cents AS cents, t.kind, COALESCE(t.description_raw, t.description) AS text FROM txn t JOIN account a ON a.id = t.account_id WHERE t.profile_id = ? AND t.kind IN ('income','expense') AND a.type != 'cash' ORDER BY t.posted_date DESC`).all(profileId) as { date: string; cents: number; kind: string; text: string }[]
  const keyed = txns.map((t) => ({ ...t, key: normalizeKey(t.text) }))

  const items: TrackedItem[] = []
  const meta = new Map<number, (typeof rows)[number]>()
  for (const r of rows) {
    if (r.accountType === 'cash') continue // paid in cash: it never appears on a statement
    const ks = r.matchKey ? [r.matchKey] : nameKeys(r.name, normalizeKey)
    const hit = keyed.find((t) => t.kind === r.direction && ks.some((k) => sameMerchant(t.key, k))) // newest first
    const coverage = r.accountId !== null ? (latestIn.get(r.accountId) as { d: string | null }).d : latestAny
    items.push({ id: r.id, name: r.name, frequency: r.frequency, lastSeen: hit?.date ?? r.lastCharged, checkedAt: r.checkedAt, coverageEnd: coverage })
    meta.set(r.id, r)
  }
  return findStopped(items).map((s) => { const m = meta.get(s.id)!; return { ...s, amountCents: m.amountCents, frequency: m.frequency, direction: m.direction, accountName: m.accountName } })
}

/** "It was cancelled" moves it to the Cancelled list; "still active" stops the question until another full cycle has passed. */
export function answerStopped(db: Db, profileId: number, id: number, answer: 'cancelled' | 'active', today: string): void {
  const r = db.prepare('SELECT 1 FROM recurring WHERE id = ? AND profile_id = ?').get(id, profileId)
  if (!r) throw new Error('That recurring item no longer exists. Reload the page.')
  if (answer === 'cancelled') db.prepare("UPDATE recurring SET status = 'cancelled', notes = COALESCE(notes || ' ', '') || ? WHERE id = ?").run(`Marked cancelled on ${today}.`, id)
  else db.prepare('UPDATE recurring SET checked_at = ? WHERE id = ?').run(today, id)
}
