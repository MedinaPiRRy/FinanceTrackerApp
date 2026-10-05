import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { listReviewQueue, resolveReview, setValuation, accountValueCents } from '../src/db/review'
import { summarizeMonth } from '../src/core/summary'

let db: Db
let p1: number, p2: number, chq: number, sav: number, inv: number, otherChq: number
let incCat: number, expCat: number, otherCat: number
let n = 0

function addTxn(profile: number, account: number, date: string, cents: number, desc: string, kind: string, review: string | null) {
  return Number(
    db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, review_reason, source, fingerprint) VALUES (?,?,?,?,?,?,?,'manual',?)`)
      .run(profile, account, date, cents, desc, kind, review, `fp${n++}`).lastInsertRowid
  )
}

beforeEach(() => {
  db = openDb(':memory:')
  p1 = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('alex','Alex')").run().lastInsertRowid)
  p2 = Number(db.prepare("INSERT INTO profile (slug,name) VALUES ('sam','Sam')").run().lastInsertRowid)
  const acct = (p: number, name: string, type: string) => Number(db.prepare('INSERT INTO account (profile_id,name,type) VALUES (?,?,?)').run(p, name, type).lastInsertRowid)
  chq = acct(p1, 'Chequing', 'chequing')
  sav = acct(p1, 'Savings', 'savings')
  inv = acct(p1, 'Home fund', 'investment')
  otherChq = acct(p2, 'Chequing', 'chequing')
  const cat = (p: number, name: string, kind: string) => Number(db.prepare('INSERT INTO category (profile_id,name,kind) VALUES (?,?,?)').run(p, name, kind).lastInsertRowid)
  incCat = cat(p1, 'Gifts received', 'income')
  expCat = cat(p1, 'Dining', 'expense')
  otherCat = cat(p2, 'Dining', 'expense')
})

describe('review queue', () => {
  it('lists only the profile\'s flagged rows', () => {
    addTxn(p1, chq, '2026-03-01', 5000, 'E-Transfer from X', 'unclassified', 'e-transfer?')
    addTxn(p1, chq, '2026-03-02', -500, 'Coffee', 'expense', null)
    addTxn(p2, otherChq, '2026-03-03', 100, 'Other person', 'unclassified', 'what?')
    const q = listReviewQueue(db, p1)
    expect(q).toHaveLength(1)
    expect(q[0]!.description).toBe('E-Transfer from X')
  })

  it('an unresolved row counts as neither income nor spending', () => {
    addTxn(p1, chq, '2026-03-01', 5000, 'E-Transfer from X', 'unclassified', 'e-transfer?')
    const s = summarizeMonth([{ date: '2026-03-01', amountCents: 5000, kind: 'unclassified', category: null }], '2026-03')
    expect(s.incomeCents).toBe(0)
    expect(s.expenseCents).toBe(0)
  })

  it('resolving as income clears the flag and records it', () => {
    const id = addTxn(p1, chq, '2026-03-01', 5000, 'E-Transfer from X', 'unclassified', 'e-transfer?')
    resolveReview(db, id, { kind: 'income', categoryId: incCat, note: 'birthday' })
    const t = db.prepare('SELECT kind, category_id c, review_reason r, reviewed_at ra, notes FROM txn WHERE id=?').get(id) as { kind: string; c: number; r: string | null; ra: string | null; notes: string }
    expect(t).toMatchObject({ kind: 'income', c: incCat, r: null, notes: 'birthday' })
    expect(t.ra).not.toBeNull()
    expect(listReviewQueue(db, p1)).toHaveLength(0)
  })

  it('treats a reimbursement as a refund that reduces spending', () => {
    const id = addTxn(p1, chq, '2026-03-05', 2000, 'E-Transfer from friend', 'unclassified', 'e-transfer?')
    resolveReview(db, id, { kind: 'refund', categoryId: expCat, note: 'dinner split' })
    const s = summarizeMonth([{ date: '2026-03-05', amountCents: 2000, kind: 'refund', category: 'Dining' }, { date: '2026-03-04', amountCents: -6000, kind: 'expense', category: 'Dining' }], '2026-03')
    expect(s.expenseCents).toBe(4000)
    expect(s.incomeCents).toBe(0)
  })

  it('refuses decisions that would flip the meaning of money', () => {
    const out = addTxn(p1, chq, '2026-03-01', -5000, 'E-Transfer to X', 'unclassified', 'x')
    const inn = addTxn(p1, chq, '2026-03-01', 5000, 'E-Transfer from X', 'unclassified', 'x')
    expect(() => resolveReview(db, out, { kind: 'income', categoryId: incCat })).toThrow()
    expect(() => resolveReview(db, inn, { kind: 'expense', categoryId: expCat })).toThrow()
    expect(listReviewQueue(db, p1)).toHaveLength(2) // nothing changed
  })

  it("refuses another person's category", () => {
    const id = addTxn(p1, chq, '2026-03-01', -5000, 'Thing', 'unclassified', 'x')
    expect(() => resolveReview(db, id, { kind: 'expense', categoryId: otherCat })).toThrow(/someone else/)
  })

  it('a transfer creates a balanced counterpart leg in the other account', () => {
    const id = addTxn(p1, chq, '2026-03-01', -10000, 'Moved money', 'unclassified', 'x')
    resolveReview(db, id, { kind: 'transfer', counterAccountId: sav })
    const g = db.prepare('SELECT SUM(amount_cents) s, COUNT(*) n FROM txn WHERE transfer_group IS NOT NULL').get() as { s: number; n: number }
    expect(g).toEqual({ s: 0, n: 2 })
    expect(accountValueCents(db, sav)).toBe(10000)
  })

  it('a transfer to an investment account creates no ledger leg (value is entered by hand)', () => {
    const id = addTxn(p1, chq, '2026-03-01', -800000, 'Moved to investment', 'unclassified', 'x')
    resolveReview(db, id, { kind: 'transfer', counterAccountId: inv })
    expect((db.prepare('SELECT COUNT(*) n FROM txn WHERE account_id = ?').get(inv) as { n: number }).n).toBe(0)
  })

  it('"keep" only clears the flag', () => {
    const id = addTxn(p1, chq, '2026-03-01', -1000, 'Same coffee twice', 'expense', 'Possible duplicate')
    resolveReview(db, id, { kind: 'keep', note: 'really bought two' })
    expect(listReviewQueue(db, p1)).toHaveLength(0)
    expect((db.prepare('SELECT kind FROM txn WHERE id=?').get(id) as { kind: string }).kind).toBe('expense')
  })

  it('cannot resolve a row twice', () => {
    const id = addTxn(p1, chq, '2026-03-01', 5000, 'x', 'unclassified', 'x')
    resolveReview(db, id, { kind: 'income', categoryId: incCat })
    expect(() => resolveReview(db, id, { kind: 'income', categoryId: incCat })).toThrow(/not in the review queue/)
  })
})

describe('manually valued investment accounts', () => {
  it('has no value until entered, then uses the latest valuation', () => {
    expect(accountValueCents(db, inv)).toBeNull()
    setValuation(db, inv, '2026-09-01', 800000)
    setValuation(db, inv, '2026-10-01', 815000, 'checked online')
    expect(accountValueCents(db, inv)).toBe(815000)
  })
  it('updating the same date replaces the value', () => {
    setValuation(db, inv, '2026-10-01', 100)
    setValuation(db, inv, '2026-10-01', 200)
    expect(accountValueCents(db, inv)).toBe(200)
  })
  it('refuses valuations on normal accounts', () => {
    expect(() => setValuation(db, chq, '2026-10-01', 100)).toThrow()
  })
})
