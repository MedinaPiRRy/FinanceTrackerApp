import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db/open'
import { createSetup } from '../src/db/defaults'
import { pairReversals, type PairTxn } from '../src/core/offsets'
import { suggestRecurring, refundedCharges, addDetected, dismissSuggestion } from '../src/db/recurringDetect'
import { listRecurring, getDashboard } from '../src/db/queries'
import { createBudget } from '../src/db/budgets'
import { budgetDrill, householdBudgetDrill } from '../src/db/budgetDrill'
import { listHouseholdBudgets } from '../src/db/household'
import { generateSample } from '../src/demo/sample'
import { txnPreset } from '../src/renderer/txnLink'

const t = (id: number, date: string, cents: number, kind: string, category: string | null = 'Fees', accountId = 1): PairTxn => ({ id, date, amountCents: cents, kind, category, accountId })

describe('pairReversals', () => {
  it('pairs a charge with a rebate of the same amount, account and category within a week', () => {
    const pairs = pairReversals([t(1, '2026-09-01', -1495, 'expense'), t(2, '2026-09-01', 1495, 'refund')])
    expect([...pairs]).toEqual([[1, 2]])
  })

  it('does not pair different amounts, accounts, categories or a rebate that is too late', () => {
    expect(pairReversals([t(1, '2026-09-01', -1495, 'expense'), t(2, '2026-09-01', 1400, 'refund')]).size).toBe(0)
    expect(pairReversals([t(1, '2026-09-01', -1495, 'expense'), t(2, '2026-09-01', 1495, 'refund', 'Fees', 2)]).size).toBe(0)
    expect(pairReversals([t(1, '2026-09-01', -1495, 'expense'), t(2, '2026-09-01', 1495, 'refund', 'Shopping')]).size).toBe(0)
    expect(pairReversals([t(1, '2026-09-01', -1495, 'expense'), t(2, '2026-09-20', 1495, 'refund')]).size).toBe(0)
  })

  it('uses each rebate once and picks the closest one', () => {
    const pairs = pairReversals([t(1, '2026-09-01', -500, 'expense'), t(2, '2026-09-03', -500, 'expense'), t(3, '2026-09-03', 500, 'refund')])
    expect([...pairs]).toEqual([[2, 3]])
  })

  it('does not treat a deposit as a rebate (only refunds count)', () => {
    expect(pairReversals([t(1, '2026-09-01', -1495, 'expense'), t(2, '2026-09-01', 1495, 'income')]).size).toBe(0)
  })
})

describe('refunded charges in the database', () => {
  let db: Db
  let p: number, chq: number, fees: number, shop: number
  let n = 0
  const TODAY = '2026-10-04'
  const add = (date: string, cents: number, text: string, kind: string, category: number) =>
    db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,?,'import',?)").run(p, chq, date, cents, text, text, kind, category, `x${n++}`)
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']

  beforeEach(() => {
    db = openDb(':memory:')
    ;[p] = createSetup(db, 'single', [{ name: 'T', accounts: [{ name: 'Chequing', type: 'chequing' }] }]) as [number]
    chq = (db.prepare("SELECT id FROM account WHERE name = 'Chequing'").get() as { id: number }).id
    const cat = (name: string) => Number(db.prepare("INSERT INTO category (profile_id, name, kind) VALUES (?,?, 'expense')").run(p, name).lastInsertRowid)
    fees = cat('Bank Fees & Interest')
    shop = cat('Test Shopping')
    for (const m of months) { add(`${m}-01`, -1495, 'MONTHLY ACCOUNT FEE', 'expense', fees); add(`${m}-01`, 1495, 'MONTHLY ACCOUNT FEE REBATE', 'refund', fees) }
  })

  it('is not suggested as a bill, but is offered as a refunded charge', () => {
    expect(suggestRecurring(db, p, TODAY)).toEqual([])
    const r = refundedCharges(db, p, TODAY)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ name: 'Monthly Account Fee', frequency: 'monthly', amountCents: 1495, occurrences: 5 })
  })

  it('a charge that is never refunded is still suggested', () => {
    for (const m of months) add(`${m}-09`, -1649, 'NETFLIX.COM', 'expense', shop)
    expect(suggestRecurring(db, p, TODAY).map((s) => s.name)).toEqual(['Netflix.com'])
    expect(refundedCharges(db, p, TODAY).map((s) => s.name)).toEqual(['Monthly Account Fee'])
  })

  it('tracking it anyway makes a normal bill; otherwise a tracked fee costs nothing', () => {
    // tracked by hand: net cost zero, flagged refunded
    db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, status, source) VALUES (?, 'Monthly Account Fee', 'expense', ?, 1495, 'monthly', 'active', 'manual')").run(p, chq)
    let [row] = listRecurring(db, p, TODAY)
    expect(row).toMatchObject({ refunded: true, monthlyCents: 0, annualCents: 0 })
    expect(refundedCharges(db, p, TODAY)).toEqual([]) // already tracked

    db.prepare('DELETE FROM recurring').run()
    const [id] = addDetected(db, p, [{ key: 'MONTHLY ACCOUNT FEE', direction: 'expense', keepRefunded: true }], TODAY)
    ;[row] = listRecurring(db, p, TODAY)
    expect(row).toMatchObject({ id, refunded: false, monthlyCents: 1495 })
  })

  it('can be hidden', () => {
    dismissSuggestion(db, p, 'MONTHLY ACCOUNT FEE', 'expense')
    expect(refundedCharges(db, p, TODAY)).toEqual([])
  })

  it('a reversed charge is not one of the largest expenses, but real purchases are', () => {
    add('2026-09-10', -9000, 'BIG SHOP', 'expense', shop)
    const d = getDashboard(db, p, '2026-09', TODAY)!
    expect(d.largestExpenses.map((e) => e.description)).toEqual(['BIG SHOP'])
    expect(d.largestExpenses[0]).toMatchObject({ accountId: chq, date: '2026-09-10' })
    expect(d.summary.expenseCents).toBe(9000) // the fee and its rebate net to zero either way
  })
})

describe('budget drill-down', () => {
  it('lists the budget categories’ transactions one column per account, refunds as money back', () => {
    const db = openDb(':memory:')
    const [p] = createSetup(db, 'single', [{ name: 'T', accounts: [{ name: 'Chequing', type: 'chequing' }, { name: 'Card', type: 'credit_card' }] }]) as [number]
    const acct = (n: string) => (db.prepare('SELECT id FROM account WHERE name = ?').get(n) as { id: number }).id
    const food = Number(db.prepare("INSERT INTO category (profile_id, name, kind) VALUES (?, 'Food drill', 'expense')").run(p).lastInsertRowid)
    const other = Number(db.prepare("INSERT INTO category (profile_id, name, kind) VALUES (?, 'Other drill', 'expense')").run(p).lastInsertRowid)
    let n = 0
    const add = (a: string, date: string, cents: number, text: string, kind: string, cat: number) =>
      db.prepare("INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, kind, category_id, source, fingerprint) VALUES (?,?,?,?,?,?,?,'import',?)").run(p, acct(a), date, cents, text, kind, cat, `d${n++}`)
    add('Card', '2026-09-03', -4000, 'GROCER', 'expense', food)
    add('Card', '2026-09-20', 1000, 'GROCER RETURN', 'refund', food)
    add('Chequing', '2026-09-12', -2500, 'FARMERS MARKET', 'expense', food)
    add('Chequing', '2026-09-13', -7000, 'NOT IN BUDGET', 'expense', other)
    add('Chequing', '2026-10-01', -999, 'NEXT MONTH', 'expense', food)
    const b = createBudget(db, p, 'Food', 50000, [food])

    const d = budgetDrill(db, p, b, '2026-09')
    expect(d.totalCents).toBe(5500)
    expect(d.columns.map((c) => [c.account, c.totalCents])).toEqual([['Card', 3000], ['Chequing', 2500]])
    expect(d.columns[0]!.rows.map((r) => [r.description, r.cents])).toEqual([['GROCER RETURN', -1000], ['GROCER', 4000]])
    expect(() => budgetDrill(db, p, 9999, '2026-09')).toThrow(/no longer exists/)
    // the spend shown here is the spend the budget report counts
    expect(d.totalCents).toBe(5500)
  })
})

describe('opening a transaction', () => {
  it('asks for its account and the two weeks either side, with the row to highlight', () => {
    expect(txnPreset({ id: 7, accountId: 3, date: '2026-09-20' })).toEqual({ accountId: 3, from: '2026-09-06', to: '2026-10-04', txnId: 7 })
  })
})

describe('household budget drill-down', () => {
  it('shows every account that spent in the budget, with its owner, and the totals add up', () => {
    const db = openDb(':memory:')
    generateSample(db, 'couple_household')
    const budgets = listHouseholdBudgets(db)
    expect(budgets.length).toBeGreaterThan(0)
    const month = (db.prepare("SELECT substr(MAX(posted_date), 1, 7) m FROM txn").get() as { m: string }).m
    for (const b of budgets) {
      const d = householdBudgetDrill(db, b.id, month)
      expect(d.totalCents).toBe(d.columns.reduce((a, c) => a + c.totalCents, 0))
      for (const c of d.columns) expect(c.owner).toBeTruthy()
    }
    expect(() => householdBudgetDrill(db, 9999, month)).toThrow(/no longer exists/)
  })
})
