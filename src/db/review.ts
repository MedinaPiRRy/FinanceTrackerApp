import crypto from 'node:crypto'
import { rememberCategory } from './rules'
import { addPartnerAlias } from './partners'
import type { Db } from './open'
import { normalizeKey, displayName } from '../core/normalize'
import { reviewTabOf, recentFrom, REVIEW_TABS, type ReviewTab } from '../core/reviewTabs'
import { olderAfterDays } from './appSettings'
import { addSourceRule, directionOf, type RuleKind } from './sourceRules'

export interface ReviewItem {
  id: number
  profileId: number
  accountId: number
  account: string
  date: string
  description: string
  amountCents: number
  reason: string
  notes: string | null
}

export function listReviewQueue(db: Db, profileId: number): ReviewItem[] {
  return db
    .prepare(
      `SELECT t.id, t.profile_id AS profileId, t.account_id AS accountId, a.name AS account, t.posted_date AS date,
              t.description, t.amount_cents AS amountCents, t.review_reason AS reason, t.notes
       FROM txn t JOIN account a ON a.id = t.account_id
       WHERE t.profile_id = ? AND t.review_reason IS NOT NULL
       ORDER BY t.posted_date DESC, t.id DESC`
    )
    .all(profileId) as ReviewItem[]
}

export type Decision =
  | { kind: 'income'; categoryId: number; note?: string }
  | { kind: 'expense'; categoryId: number; note?: string }
  | { kind: 'refund'; categoryId: number; note?: string } // includes reimbursements: reduces spending in that category
  | { kind: 'transfer'; counterAccountId?: number; note?: string } // between your own accounts (or into a shared one); never counts as income/spending
  | { kind: 'between_us'; partnerProfileId: number; note?: string } // money to/from the other person: movement between you, not income or spending for either
  | { kind: 'keep'; note?: string } // "this is fine as it is" (e.g. a real duplicate): clears the flag only

/**
 * Applies the user's decision to a queued transaction. Sign rules are enforced so a decision can never
 * silently flip the meaning of money (income must be money in, expense must be money out).
 */
export function resolveReview(db: Db, txnId: number, decision: Decision, opts: { remember?: boolean } = {}): { alsoResolved: number } {
  let also = 0
  db.transaction(() => {
    const t = db.prepare('SELECT * FROM txn WHERE id = ? AND review_reason IS NOT NULL').get(txnId) as
      | { id: number; profile_id: number; account_id: number; posted_date: string; amount_cents: number; description: string; description_raw: string | null; kind: string; notes: string | null }
      | undefined
    if (!t) throw new Error(`Transaction ${txnId} is not in the review queue`)

    const checkCategory = (id: number, kind: 'income' | 'expense') => {
      const c = db.prepare('SELECT profile_id, kind FROM category WHERE id = ?').get(id) as { profile_id: number; kind: string } | undefined
      if (!c) throw new Error('That category no longer exists. Pick another.')
      if (c.profile_id !== t.profile_id) throw new Error('That category belongs to someone else. Pick one of your own.')
      if (c.kind !== kind) throw new Error(`Category is a ${c.kind} category`)
    }
    const note = decision.note ? (t.notes ? `${t.notes} | ${decision.note}` : decision.note) : t.notes

    if (decision.kind === 'keep') {
      db.prepare("UPDATE txn SET review_reason = NULL, reviewed_at = datetime('now'), notes = ? WHERE id = ?").run(note, txnId)
      return
    }
    if (decision.kind === 'between_us') {
      const partner = db.prepare("SELECT id FROM profile WHERE id = ? AND kind = 'person'").get(decision.partnerProfileId) as { id: number } | undefined
      if (!partner || partner.id === t.profile_id) throw new Error('Pick the other person')
      db.prepare("UPDATE txn SET kind = 'transfer', category_id = NULL, counterparty_profile_id = ?, review_reason = NULL, reviewed_at = datetime('now'), notes = ? WHERE id = ?").run(partner.id, note, txnId)
      addPartnerAlias(db, t.profile_id, t.description_raw ?? t.description) // next time this name is recognised automatically
      return
    }
    if (decision.kind === 'income') {
      if (t.amount_cents <= 0) throw new Error('Income must be money coming in')
      checkCategory(decision.categoryId, 'income')
    }
    if (decision.kind === 'expense') {
      if (t.amount_cents >= 0) throw new Error('An expense must be money going out')
      checkCategory(decision.categoryId, 'expense')
    }
    if (decision.kind === 'refund') {
      if (t.amount_cents <= 0) throw new Error('A refund/reimbursement must be money coming in')
      checkCategory(decision.categoryId, 'expense')
    }

    const categoryId = decision.kind === 'transfer' ? null : decision.categoryId
    let group: string | null = null
    let crossProfile: number | null = null
    if (decision.kind === 'transfer' && decision.counterAccountId) {
      const counter = db.prepare('SELECT id, profile_id, type FROM account WHERE id = ?').get(decision.counterAccountId) as { id: number; profile_id: number; type: string } | undefined
      if (!counter) throw new Error('The other account no longer exists. Pick another.')
      if (counter.id === t.account_id) throw new Error('A transfer needs a different account')
      group = `xfer-${t.id}`
      // Manually valued accounts (investments) have no transaction ledger; the user updates their value instead.
      if (counter.type !== 'investment') {
        const cross = counter.profile_id !== t.profile_id
        db.prepare(
          `INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, transfer_group, counterparty_profile_id, notes, source, fingerprint)
           VALUES (?,?,?,?,?,'transfer',?,?,?,'manual',?)`
        ).run(counter.profile_id, counter.id, t.posted_date, -t.amount_cents, `Transfer (${t.description})`, group, cross ? t.profile_id : null, 'Counterpart created from review queue', `manual-${crypto.randomUUID()}`)
      }
      if (counter.profile_id !== t.profile_id) crossProfile = counter.profile_id
    }
    db.prepare("UPDATE txn SET kind = ?, category_id = ?, transfer_group = COALESCE(?, transfer_group), counterparty_profile_id = COALESCE(?, counterparty_profile_id), review_reason = NULL, reviewed_at = datetime('now'), notes = ? WHERE id = ?").run(decision.kind, categoryId, group, crossProfile, note, txnId)
    if (categoryId !== null && t.description_raw) rememberCategory(db, t.profile_id, t.description_raw, t.description, categoryId) // e-transfers are skipped inside
    if (opts.remember && (decision.kind === 'income' || decision.kind === 'expense' || decision.kind === 'refund' || decision.kind === 'transfer')) {
      addSourceRule(db, t.profile_id, normalizeKey(t.description_raw ?? t.description), directionOf(t.amount_cents), decision.kind, categoryId)
      also = applySourceRules(db, t.profile_id)
    }
  })()
  return { alsoResolved: also }
}

interface QueueRow { id: number; amountCents: number; key: string }

const queueRows = (db: Db, profileId: number): QueueRow[] =>
  (db.prepare('SELECT id, amount_cents AS amountCents, description, description_raw AS raw FROM txn WHERE profile_id = ? AND review_reason IS NOT NULL').all(profileId) as { id: number; amountCents: number; description: string; raw: string | null }[])
    .map((r) => ({ id: r.id, amountCents: r.amountCents, key: normalizeKey(r.raw ?? r.description) }))

/** Files every waiting transaction whose source the person already decided about. Returns how many were filed. */
export function applySourceRules(db: Db, profileId: number): number {
  const rules = db.prepare('SELECT source_key AS k, direction AS d, kind, category_id AS c FROM source_rule WHERE profile_id = ?').all(profileId) as { k: string; d: string; kind: RuleKind; c: number | null }[]
  if (rules.length === 0) return 0
  const byKey = new Map(rules.map((r) => [`${r.k}|${r.d}`, r]))
  let n = 0
  for (const q of queueRows(db, profileId)) {
    const r = byKey.get(`${q.key}|${directionOf(q.amountCents)}`)
    if (!r) continue
    let decision: Decision
    if (r.kind === 'transfer') decision = { kind: 'transfer' }
    else if (r.c === null) continue
    else decision = { kind: r.kind, categoryId: r.c }
    try { resolveReview(db, q.id, decision); n++ } catch { /* a stale rule (deleted category, changed sign) leaves the item waiting */ }
  }
  return n
}

// ---- the paginated, tabbed, grouped view of the queue ----

export interface ReviewGroup { key: string; name: string; count: number; totalCents: number; firstDate: string; lastDate: string }
export interface ReviewSummary { total: number; /** Waiting and recent: what the badge and banners count. */ recent: number; /** Waiting for more than 90 days: set aside. */ older: number; tabs: { tab: ReviewTab; label: string; hint: string; count: number; totalCents: number }[] }

export function reviewSummary(db: Db, profileId: number, today: string): ReviewSummary {
  const rows = db.prepare('SELECT posted_date AS date, amount_cents AS amountCents, kind, review_reason AS reason FROM txn WHERE profile_id = ? AND review_reason IS NOT NULL').all(profileId) as { date: string; amountCents: number; kind: string; reason: string }[]
  const tabs = REVIEW_TABS.map((t) => ({ ...t, count: 0, totalCents: 0 }))
  const days = olderAfterDays(db)
  for (const r of rows) { const t = tabs.find((x) => x.tab === reviewTabOf(r, today, days))!; t.count++; t.totalCents += r.amountCents }
  const older = tabs.find((t) => t.tab === 'older')!.count
  return { total: rows.length, recent: rows.length - older, older, tabs }
}
/** How many waiting transactions are recent and how many are older (set aside). `profileId` null = everyone (the household view). */
export function reviewNotice(db: Db, profileId: number | null, today: string): { recent: number; older: number; days: number } {
  const days = olderAfterDays(db)
  const cut = recentFrom(today, days)
  const r = db.prepare(`SELECT COALESCE(SUM(posted_date >= ?), 0) AS recent, COALESCE(SUM(posted_date < ?), 0) AS older FROM txn WHERE review_reason IS NOT NULL${profileId === null ? '' : ' AND profile_id = ?'}`).get(...(profileId === null ? [cut, cut] : [cut, cut, profileId])) as { recent: number; older: number }
  return { ...r, days }
}


const tabRows = (db: Db, profileId: number, tab: ReviewTab, today: string) => {
  const days = olderAfterDays(db)
  return (db.prepare('SELECT id, posted_date AS date, amount_cents AS amountCents, kind, review_reason AS reason, description, description_raw AS raw FROM txn WHERE profile_id = ? AND review_reason IS NOT NULL').all(profileId) as { id: number; date: string; amountCents: number; kind: string; reason: string; description: string; raw: string | null }[])
    .filter((r) => reviewTabOf(r, today, days) === tab)
    // money in and money out under the same name are different groups (a decision only makes sense in one direction)
    .map((r) => ({ ...r, key: `${r.amountCents > 0 ? '+' : '-'}${normalizeKey(r.raw ?? r.description)}` }))
}

/** Groups in a tab by source, biggest first (so one decision clears the most). */
export function reviewGroups(db: Db, profileId: number, tab: ReviewTab, today: string, offset = 0, limit = 20): { total: number; groups: ReviewGroup[] } {
  const by = new Map<string, ReviewGroup>()
  for (const r of tabRows(db, profileId, tab, today)) {
    const g = by.get(r.key) ?? { key: r.key, name: displayName(r.key.slice(1)) || r.description, count: 0, totalCents: 0, firstDate: r.date, lastDate: r.date }
    g.count++; g.totalCents += r.amountCents
    if (r.date < g.firstDate) g.firstDate = r.date
    if (r.date > g.lastDate) g.lastDate = r.date
    by.set(r.key, g)
  }
  const all = [...by.values()].sort((a, b) => b.count - a.count || Math.abs(b.totalCents) - Math.abs(a.totalCents) || a.name.localeCompare(b.name))
  return { total: all.length, groups: all.slice(offset, offset + limit) }
}

/** The individual transactions of one source in a tab, newest first, one page at a time. */
export function reviewGroupItems(db: Db, profileId: number, tab: ReviewTab, today: string, key: string, offset = 0, limit = 20): { total: number; items: ReviewItem[] } {
  const ids = tabRows(db, profileId, tab, today).filter((r) => r.key === key).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).map((r) => r.id)
  const page = ids.slice(offset, offset + limit)
  if (page.length === 0) return { total: ids.length, items: [] }
  const items = db.prepare(`SELECT t.id, t.profile_id AS profileId, t.account_id AS accountId, a.name AS account, t.posted_date AS date, t.description, t.amount_cents AS amountCents, t.review_reason AS reason, t.notes
    FROM txn t JOIN account a ON a.id = t.account_id WHERE t.id IN (${page.map(() => '?').join(',')}) ORDER BY t.posted_date DESC, t.id DESC`).all(...page) as ReviewItem[]
  return { total: ids.length, items }
}

/** Applies one decision to every waiting transaction of a source in a tab. All or nothing. */
export function resolveReviewGroup(db: Db, profileId: number, tab: ReviewTab, today: string, key: string, decision: Decision, opts: { remember?: boolean } = {}): { resolved: number; alsoResolved: number } {
  const ids = tabRows(db, profileId, tab, today).filter((r) => r.key === key).map((r) => r.id)
  if (ids.length === 0) throw new Error('Those transactions were already decided. Reload the page.')
  let also = 0
  db.transaction(() => {
    let first = true
    for (const id of ids) {
      // remembering on the first one already filed the rest of the source
      if (!db.prepare('SELECT 1 FROM txn WHERE id = ? AND review_reason IS NOT NULL').get(id)) continue
      also += resolveReview(db, id, decision, { remember: !!opts.remember && first }).alsoResolved
      first = false
    }
  })()
  return { resolved: ids.length, alsoResolved: also }
}

// ---- manually valued accounts (investments) -------------------------------------------------

export function setValuation(db: Db, accountId: number, asOf: string, valueCents: number, note?: string): void {
  const a = db.prepare('SELECT type FROM account WHERE id = ?').get(accountId) as { type: string } | undefined
  if (!a) throw new Error('That account no longer exists. Reload the page.')
  if (a.type !== 'investment') throw new Error('Only investment accounts are valued manually')
  db.prepare(
    `INSERT INTO account_valuation (account_id, as_of, value_cents, note) VALUES (?,?,?,?)
     ON CONFLICT(account_id, as_of) DO UPDATE SET value_cents = excluded.value_cents, note = excluded.note`
  ).run(accountId, asOf, valueCents, note ?? null)
}

/** Current value in cents. Investments: latest manual valuation (null if never entered). Others: opening + transactions. */
export function accountValueCents(db: Db, accountId: number): number | null {
  const a = db.prepare('SELECT type, opening_balance_cents AS opening FROM account WHERE id = ?').get(accountId) as { type: string; opening: number } | undefined
  if (!a) throw new Error('That account no longer exists. Reload the page.')
  if (a.type === 'investment') {
    const v = db.prepare('SELECT value_cents AS v FROM account_valuation WHERE account_id = ? ORDER BY as_of DESC LIMIT 1').get(accountId) as { v: number } | undefined
    return v ? v.v : null
  }
  const s = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM txn WHERE account_id = ?').get(accountId) as { s: number }
  return a.opening + s.s
}
