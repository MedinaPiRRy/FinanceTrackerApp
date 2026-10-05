import crypto from 'node:crypto'
import { rememberCategory } from './rules'
import { addPartnerAlias } from './partners'
import type { Db } from './open'

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
export function resolveReview(db: Db, txnId: number, decision: Decision): void {
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
  })()
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
