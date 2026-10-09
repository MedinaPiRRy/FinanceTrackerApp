import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createDebt, debtHistory } from '../src/db/debts'
import { linkPaymentToDebt, unlinkPayment, listDebtPayments } from '../src/db/debtPayments'
import { resolveReview, resolveReviewGroup } from '../src/db/review'
import { listSourceRules } from '../src/db/sourceRules'
import { buildPreview, commitImport, type CommitRow } from '../src/db/import'
import { queryTxns, listDebts } from '../src/db/queries'

let db: Db
let p: number, chq: number, loans: number, osap: number
let n = 0
const NSLSC = 'Electronic Funds Transfer PREAUTHORIZED DEBIT NSLSC'
const add = (cents: number, date: string, text = NSLSC, kind = 'expense', category: number | null = loans, reason: string | null = null, profile = p) =>
  Number(db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, review_reason, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,'import',?)").run(profile, chq, date, cents, text, text, kind, category, reason, `d${n++}`).lastInsertRowid)
const balance = (id = osap) => (listDebts(db, p).find((d) => d.id === id)!)

beforeEach(() => {
  db = openDb(':memory:')
  p = Number(db.prepare("INSERT INTO profile (slug, name) VALUES ('sam', 'Sam')").run().lastInsertRowid)
  chq = Number(db.prepare("INSERT INTO account (profile_id, name, type) VALUES (?, 'Chequing', 'chequing')").run(p).lastInsertRowid)
  loans = Number(db.prepare("INSERT INTO category (profile_id, name, kind) VALUES (?, 'Insurance, loans and admin', 'expense')").run(p).lastInsertRowid)
  osap = createDebt(db, p, 'OSAP', 1_000_000, '2026-09-01')
})

describe('payments that count toward a loan', () => {
  it('lowers the balance and records it in the loan history', () => {
    const t = add(-25_000, '2026-09-15')
    expect(linkPaymentToDebt(db, t, osap)).toEqual({ appliedCents: 25_000 })
    expect(balance()).toMatchObject({ balanceCents: 975_000, asOf: '2026-09-15' })
    expect(debtHistory(db, p, osap).map((h) => [h.asOf, h.balanceCents])).toEqual([['2026-09-01', 1_000_000], ['2026-09-15', 975_000]])
    expect(listDebtPayments(db, p, osap)).toEqual([{ txnId: t, date: '2026-09-15', description: NSLSC, amountCents: 25_000, appliedCents: 25_000 }])
    expect(queryTxns(db, p, {}).rows.find((r) => r.id === t)).toMatchObject({ debtId: osap, debtName: 'OSAP' })
  })

  it('two payments, even on the same day, both count; a payment older than the balance is only linked', () => {
    linkPaymentToDebt(db, add(-10_000, '2026-09-15'), osap)
    linkPaymentToDebt(db, add(-5_000, '2026-09-15'), osap)
    expect(balance().balanceCents).toBe(985_000)
    const old = add(-7_000, '2026-08-20') // before the balance typed on 2026-09-01: already part of it
    expect(linkPaymentToDebt(db, old, osap)).toEqual({ appliedCents: 0 })
    expect(balance().balanceCents).toBe(985_000)
  })

  it('never goes below zero, and refuses what is not a payment by that person', () => {
    expect(linkPaymentToDebt(db, add(-2_000_000, '2026-09-20'), osap)).toEqual({ appliedCents: 1_000_000 })
    expect(balance().balanceCents).toBe(0)
    const income = add(5_000, '2026-09-21', 'PAY', 'income', null)
    expect(() => linkPaymentToDebt(db, income, osap)).toThrow(/Only money paid out/)
    const other = Number(db.prepare("INSERT INTO profile (slug, name) VALUES ('jo', 'Jo')").run().lastInsertRowid)
    expect(() => linkPaymentToDebt(db, add(-1_000, '2026-09-22', NSLSC, 'expense', null, null, other), osap)).toThrow(/belongs to someone else/)
    const t = add(-1_000, '2026-09-23')
    linkPaymentToDebt(db, t, createDebt(db, p, 'Car', 500_000, '2026-01-01'))
    expect(() => linkPaymentToDebt(db, t, osap)).toThrow(/already counts toward "Car"/)
  })

  it('unlinking puts the amount back while that balance is the latest, and leaves a newer typed balance alone', () => {
    const t = add(-25_000, '2026-09-15')
    linkPaymentToDebt(db, t, osap)
    expect(unlinkPayment(db, t)).toEqual({ restoredCents: 25_000 })
    expect(balance().balanceCents).toBe(1_000_000)
    expect(listDebtPayments(db, p, osap)).toEqual([])

    const t2 = add(-25_000, '2026-09-16')
    linkPaymentToDebt(db, t2, osap)
    db.prepare("UPDATE debt SET balance_cents = 960000, as_of = '2026-09-30' WHERE id = ?").run(osap) // the person typed the lender's balance later
    db.prepare("INSERT INTO debt_history (debt_id, as_of, balance_cents) VALUES (?, '2026-09-30', 960000)").run(osap)
    expect(unlinkPayment(db, t2)).toEqual({ restoredCents: 0 })
    expect(balance().balanceCents).toBe(960_000)
    expect(() => unlinkPayment(db, t2)).toThrow(/not counted/)
  })

  it('deleting the transaction removes its link', () => {
    const t = add(-25_000, '2026-09-15')
    linkPaymentToDebt(db, t, osap)
    db.prepare('DELETE FROM txn WHERE id = ?').run(t)
    expect(listDebtPayments(db, p, osap)).toEqual([])
  })
})

describe('in the review queue', () => {
  const queued = (date: string, cents = -25_000) => add(cents, date, NSLSC, 'unclassified', null, 'Needs your decision')

  it('one decision files the expense and counts it toward the loan', () => {
    const t = queued('2026-09-15')
    resolveReview(db, t, { kind: 'expense', categoryId: loans, debtId: osap })
    expect(balance().balanceCents).toBe(975_000)
    expect(queryTxns(db, p, {}).rows.find((r) => r.id === t)).toMatchObject({ kind: 'expense', category: 'Insurance, loans and admin', debtName: 'OSAP' })
  })

  it('"always do this" remembers the loan: it counts later payments in the queue and future imports', () => {
    const first = queued('2026-09-15'), second = queued('2026-09-29', -30_000)
    resolveReview(db, first, { kind: 'expense', categoryId: loans, debtId: osap }, { remember: true })
    expect(listSourceRules(db, p).map((r) => [r.name, r.kind, r.categoryName, r.debtName])).toEqual([['Nslsc', 'expense', 'Insurance, loans and admin', 'OSAP']])
    expect(listDebtPayments(db, p, osap).map((x) => x.txnId).sort()).toEqual([first, second].sort())
    expect(balance().balanceCents).toBe(945_000)

    const pv = buildPreview(db, p, chq, { format: 'headered', warnings: [], rows: [{ line: 2, date: '2026-10-15', description: NSLSC, amountCents: -20_000 }] }, 'oct.csv')
    expect(pv.rows[0]).toMatchObject({ kind: 'expense', categoryId: loans, debtId: osap })
    const rows: CommitRow[] = pv.rows.map(({ idx: _i, line: _l, suggestionSource: _s, matchedDescription: _m, nearMatch: _n, ...r }) => r)
    commitImport(db, p, chq, 'oct.csv', rows, { learnFromDuplicates: false })
    expect(balance()).toMatchObject({ balanceCents: 925_000, asOf: '2026-10-15' })
  })

  it('a whole source can be filed and counted at once', () => {
    queued('2026-09-10'); queued('2026-09-20')
    resolveReviewGroup(db, p, 'money_out', '2026-10-04', '-NSLSC', { kind: 'expense', categoryId: loans, debtId: osap })
    expect(listDebtPayments(db, p, osap)).toHaveLength(2)
    expect(balance().balanceCents).toBe(950_000)
  })
})
